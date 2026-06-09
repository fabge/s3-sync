/**
 * Thin orchestrator for a sync cycle: acquire mutex → guard the destination →
 * plan ({@link SyncPlanner}) → safety checks → execute ({@link SyncExecutor}) →
 * record `lastSuccessfulSyncAt`. All heavy lifting lives in the planner/executor.
 */

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

	/**
	 * @param deviceId - vault-local install identity (intentionally outside
	 *   settings, since it is not a user-configurable preference).
	 */
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private settings: S3SyncSettings,
		private deviceId: string,
	) {}

	updateSettings(settings: S3SyncSettings): void {
		this.settings = settings;
	}

	isInProgress(): boolean {
		return this.isSyncing;
	}

	/** Run a full sync cycle: plan → execute → persist metadata. Throws if one is already running. */
	async sync(): Promise<SyncResult> {
		if (this.isSyncing) {
			throw new Error('Sync already in progress');
		}

		this.isSyncing = true;

		try {
			const startFingerprint = computeDestinationFingerprint(this.settings);
			const destinationGuardResult = await this.reconcileDestinationFingerprint(startFingerprint);
			if (destinationGuardResult) {
				return destinationGuardResult;
			}

			// Phase 1 — Plan
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
			const destructivePlanError = await this.checkDestructivePlan(plan);
			if (destructivePlanError) {
				return this.buildBlockedResult(destructivePlanError, 'delete-local');
			}
			this.assertProtectModifyThreshold(plan, inScopeFileCount);

			// Phase 2 — Execute
			const executor = new SyncExecutor(
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
				this.deviceId,
			);
			const result = await executor.execute(plan);

			// Phase 3 — Persist metadata
			if (result.success) {
				await this.journal.setMetadata(LAST_SUCCESSFUL_SYNC_KEY, Date.now());
			}

			return result;
		} catch (error) {
			// Wrap any top-level failure as a SyncResult so callers get a uniform
			// return type and can surface the error without crashing the plugin.
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

	/** Abort if too large a share of in-scope files would change at once. */
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

	/**
	 * Block syncing a destination whose fingerprint differs from the one this
	 * journal was created against (stale-journal / wrong-bucket protection).
	 * First sight of a destination records its fingerprint and proceeds.
	 */
	private async reconcileDestinationFingerprint(current: string): Promise<SyncResult | null> {
		const stored = await withJournalContext(
			'reading stored destination fingerprint',
			() => this.journal.getMetadata(DESTINATION_FINGERPRINT_KEY),
		);

		if (stored === current) {
			return null;
		}

		if (stored === undefined) {
			await withJournalContext(
				'recording destination fingerprint',
				() => this.journal.setMetadata(DESTINATION_FINGERPRINT_KEY, current),
			);
			return null;
		}

		return this.buildBlockedResult(
			'Destination changed since this journal was created. Review the bucket and region, then use "Reset sync journal" in Advanced settings before syncing this destination.',
		);
	}

	/** Block a plan that would delete local files against a destination with no successful sync history. */
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
