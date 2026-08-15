/** Executes sync plans and writes journal state only after S3/vault operations succeed. */

import { isVaultFile, isVaultFolder } from '../vault/entries';
import {
	ConflictMode,
	SyncAction,
	SyncError,
	SyncPlanItem,
	SyncResult,
	SyncStateRecord,
	VaultEntry,
	VaultFile,
	VaultLike,
} from '../types';
import { readVaultFile, toArrayBuffer } from '../utils/vaultFiles';
import { pathSegments } from '../utils/paths';
import { fingerprint } from '../utils/fingerprint';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';

// 4 hides S3 round-trip latency while staying within typical browser
// connection-pool limits (~6/host) and avoiding large-binary memory spikes.
const MAX_CONCURRENCY = 4;

// Tolerate transient failures but stop a credential-loss cascade from
// retrying every remaining item.
const MAX_ERRORS = 3;

export class SyncExecutor {
	constructor(
		private vault: VaultLike,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
	) {}

	async execute(plan: SyncPlanItem[]): Promise<SyncResult> {
		const result: SyncResult = {
			completedAt: 0,
			filesUploaded: 0,
			filesDownloaded: 0,
			filesDeleted: 0,
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
		result.completedAt = Date.now();
		return result;
	}

	private async executeItem(item: SyncPlanItem, result: SyncResult): Promise<void> {
		switch (item.action) {
			case 'adopt':
				await this.executeAdopt(item);
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
				break;
			case 'forget':
				await this.executeForget(item);
				break;
			case 'skip':
				break;
		}
	}

	/** Adopt records "both sides identical" — re-verify neither side moved since planning. */
	private async executeAdopt(item: SyncPlanItem): Promise<void> {
		const head = await this.s3Provider.headObject(item.path);
		if (!head) {
			throw new Error(`Remote file disappeared during adopt: ${item.path}`);
		}
		if (item.expectedRemoteEtag !== undefined && head.etag !== item.expectedRemoteEtag) {
			throw new Error(`Remote file ${item.path} changed since planning. Skipping adopt.`);
		}

		const localFile = await this.vault.getAbstractFileByPath(item.path);
		this.assertLocalUnchanged(item, 'adopt', localFile);
		if (!isVaultFile(localFile)) {
			throw new Error(`Local file disappeared during adopt: ${item.path}`);
		}

		const localContent = await readVaultFile(this.vault, localFile);
		const contentFingerprint = await fingerprint(localContent);

		const record: SyncStateRecord = {
			path: item.path,
			contentFingerprint,
			localMtime: localFile.stat.mtime,
			localSize: localFile.stat.size,
			remoteEtag: head.etag,
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/** Conditional headers guard create-only / update-only uploads. */
	private async executeUpload(item: SyncPlanItem): Promise<void> {
		const file = await this.vault.getAbstractFileByPath(item.path);
		if (!isVaultFile(file)) {
			throw new Error(`File not found for upload: ${item.path}`);
		}

		this.assertLocalUnchanged(item, 'upload', file);
		const localMtime = file.stat.mtime;
		const localSize = file.stat.size;
		const content = await readVaultFile(this.vault, file);
		const contentFingerprint = await fingerprint(content);
		const etag = await this.s3Provider.uploadFile(item.path, content, {
			ifMatch: item.expectRemoteAbsent ? undefined : item.expectedRemoteEtag,
			ifNoneMatch: item.expectRemoteAbsent ? '*' : undefined,
			metadata: {
				'obsidian-fingerprint': contentFingerprint,
			},
		});
		// Deliberately re-read: this proves the file did not change *during*
		// the upload, so the stale pre-upload entry would defeat the check.
		this.assertLocalUnchanged({
			...item,
			expectedLocalMtime: localMtime,
			expectedLocalSize: localSize,
		}, 'upload', await this.vault.getAbstractFileByPath(item.path));

		const record: SyncStateRecord = {
			path: item.path,
			contentFingerprint,
			localMtime,
			localSize,
			remoteEtag: etag,
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/** The sleep(0) lets Obsidian's file indexer observe the written file. */
	private async executeDownload(item: SyncPlanItem): Promise<void> {
		const downloaded = await this.s3Provider.downloadFileWithMetadata(item.path);
		if (!downloaded) {
			throw new Error(`Remote file disappeared during sync: ${item.path}`);
		}

		const existing = await this.vault.getAbstractFileByPath(item.path);
		this.assertLocalUnchanged(item, 'download', existing);
		await this.writeLocalFile(item.path, downloaded.content, existing);
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		// Re-read deliberately: the record must carry the mtime/size of the
		// file as it landed on disk, not as it looked before the write.
		const localFile = await this.vault.getAbstractFileByPath(item.path);
		if (!isVaultFile(localFile)) {
			throw new Error(`Downloaded file not found in vault: ${item.path}`);
		}

		const record: SyncStateRecord = {
			path: item.path,
			contentFingerprint: await fingerprint(downloaded.content),
			localMtime: localFile.stat.mtime,
			localSize: localFile.stat.size,
			remoteEtag: downloaded.etag,
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	private async executeDeleteLocal(item: SyncPlanItem): Promise<void> {
		const file = await this.vault.getAbstractFileByPath(item.path);
		if (isVaultFile(file)) {
			this.assertLocalUnchanged(item, 'delete', file);
			await this.vault.trashFile(file);
		}

		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/** Abort remote deletes when the planned ETag no longer matches. */
	private async executeDeleteRemote(item: SyncPlanItem): Promise<void> {
		await this.s3Provider.deleteFile(item.path, item.expectedRemoteEtag);
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/** Create conflict artifacts; the conflict record blocks sync until the user removes them. */
	private async executeConflict(item: SyncPlanItem): Promise<void> {
		const mode: ConflictMode = item.conflictMode ?? 'both';
		const segments = pathSegments(item.path);
		const fileName = segments[segments.length - 1] ?? item.path;
		const dir = segments.slice(0, -1).join('/');
		const localArtifactPath = dir ? `${dir}/LOCAL_${fileName}` : `LOCAL_${fileName}`;
		const remoteArtifactPath = dir ? `${dir}/REMOTE_${fileName}` : `REMOTE_${fileName}`;

		let originalFile: VaultFile | null = null;
		if (mode === 'both' || mode === 'local-only') {
			const file = await this.vault.getAbstractFileByPath(item.path);
			this.assertLocalUnchanged(item, 'conflict', file);
			if (!isVaultFile(file)) {
				throw new Error(`File not found for conflict: ${item.path}`);
			}
			originalFile = file;
		}

		if (mode === 'both' || mode === 'remote-only') {
			const downloaded = await this.s3Provider.downloadFileWithMetadata(item.path);
			if (downloaded) {
				await this.writeLocalFile(remoteArtifactPath, downloaded.content);
			}
		}

		// Persist the record before displacing the original: a crash after the
		// rename but before the record would leave artifacts the next sync
		// treats as ordinary files.
		await this.journal.setConflict({
			path: item.path,
			mode,
			localArtifactPath: originalFile ? localArtifactPath : undefined,
			remoteArtifactPath: (mode === 'both' || mode === 'remote-only') ? remoteArtifactPath : undefined,
		});

		if (originalFile) {
			await this.vault.rename(originalFile, localArtifactPath);
		}
	}

	private async executeForget(item: SyncPlanItem): Promise<void> {
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	private async writeLocalFile(
		path: string,
		content: Uint8Array,
		known?: VaultEntry | null,
	): Promise<void> {
		const existingFile = known !== undefined
			? known
			: await this.vault.getAbstractFileByPath(path);
		if (isVaultFile(existingFile)) {
			await this.vault.modifyBinary(existingFile, toArrayBuffer(content));
			return;
		}

		await this.ensureParentFolders(path);
		await this.vault.createBinary(path, toArrayBuffer(content));
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = await this.vault.getAbstractFileByPath(currentPath);
			if (existing) {
				if (!isVaultFolder(existing)) {
					throw new Error(`Parent path is not a folder: ${currentPath}`);
				}
				continue;
			}

			try {
				await this.vault.createFolder(currentPath);
			} catch (error) {
				if (isVaultFolder(await this.vault.getAbstractFileByPath(currentPath))) {
					continue;
				}
				throw error;
			}
		}
	}

	/**
	 * Takes the entry the caller already looked up. For hidden paths every
	 * lookup is a real adapter stat, so re-fetching here cost 2-3 duplicate
	 * round-trips per plan item.
	 */
	private assertLocalUnchanged(
		item: SyncPlanItem,
		operation: string,
		file: VaultEntry | null,
	): void {

		if (item.expectLocalAbsent) {
			if (isVaultFile(file)) {
				throw new Error(`Local file ${item.path} appeared since planning. Skipping ${operation}.`);
			}
			return;
		}

		if (item.expectedLocalMtime === undefined || item.expectedLocalSize === undefined) {
			return;
		}

		if (!isVaultFile(file)) {
			throw new Error(`Local file ${item.path} changed since planning. Skipping ${operation}.`);
		}

		if (file.stat.mtime !== item.expectedLocalMtime || file.stat.size !== item.expectedLocalSize) {
			throw new Error(`Local file ${item.path} changed since planning. Skipping ${operation}.`);
		}
	}

	private toSyncError(path: string, action: SyncAction, error: unknown): SyncError {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`[S3 Sync] ${action} failed for ${path}: ${message}`);
		return { path, action, message, recoverable: true };
	}
}
