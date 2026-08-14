/** Thin sync-cycle orchestrator; planner/executor do the heavy lifting. */

import { cloneSettings, S3SyncSettings, SyncPlanItem, SyncResult, VaultLike } from '../types';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPlanner } from './SyncPlanner';
import { SyncExecutor } from './SyncExecutor';
import { computeDestinationFingerprint } from './DestinationFingerprint';

const DESTINATION_FINGERPRINT_KEY = 'destinationFingerprint';
const LAST_SUCCESSFUL_SYNC_KEY = 'lastSuccessfulSyncAt';

async function withJournalContext<T>(phase: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed ${phase}: ${cause}`);
	}
}

export class SyncEngine {
	private isSyncing = false;
	private settings: S3SyncSettings;

	constructor(
		private vault: VaultLike,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		settings: S3SyncSettings,
	) {
		this.settings = cloneSettings(settings);
	}

	updateSettings(settings: S3SyncSettings): void {
		if (this.isSyncing) {
			throw new Error('Cannot update sync settings while a sync is in progress.');
		}
		this.settings = cloneSettings(settings);
	}

	isInProgress(): boolean {
		return this.isSyncing;
	}

	async sync(): Promise<SyncResult> {
		if (this.isSyncing) {
			throw new Error('Sync already in progress');
		}

		this.isSyncing = true;
		const startedAt = Date.now();

		try {
			const startFingerprint = computeDestinationFingerprint(this.settings);
			const storedDestinationFingerprint = await this.getStoredDestinationFingerprint();
			const destinationGuardResult = this.checkDestinationFingerprint(
				storedDestinationFingerprint,
				startFingerprint,
			);
			if (destinationGuardResult) {
				return destinationGuardResult;
			}

			const planner = new SyncPlanner(
				this.vault,
				this.s3Provider,
				this.journal,
				this.settings,
			);
			const { items: plan, syncedFileCount, changedSyncedFileCount } = await planner.buildPlan();
			if (storedDestinationFingerprint === undefined) {
				await withJournalContext(
					'recording destination fingerprint',
					() => this.journal.setMetadata(DESTINATION_FINGERPRINT_KEY, startFingerprint),
				);
			}
			const destructivePlanError = await this.checkDestructivePlan(plan);
			if (destructivePlanError) {
				return this.buildBlockedResult(destructivePlanError, 'delete-local');
			}
			const protectError = this.checkProtectModifyThreshold(syncedFileCount, changedSyncedFileCount);
			if (protectError) {
				return this.buildBlockedResult(protectError);
			}

			const executor = new SyncExecutor(
				this.vault,
				this.s3Provider,
				this.journal,
			);
			const result = await executor.execute(plan);

			if (result.success) {
				await this.journal.setMetadata(LAST_SUCCESSFUL_SYNC_KEY, Date.now());
			}

			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			console.error(`[S3 Sync] Sync failed: ${message}`);

			return {
				success: false,
				startedAt,
				completedAt: Date.now(),
				filesUploaded: 0,
				filesDownloaded: 0,
				filesDeleted: 0,
				conflicts: [],
				errors: [{ path: '', action: 'skip', message, recoverable: false }],
			};
		} finally {
			this.isSyncing = false;
		}
	}

	async resetJournalForCurrentDestination(): Promise<void> {
		if (this.isSyncing) {
			throw new Error('Cannot reset the sync journal while a sync is in progress.');
		}

		// Hold the busy flag so a scheduled sync cannot start mid-reset.
		this.isSyncing = true;
		try {
			const fingerprint = computeDestinationFingerprint(this.settings);
			await withJournalContext(
				'resetting sync journal for the current destination',
				() => this.journal.resetForDestination(fingerprint),
			);
		} finally {
			this.isSyncing = false;
		}
	}

	private checkProtectModifyThreshold(
		syncedFileCount: number,
		changedSyncedFileCount: number,
	): string | null {
		const threshold = this.settings.protectModifyPercentage;
		if (threshold >= 100 || syncedFileCount <= 0) {
			return null;
		}

		const changedPercentage = (changedSyncedFileCount / syncedFileCount) * 100;
		if (changedPercentage <= threshold) {
			return null;
		}

		return `Aborting sync: ${changedSyncedFileCount} of ${syncedFileCount} synced files would change (${changedPercentage.toFixed(1)}%), exceeding the ${threshold}% protection threshold.`;
	}

	/** Stale-journal / wrong-bucket protection. First successful listing records the destination. */
	private async getStoredDestinationFingerprint(): Promise<string | number | boolean | undefined> {
		return await withJournalContext(
			'reading stored destination fingerprint',
			() => this.journal.getMetadata(DESTINATION_FINGERPRINT_KEY),
		);
	}

	private checkDestinationFingerprint(
		stored: string | number | boolean | undefined,
		current: string,
	): SyncResult | null {
		if (stored === undefined || stored === current) {
			return null;
		}

		return this.buildBlockedResult(
			'Destination changed since this journal was created. Review the bucket and region, then use "Reset sync journal" in Advanced settings before syncing this destination.',
		);
	}

	private async checkDestructivePlan(plan: SyncPlanItem[]): Promise<string | null> {
		const deleteLocalCount = plan.filter((item) => item.action === 'delete-local').length;
		if (deleteLocalCount === 0) {
			return null;
		}

		const hasPriorSuccess = (await withJournalContext(
			'reading the last successful sync timestamp',
			() => this.journal.getMetadata(LAST_SUCCESSFUL_SYNC_KEY),
		)) !== undefined;

		if (hasPriorSuccess) {
			return null;
		}

		return `Aborted: destructive plan blocked. ${deleteLocalCount} local file(s) would be deleted for a destination with no recorded successful sync history. Verify the bucket and region, then reset the sync journal if you intentionally want to start fresh.`;
	}

	private buildBlockedResult(
		message: string,
		action: SyncPlanItem['action'] = 'skip',
	): SyncResult {
		const now = Date.now();
		console.error(`[S3 Sync] ${message}`);
		return {
			success: false,
			startedAt: now,
			completedAt: now,
			filesUploaded: 0,
			filesDownloaded: 0,
			filesDeleted: 0,
			conflicts: [],
			errors: [{ path: '', action, message, recoverable: false }],
		};
	}
}
