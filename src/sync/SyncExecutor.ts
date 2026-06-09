/** Executes sync plans and writes journal state only after S3/vault operations succeed. */

import { App, TFile, TFolder } from 'obsidian';
import {
	ConflictMode,
	SyncAction,
	SyncError,
	SyncPlanItem,
	SyncResult,
	SyncStateRecord,
} from '../types';
import { getVaultFileKind, readVaultFile, toArrayBuffer } from '../utils/vaultFiles';
import { fingerprint } from '../utils/fingerprint';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';

// 4 hides S3 round-trip latency while staying within typical browser
// connection-pool limits (~6/host) and avoiding large-binary memory spikes.
const MAX_CONCURRENCY = 4;

// Tolerate transient failures but stop a credential-loss cascade from
// retrying every remaining item.
const MAX_ERRORS = 3;

export class SyncExecutor {
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
	) {}

	async execute(plan: SyncPlanItem[]): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			startedAt: Date.now(),
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
		result.success = result.errors.length === 0;
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

	private async executeAdopt(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const head = await this.s3Provider.headObject(remoteKey);
		if (!head) {
			throw new Error(`Remote file disappeared during adopt: ${item.path}`);
		}

		const localFile = this.app.vault.getAbstractFileByPath(item.path);
		if (!(localFile instanceof TFile)) {
			throw new Error(`Local file disappeared during adopt: ${item.path}`);
		}

		const localContent = await readVaultFile(this.app.vault, localFile);
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
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found for upload: ${item.path}`);
		}

		const content = await readVaultFile(this.app.vault, file);
		const contentFingerprint = await fingerprint(content);
		const payload = typeof content === 'string' ? new TextEncoder().encode(content) : content;
		const remoteKey = this.pathCodec.localToRemote(item.path);

		const etag = await this.s3Provider.uploadFile(remoteKey, payload, {
			contentType: this.guessContentType(item.path),
			ifMatch: item.expectRemoteAbsent ? undefined : item.expectedRemoteEtag,
			ifNoneMatch: item.expectRemoteAbsent ? '*' : undefined,
			metadata: {
				'obsidian-fingerprint': contentFingerprint,
			},
		});

		const record: SyncStateRecord = {
			path: item.path,
			contentFingerprint,
			localMtime: file.stat.mtime,
			localSize: file.stat.size,
			remoteEtag: etag,
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/** The sleep(0) lets Obsidian's file indexer observe the written file. */
	private async executeDownload(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
		if (!downloaded) {
			throw new Error(`Remote file disappeared during sync: ${item.path}`);
		}

		const kind = getVaultFileKind(item.path);
		const content = kind === 'text' ? new TextDecoder().decode(downloaded.content) : downloaded.content;

		this.assertLocalUnchanged(item, 'download');
		await this.writeLocalFile(item.path, content);
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		const localFile = this.app.vault.getAbstractFileByPath(item.path);
		if (!(localFile instanceof TFile)) {
			throw new Error(`Downloaded file not found in vault: ${item.path}`);
		}

		const record: SyncStateRecord = {
			path: item.path,
			contentFingerprint: await fingerprint(content),
			localMtime: localFile.stat.mtime,
			localSize: localFile.stat.size,
			remoteEtag: downloaded.etag,
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	private async executeDeleteLocal(item: SyncPlanItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (file instanceof TFile) {
			this.assertLocalUnchanged(item, 'delete');
			await this.app.fileManager.trashFile(file);
		}

		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/** Abort remote deletes when the planned ETag no longer matches. */
	private async executeDeleteRemote(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);

		await this.s3Provider.deleteFile(remoteKey, item.expectedRemoteEtag);
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/** Create conflict artifacts; the conflict record blocks sync until the user removes them. */
	private async executeConflict(item: SyncPlanItem): Promise<void> {
		const mode: ConflictMode = item.conflictMode ?? 'both';
		const fileName = item.path.substring(item.path.lastIndexOf('/') + 1);
		const dir = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
		const localArtifactPath = dir ? `${dir}/LOCAL_${fileName}` : `LOCAL_${fileName}`;
		const remoteArtifactPath = dir ? `${dir}/REMOTE_${fileName}` : `REMOTE_${fileName}`;

		if (mode === 'both' || mode === 'local-only') {
			this.assertLocalUnchanged(item, 'conflict');
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (!(file instanceof TFile)) {
				throw new Error(`File not found for conflict: ${item.path}`);
			}
			await this.app.vault.rename(file, localArtifactPath);
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

		await this.journal.setConflict({
			path: item.path,
			mode,
			localArtifactPath: (mode === 'both' || mode === 'local-only') ? localArtifactPath : undefined,
			remoteArtifactPath: (mode === 'both' || mode === 'remote-only') ? remoteArtifactPath : undefined,
		});
	}

	private async executeForget(item: SyncPlanItem): Promise<void> {
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

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

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (existing) {
				if (!(existing instanceof TFolder)) {
					throw new Error(`Parent path is not a folder: ${currentPath}`);
				}
				continue;
			}

			try {
				await this.app.vault.createFolder(currentPath);
			} catch (error) {
				if (this.app.vault.getAbstractFileByPath(currentPath) instanceof TFolder) {
					continue;
				}
				throw error;
			}
		}
	}

	private guessContentType(path: string): string {
		return getVaultFileKind(path) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
	}

	private assertLocalUnchanged(item: SyncPlanItem, operation: string): void {
		const file = this.app.vault.getAbstractFileByPath(item.path);

		if (item.expectLocalAbsent) {
			if (file instanceof TFile) {
				throw new Error(`Local file ${item.path} appeared since planning. Skipping ${operation}.`);
			}
			return;
		}

		if (item.expectedLocalMtime === undefined || item.expectedLocalSize === undefined) {
			return;
		}

		if (!(file instanceof TFile)) {
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
