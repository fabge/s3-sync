/** Thin sync-cycle orchestrator; planner/executor do the heavy lifting. */

import { App } from 'obsidian';
import { S3SyncSettings, SyncPlanItem, SyncResult } from '../types';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
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

	private static readonly PROTECT_ACTIONS = new Set<SyncPlanItem['action']>([
		'upload',
		'download',
		'delete-local',
		'delete-remote',
		'conflict',
	]);

	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private settings: S3SyncSettings,
	) {}

	updateSettings(settings: S3SyncSettings): void {
		this.settings = settings;
	}

	isInProgress(): boolean {
		return this.isSyncing;
	}

	async sync(): Promise<SyncResult> {
		if (this.isSyncing) {
			throw new Error('Sync already in progress');
		}

		this.isSyncing = true;

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
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
				this.settings,
			);
			const inScopeFileCount = await planner.countInScopeLocalFiles();
			const plan = await planner.buildPlan();
			if (computeDestinationFingerprint(this.settings) !== startFingerprint) {
				return this.buildBlockedResult(
					'Aborted: destination changed during sync. The pending sync was discarded; run sync again after saving the new bucket or region.',
				);
			}
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
			this.assertProtectModifyThreshold(plan, inScopeFileCount);

			const executor = new SyncExecutor(
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
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
				startedAt: Date.now(),
				completedAt: Date.now(),
				filesUploaded: 0,
				filesDownloaded: 0,
				filesDeleted: 0,
				filesAdopted: 0,
				filesForgotten: 0,
				conflicts: [],
				errors: [{ path: '', action: 'skip', message, recoverable: false }],
			};
		} finally {
			this.isSyncing = false;
		}
	}

	async resetJournalForCurrentDestination(): Promise<void> {
		const fingerprint = computeDestinationFingerprint(this.settings);
		await withJournalContext(
			'resetting sync journal for the current destination',
			() => this.journal.resetForDestination(fingerprint),
		);
	}

	private assertProtectModifyThreshold(
		plan: SyncPlanItem[],
		inScopeFileCount: number,
	): void {
		const threshold = this.settings.protectModifyPercentage;
		if (threshold >= 100 || inScopeFileCount <= 0) {
			return;
		}

		const riskyActionCount = plan.filter((item) =>
			SyncEngine.PROTECT_ACTIONS.has(item.action),
		).length;
		const riskyPercentage = (riskyActionCount / inScopeFileCount) * 100;

		if (riskyPercentage > threshold) {
			throw new Error(
				`Aborting sync: ${riskyActionCount} of ${inScopeFileCount} in-scope files would change (${riskyPercentage.toFixed(1)}%), exceeding the ${threshold}% protection threshold.`,
			);
		}
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
			filesAdopted: 0,
			filesForgotten: 0,
			conflicts: [],
			errors: [{ path: '', action, message, recoverable: false }],
		};
	}
}
