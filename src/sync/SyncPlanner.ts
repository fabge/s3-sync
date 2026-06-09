/**
 * Discovers local + remote state, classifies each path, and feeds {@link decide}
 * to produce an ordered {@link SyncPlanItem} list. Side-effect free — reads from
 * vault, S3, and journal but never writes (all mutation is in SyncExecutor).
 *
 * Lazy hashing: mtime+size and ETag fast-paths are tried first; SHA-256
 * fingerprints are only computed when those are ambiguous.
 */

import { App, TFile } from 'obsidian';
import {
	ConflictRecord,
	DecisionInput,
	LocalClassification,
	RemoteClassification,
	S3HeadResult,
	S3ObjectInfo,
	S3SyncSettings,
	SyncPlanItem,
	SyncStateRecord,
} from '../types';
import { normalizeEntityTag } from '../utils/etags';
import { isConflictFile, matchesAnyGlob, getFilename, isPluginOwnPath } from '../utils/paths';
import { readVaultFile } from '../utils/vaultFiles';
import { fingerprint } from '../utils/fingerprint';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { S3Provider } from '../storage/S3Provider';
import { decide } from './SyncDecisionTable';

/** Local file snapshot captured during discovery; holds the TFile to avoid a second lookup. */
interface LocalSnapshot {
	file: TFile;
	mtime: number;
	size: number;
}

/** Remote object snapshot; `head` is fetched lazily only when the ETag fast-path is insufficient. */
interface RemoteSnapshot {
	objectInfo: S3ObjectInfo;
	head?: S3HeadResult;
}

/**
 * All known state for one path. `undefined` fields mean absence: no `local` →
 * not on disk; no `baseline` → never synced. Fingerprints are populated lazily.
 */
interface PathContext {
	path: string;
	local?: LocalSnapshot;
	remote?: RemoteSnapshot;
	baseline?: SyncStateRecord;
	conflict?: ConflictRecord;
	/** `true` when a `LOCAL_`/`REMOTE_` artifact for this path exists on disk. */
	hasConflictArtifacts: boolean;
	localFingerprint?: string;
	remoteFingerprint?: string;
}

export class SyncPlanner {
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private settings: S3SyncSettings,
	) {}

	async countInScopeLocalFiles(): Promise<number> {
		let count = 0;
		for (const file of this.app.vault.getFiles()) {
			if (!this.shouldExclude(file.path)) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Discover full state, classify every path, and return an ordered action
	 * list. `skip` items are dropped; the rest are sorted by {@link sortPlan}.
	 */
	async buildPlan(): Promise<SyncPlanItem[]> {
		const contexts = await this.discoverState();
		const plan: SyncPlanItem[] = [];

		for (const ctx of contexts.values()) {
			const input: DecisionInput = {
				path: ctx.path,
				local: await this.classifyLocal(ctx),
				remote: await this.classifyRemote(ctx),
				hasUnresolvedConflict: ctx.conflict !== undefined,
				hasConflictArtifacts: ctx.hasConflictArtifacts,
				localExists: ctx.local !== undefined,
				remoteExists: ctx.remote !== undefined,
				hasBaseline: ctx.baseline !== undefined,
				localFingerprint: ctx.localFingerprint,
				remoteFingerprint: ctx.remoteFingerprint,
			};

			const item = decide(input);

			if (item.action !== 'skip') {
				if (ctx.remote?.objectInfo.etag) {
					item.expectedRemoteEtag = normalizeEntityTag(ctx.remote.objectInfo.etag);
				}
				if (!ctx.remote) {
					item.expectRemoteAbsent = true;
				}
				plan.push(item);
			}
		}

		return this.sortPlan(plan);
	}

	/**
	 * Aggregate local files, remote objects, journal baselines, and conflict
	 * records into one {@link PathContext} per path. Conflict artifacts
	 * (`LOCAL_`/`REMOTE_`) are not sync targets but flag their original path.
	 */
	private async discoverState(): Promise<Map<string, PathContext>> {
		const contexts = new Map<string, PathContext>();
		const conflictOriginalPaths = new Set<string>();

		for (const file of this.app.vault.getFiles()) {
			if (isConflictFile(file.path)) {
				const original = this.getOriginalFromConflictFilename(file.path);
				if (original) {
					conflictOriginalPaths.add(original);
				}
				continue;
			}

			if (this.shouldExclude(file.path)) continue;

			const ctx = this.getOrCreate(contexts, file.path);
			ctx.local = { file, mtime: file.stat.mtime, size: file.stat.size };
		}

		const remoteObjects = await this.s3Provider.listObjects(this.pathCodec.getListPrefix());
		for (const obj of remoteObjects) {
			if (this.pathCodec.isMetadataKey(obj.key)) continue;

			const localPath = this.pathCodec.remoteToLocal(obj.key);
			if (!localPath || this.shouldExclude(localPath)) continue;

			const ctx = this.getOrCreate(contexts, localPath);
			ctx.remote = { objectInfo: { ...obj, etag: normalizeEntityTag(obj.etag) } };
		}

		for (const baseline of await this.journal.getAllStateRecords()) {
			if (this.shouldExclude(baseline.path)) continue;
			this.getOrCreate(contexts, baseline.path).baseline = baseline;
		}

		for (const conflict of await this.journal.getAllConflicts()) {
			if (this.shouldExclude(conflict.path)) continue;
			this.getOrCreate(contexts, conflict.path).conflict = conflict;
		}

		for (const path of conflictOriginalPaths) {
			this.getOrCreate(contexts, path).hasConflictArtifacts = true;
		}

		return contexts;
	}

	/**
	 * Classify the local side: L0 absent, L+ new (no baseline), L= unchanged
	 * (mtime+size match, or fingerprint matches despite an mtime-only touch),
	 * LΔ modified.
	 */
	private async classifyLocal(ctx: PathContext): Promise<LocalClassification> {
		if (!ctx.local) return 'L0';
		if (!ctx.baseline) return 'L+';

		if (ctx.local.mtime === ctx.baseline.localMtime && ctx.local.size === ctx.baseline.localSize) {
			return 'L=';
		}

		const fp = await this.computeLocalFingerprint(ctx);
		return fp === ctx.baseline.contentFingerprint ? 'L=' : 'LΔ';
	}

	/**
	 * Classify the remote side: R0 absent, R+ new (no baseline), R= matching
	 * ETag (fast-path) or fingerprint, RΔ modified. ETags are cheap revision
	 * tokens only; SHA-256 of content is the authoritative identity.
	 */
	private async classifyRemote(ctx: PathContext): Promise<RemoteClassification> {
		if (!ctx.remote) return 'R0';
		if (!ctx.baseline) return 'R+';

		const remoteEtag = ctx.remote.objectInfo.etag;
		if (remoteEtag && ctx.baseline.remoteEtag && remoteEtag === ctx.baseline.remoteEtag) {
			return 'R=';
		}

		await this.ensureRemoteFingerprint(ctx);
		return ctx.remoteFingerprint === ctx.baseline.contentFingerprint ? 'R=' : 'RΔ';
	}

	/** Compute and memoize the local file's content fingerprint. */
	private async computeLocalFingerprint(ctx: PathContext): Promise<string> {
		if (ctx.localFingerprint) return ctx.localFingerprint;

		const file = ctx.local?.file;
		if (!file) throw new Error(`No local file for ${ctx.path}`);

		const content = await readVaultFile(this.app.vault, file);
		ctx.localFingerprint = await fingerprint(content);
		return ctx.localFingerprint;
	}

	/**
	 * Populate `ctx.remoteFingerprint` with the fewest S3 calls: HeadObject
	 * metadata if present, else a full download as a last resort (older objects
	 * lacking the fingerprint header).
	 */
	private async ensureRemoteFingerprint(ctx: PathContext): Promise<void> {
		if (ctx.remoteFingerprint) return;
		if (!ctx.remote) return;

		const remoteKey = this.pathCodec.localToRemote(ctx.path);

		if (!ctx.remote.head) {
			ctx.remote.head = (await this.s3Provider.headObject(remoteKey)) ?? undefined;
		}

		if (ctx.remote.head?.fingerprint) {
			ctx.remoteFingerprint = ctx.remote.head.fingerprint;
			return;
		}

		const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
		if (!downloaded) return;
		ctx.remoteFingerprint = await fingerprint(downloaded.content);
	}

	/**
	 * Order the plan so dependencies are respected: journal-only updates
	 * (adopt/forget) first, deletions before transfers, conflicts last so
	 * artifact creation can't shadow a clean download/upload. Lexicographic
	 * within a tier for determinism.
	 */
	private sortPlan(plan: SyncPlanItem[]): SyncPlanItem[] {
		const order: Record<string, number> = {
			'adopt': 0,
			'forget': 1,
			'delete-local': 2,
			'delete-remote': 3,
			'download': 4,
			'upload': 5,
			'conflict': 6,
			'skip': 7,
		};

		return plan.sort((a, b) => {
			const ao = order[a.action] ?? 99;
			const bo = order[b.action] ?? 99;
			if (ao !== bo) return ao - bo;
			return a.path.localeCompare(b.path);
		});
	}

	private getOrCreate(map: Map<string, PathContext>, path: string): PathContext {
		const existing = map.get(path);
		if (existing) return existing;

		const created: PathContext = { path, hasConflictArtifacts: false };
		map.set(path, created);
		return created;
	}

	/** Recover the original path from a `LOCAL_`/`REMOTE_` artifact filename, or `null`. */
	private getOriginalFromConflictFilename(conflictPath: string): string | null {
		const filename = getFilename(conflictPath);
		const dir = conflictPath.includes('/')
			? conflictPath.substring(0, conflictPath.lastIndexOf('/'))
			: '';

		let originalName: string;
		if (filename.startsWith('LOCAL_')) {
			originalName = filename.substring(6);
		} else if (filename.startsWith('REMOTE_')) {
			originalName = filename.substring(7);
		} else {
			return null;
		}

		return dir ? `${dir}/${originalName}` : originalName;
	}

	/**
	 * Exclude conflict artifacts, the plugin's own settings directory (holds
	 * credentials), internal `.obsidian-s3-sync*` files, and user glob patterns.
	 */
	private shouldExclude(path: string): boolean {
		if (isConflictFile(path)) return true;
		if (isPluginOwnPath(path, this.app.vault.configDir)) return true;
		if (getFilename(path).startsWith('.obsidian-s3-sync')) return true;
		return matchesAnyGlob(path, this.settings.excludePatterns);
	}
}
