/**
 * Executes a {@link SyncPlanItem} list with bounded concurrency.
 *
 * Every state-mutating action writes its new {@link SyncStateRecord} to the
 * journal **after** the S3/vault operation succeeds, so a crash leaves a stale
 * baseline (re-synced next run) rather than a phantom one. Fail-fast: after
 * {@link MAX_ERRORS} item failures no new work is dispatched, but in-flight
 * items finish.
 */

import { App, TFile } from 'obsidian';
import {
	ConflictMode,
	SyncAction,
	SyncError,
	SyncPlanItem,
	SyncResult,
	SyncStateRecord,
	SyncUploadMetadata,
} from '../types';
import { getVaultFileKind, readVaultFile, toArrayBuffer } from '../utils/vaultFiles';
import { fingerprint } from '../utils/fingerprint';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { encodeMetadata } from './SyncObjectMetadata';

// 4 hides S3 round-trip latency while staying within typical browser
// connection-pool limits (~6/host) and avoiding large-binary memory spikes.
const MAX_CONCURRENCY = 4;

// Tolerate transient failures but stop a credential-loss cascade from
// retrying every remaining item.
const MAX_ERRORS = 3;

export class SyncExecutor {
	private deviceId: string;

	/** @param deviceId - written to S3 metadata as `obsidian-device-id`. */
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		deviceId: string,
	) {
		this.deviceId = deviceId;
	}

	/**
	 * Execute all items with bounded concurrency: the inner loop greedily fills
	 * up to {@link MAX_CONCURRENCY} slots, the outer loop awaits the fastest via
	 * `Promise.race` and tops up — starting new items as a slot opens rather than
	 * waiting for a whole batch.
	 */
	async execute(plan: SyncPlanItem[]): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			startedAt: Date.now(),
			completedAt: 0,
			filesUploaded: 0,
			filesDownloaded: 0,
			filesDeleted: 0,
			filesAdopted: 0,
			filesForgotten: 0,
			conflicts: [],
			errors: [],
		};

		let errorCount = 0;
		let planIndex = 0;
		const inFlight = new Set<Promise<void>>();

		while (planIndex < plan.length || inFlight.size > 0) {
			while (
				inFlight.size < MAX_CONCURRENCY &&
				planIndex < plan.length &&
				errorCount < MAX_ERRORS
			) {
				const item = plan[planIndex]!;
				planIndex++;

				const promise = this.executeItem(item, result)
					.catch((error: unknown) => {
						errorCount++;
						result.errors.push(this.toSyncError(item.path, item.action, error));
					})
					.finally(() => {
						inFlight.delete(promise);
					});

				inFlight.add(promise);
			}

			if (inFlight.size > 0) {
				await Promise.race(inFlight);
			} else {
				// Inner loop blocked by the error threshold and nothing in flight — done.
				break;
			}
		}

		result.conflicts = (await this.journal.getAllConflicts()).map((c) => c.path);
		result.success = result.errors.length === 0;
		result.completedAt = Date.now();
		return result;
	}

	/** Dispatch one item to its handler and increment the matching result counter. */
	private async executeItem(item: SyncPlanItem, result: SyncResult): Promise<void> {
		switch (item.action) {
			case 'adopt':
				await this.executeAdopt(item);
				result.filesAdopted++;
				break;
			case 'upload':
				await this.executeUpload(item);
				result.filesUploaded++;
				break;
			case 'download':
				await this.executeDownload(item);
				result.filesDownloaded++;
				break;
			case 'delete-local':
				await this.executeDeleteLocal(item);
				result.filesDeleted++;
				break;
			case 'delete-remote':
				await this.executeDeleteRemote(item);
				result.filesDeleted++;
				break;
			case 'conflict':
				await this.executeConflict(item);
				result.conflicts.push(item.path);
				break;
			case 'forget':
				await this.executeForget(item);
				result.filesForgotten++;
				break;
			case 'skip':
				break;
		}
	}

	/** Adopt the remote object as baseline without transferring content (fingerprints already match). */
	private async executeAdopt(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const head = await this.s3Provider.headObject(remoteKey);
		const localFile = this.app.vault.getAbstractFileByPath(item.path);

		const localContent = localFile instanceof TFile
			? await readVaultFile(this.app.vault, localFile)
			: null;
		const contentFingerprint = localContent
			? await fingerprint(localContent)
			: head?.fingerprint ?? '';

		const record: SyncStateRecord = {
			path: item.path,
			remoteKey,
			contentFingerprint,
			localMtime: localFile instanceof TFile ? localFile.stat.mtime : 0,
			localSize: localFile instanceof TFile ? localFile.stat.size : 0,
			remoteClientMtime: head?.clientMtime ?? null,
			remoteObjectSize: head?.size ?? 0,
			remoteEtag: head?.etag,
			remoteLastModified: head?.lastModified ?? null,
			lastWriterDeviceId: head?.deviceId,
			lastSyncedAt: Date.now(),
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Upload the local file and persist the resulting ETag as the new baseline.
	 * Conditional headers guard concurrency: `expectRemoteAbsent` → create-only,
	 * `expectedRemoteEtag` → update-only.
	 */
	private async executeUpload(item: SyncPlanItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found for upload: ${item.path}`);
		}

		const content = await readVaultFile(this.app.vault, file);
		const contentFingerprint = await fingerprint(content);
		const payload = typeof content === 'string' ? new TextEncoder().encode(content) : content;
		const remoteKey = this.pathCodec.localToRemote(item.path);

		const uploadMeta: SyncUploadMetadata = {
			fingerprint: contentFingerprint,
			clientMtime: file.stat.mtime,
			deviceId: this.deviceId,
		};

		const etag = await this.s3Provider.uploadFile(remoteKey, payload, {
			contentType: this.guessContentType(item.path),
			ifMatch: item.expectRemoteAbsent ? undefined : item.expectedRemoteEtag,
			ifNoneMatch: item.expectRemoteAbsent ? '*' : undefined,
			metadata: encodeMetadata(uploadMeta),
		});

		const record: SyncStateRecord = {
			path: item.path,
			remoteKey,
			contentFingerprint,
			localMtime: file.stat.mtime,
			localSize: file.stat.size,
			remoteClientMtime: file.stat.mtime,
			remoteObjectSize: payload.length,
			remoteEtag: etag,
			remoteLastModified: null,
			lastWriterDeviceId: this.deviceId,
			lastSyncedAt: Date.now(),
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Download a remote object and write it to the vault.
	 *
	 * The `sleep(0)` yield after the write lets Obsidian's file-indexer register
	 * the new file before we look it up — without it `getAbstractFileByPath` can
	 * return null and throw a false "not found".
	 */
	private async executeDownload(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
		if (!downloaded) {
			throw new Error(`Remote file disappeared during sync: ${item.path}`);
		}

		const kind = getVaultFileKind(item.path);
		const content = kind === 'text' ? new TextDecoder().decode(downloaded.content) : downloaded.content;

		await this.writeLocalFile(item.path, content);
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		const localFile = this.app.vault.getAbstractFileByPath(item.path);
		if (!(localFile instanceof TFile)) {
			throw new Error(`Downloaded file not found in vault: ${item.path}`);
		}

		const record: SyncStateRecord = {
			path: item.path,
			remoteKey,
			contentFingerprint: await fingerprint(content),
			localMtime: localFile.stat.mtime,
			localSize: localFile.stat.size,
			remoteClientMtime: downloaded.clientMtime ?? null,
			remoteObjectSize: downloaded.size,
			remoteEtag: downloaded.etag,
			remoteLastModified: downloaded.lastModified,
			lastWriterDeviceId: downloaded.deviceId,
			lastSyncedAt: Date.now(),
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/** Trash the local file (respecting the user's Obsidian trash preference) and drop its baseline. */
	private async executeDeleteLocal(item: SyncPlanItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}

		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Delete the remote object and drop its baseline. When `expectedRemoteEtag`
	 * is set, abort if the remote ETag changed since planning (another device
	 * updated it).
	 */
	private async executeDeleteRemote(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);

		if (item.expectedRemoteEtag) {
			const head = await this.s3Provider.headObject(remoteKey);
			if (head && head.etag !== item.expectedRemoteEtag) {
				throw new Error(
					`Remote file ${item.path} changed since planning (expected ETag ${item.expectedRemoteEtag}, got ${head.etag}). Skipping delete.`,
				);
			}
		}

		await this.s3Provider.deleteFile(remoteKey);
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Create conflict artifacts and record the conflict.
	 * - `both`        — rename local → `LOCAL_*`, download remote → `REMOTE_*`
	 * - `local-only`  — rename local → `LOCAL_*` (remote absent)
	 * - `remote-only` — download remote → `REMOTE_*` (local absent)
	 *
	 * The baseline fingerprint is kept so later planner runs detect resolution
	 * (artifacts gone).
	 */
	private async executeConflict(item: SyncPlanItem): Promise<void> {
		const mode: ConflictMode = item.conflictMode ?? 'both';
		const fileName = item.path.substring(item.path.lastIndexOf('/') + 1);
		const dir = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
		const localArtifactPath = dir ? `${dir}/LOCAL_${fileName}` : `LOCAL_${fileName}`;
		const remoteArtifactPath = dir ? `${dir}/REMOTE_${fileName}` : `REMOTE_${fileName}`;

		if (mode === 'both' || mode === 'local-only') {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (file instanceof TFile) {
				await this.app.vault.rename(file, localArtifactPath);
			}
		}

		if (mode === 'both' || mode === 'remote-only') {
			const remoteKey = this.pathCodec.localToRemote(item.path);
			const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
			if (downloaded) {
				const kind = getVaultFileKind(item.path);
				await this.writeLocalFile(
					remoteArtifactPath,
					kind === 'text' ? new TextDecoder().decode(downloaded.content) : downloaded.content,
				);
			}
		}

		const baseline = await this.journal.getStateRecord(item.path);

		await this.journal.setConflict({
			path: item.path,
			mode,
			localArtifactPath: (mode === 'both' || mode === 'local-only') ? localArtifactPath : undefined,
			remoteArtifactPath: (mode === 'both' || mode === 'remote-only') ? remoteArtifactPath : undefined,
			baselineFingerprint: baseline?.contentFingerprint,
			detectedAt: Date.now(),
		});
	}

	/** Drop a stale baseline for a path deleted on both sides; no file/S3 I/O needed. */
	private async executeForget(item: SyncPlanItem): Promise<void> {
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/** Write `content` to the vault, updating in place or creating with parent folders. */
	private async writeLocalFile(path: string, content: string | Uint8Array): Promise<void> {
		const existingFile = this.app.vault.getAbstractFileByPath(path);
		if (existingFile instanceof TFile) {
			if (typeof content === 'string') {
				await this.app.vault.modify(existingFile, content);
			} else {
				await this.app.vault.modifyBinary(existingFile, toArrayBuffer(content));
			}
			return;
		}

		await this.ensureParentFolders(path);
		if (typeof content === 'string') {
			await this.app.vault.create(path, content);
		} else {
			await this.app.vault.createBinary(path, toArrayBuffer(content));
		}
	}

	/** Create every missing ancestor folder top-down — `createFolder` needs its parent to exist. */
	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(currentPath)) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private guessContentType(path: string): string {
		return getVaultFileKind(path) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
	}

	private toSyncError(path: string, action: SyncAction, error: unknown): SyncError {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`[S3 Sync] ${action} failed for ${path}: ${message}`);
		return { path, action, message, recoverable: true };
	}
}
