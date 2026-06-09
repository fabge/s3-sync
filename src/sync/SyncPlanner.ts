/** Read-only sync planner. Hashes content only after mtime/size and ETag fast paths fail. */

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
import { matchesAnyGlob, getFilename, isPluginOwnPath } from '../utils/paths';
import { readVaultFile } from '../utils/vaultFiles';
import { fingerprint } from '../utils/fingerprint';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { S3Provider } from '../storage/S3Provider';
import { decide } from './SyncDecisionTable';

interface LocalSnapshot {
	file: TFile;
	mtime: number;
	size: number;
}

interface RemoteSnapshot {
	objectInfo: S3ObjectInfo;
	head?: S3HeadResult;
}

interface PathContext {
	path: string;
	local?: LocalSnapshot;
	remote?: RemoteSnapshot;
	baseline?: SyncStateRecord;
	conflict?: ConflictRecord;
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

	async buildPlan(): Promise<SyncPlanItem[]> {
		const contexts = await this.discoverState();
		const plan: SyncPlanItem[] = [];

		for (const ctx of contexts.values()) {
			const local = await this.classifyLocal(ctx);
			const remote = await this.classifyRemote(ctx);

			if (!ctx.baseline && local === 'L+' && remote === 'R+') {
				await this.computeLocalFingerprint(ctx);
				await this.ensureRemoteFingerprint(ctx);
			}

			const input: DecisionInput = {
				path: ctx.path,
				local,
				remote,
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
				this.attachLocalPreconditions(item, ctx);
				plan.push(item);
			}
		}

		return this.sortPlan(plan);
	}

	private async discoverState(): Promise<Map<string, PathContext>> {
		const contexts = new Map<string, PathContext>();
		const conflictArtifacts = new Map<string, string>();

		for (const conflict of await this.journal.getAllConflicts()) {
			if (this.shouldExclude(conflict.path)) continue;

			this.getOrCreate(contexts, conflict.path).conflict = conflict;
			if (conflict.localArtifactPath) {
				conflictArtifacts.set(conflict.localArtifactPath, conflict.path);
			}
			if (conflict.remoteArtifactPath) {
				conflictArtifacts.set(conflict.remoteArtifactPath, conflict.path);
			}
		}

		for (const file of this.app.vault.getFiles()) {
			const conflictPath = conflictArtifacts.get(file.path);
			if (conflictPath) {
				this.getOrCreate(contexts, conflictPath).hasConflictArtifacts = true;
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

		return contexts;
	}

	private async classifyLocal(ctx: PathContext): Promise<LocalClassification> {
		if (!ctx.local) return 'L0';
		if (!ctx.baseline) return 'L+';

		if (ctx.local.mtime === ctx.baseline.localMtime && ctx.local.size === ctx.baseline.localSize) {
			return 'L=';
		}

		const fp = await this.computeLocalFingerprint(ctx);
		return fp === ctx.baseline.contentFingerprint ? 'L=' : 'LΔ';
	}

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

	private async computeLocalFingerprint(ctx: PathContext): Promise<string> {
		if (ctx.localFingerprint) return ctx.localFingerprint;

		const file = ctx.local?.file;
		if (!file) throw new Error(`No local file for ${ctx.path}`);

		const content = await readVaultFile(this.app.vault, file);
		ctx.localFingerprint = await fingerprint(content);
		return ctx.localFingerprint;
	}

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

	private attachLocalPreconditions(item: SyncPlanItem, ctx: PathContext): void {
		if (!this.needsLocalPrecondition(item)) return;

		if (ctx.local) {
			item.expectedLocalMtime = ctx.local.mtime;
			item.expectedLocalSize = ctx.local.size;
		} else {
			item.expectLocalAbsent = true;
		}
	}

	private needsLocalPrecondition(item: SyncPlanItem): boolean {
		return item.action === 'download' || item.action === 'delete-local' || item.action === 'conflict';
	}

	private shouldExclude(path: string): boolean {
		if (isPluginOwnPath(path, this.app.vault.configDir)) return true;
		if (getFilename(path).startsWith('.obsidian-s3-sync')) return true;
		return matchesAnyGlob(path, this.settings.excludePatterns);
	}
}
