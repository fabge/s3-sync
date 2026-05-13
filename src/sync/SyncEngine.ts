/**
 * Sync Engine Module (v2)
 *
 * Thin orchestrator that coordinates the three-way reconciliation sync:
 *   1. Acquire mutex (prevent concurrent syncs)
 *   2. Signal ChangeTracker that sync is active
 *   3. Build a plan via {@link SyncPlanner}
 *   4. Execute the plan via {@link SyncExecutor}
 *   5. Record `lastSuccessfulSyncAt` in journal metadata
 *   6. Release mutex and signal ChangeTracker
 *
 * All heavy lifting (state discovery, classification, decision-making,
 * file I/O, S3 operations) lives in the planner and executor modules.
 */

import { App } from 'obsidian';
import { S3SyncSettings, SyncPlanItem, SyncResult } from '../types';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { SyncPayloadCodec } from './SyncPayloadCodec';
import { SyncPlanner } from './SyncPlanner';
import { SyncExecutor } from './SyncExecutor';
import { ChangeTracker } from './ChangeTracker';

/**
 * SyncEngine — orchestrates a complete sync cycle.
 *
 * Constructed once in `main.ts` and reused for every sync trigger
 * (scheduled, manual, or on-startup).
 */
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
	 * @param app           - The Obsidian App instance (vault, fileManager, etc.).
	 * @param s3Provider    - S3 abstraction layer; constructed from current settings.
	 * @param journal       - IndexedDB journal for per-file baseline persistence.
	 * @param pathCodec     - Converts vault-relative paths ↔ S3 object keys.
	 * @param payloadCodec  - Encodes file content for upload/download (currently a plaintext passthrough).
	 * @param changeTracker - Dirty-path tracker; suppressed during active syncs.
	 * @param settings      - Full plugin settings snapshot used to configure
	 *   the planner (e.g. exclude patterns) and safety threshold.
	 * @param deviceId      - Stable per-device identifier embedded in S3 metadata
	 *   so other devices can attribute the last write.
	 */
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private payloadCodec: SyncPayloadCodec,
		private changeTracker: ChangeTracker,
		private settings: S3SyncSettings,
		private deviceId: string,
	) {}

	/**
	 * Update runtime settings (e.g. after the user changes them in the settings tab).
	 *
	 * @param settings - The new settings snapshot.
	 */
	updateSettings(settings: S3SyncSettings): void {
		this.settings = settings;
	}

	/**
	 * Check whether a sync cycle is currently in progress.
	 *
	 * @returns `true` while {@link sync} is executing.
	 */
	isInProgress(): boolean {
		return this.isSyncing;
	}

	/**
	 * Run a full sync cycle: plan → execute → persist metadata.
	 *
	 * @returns A {@link SyncResult} summarising what happened.
	 * @throws If called while another sync is already running.
	 */
	async sync(): Promise<SyncResult> {
		if (this.isSyncing) {
			throw new Error('Sync already in progress');
		}

		this.isSyncing = true;
		this.changeTracker.setSyncInProgress(true);

		try {
			// Phase 1 — Plan
			const planner = new SyncPlanner(
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
				this.payloadCodec,
				this.settings,
			);
			const inScopeFileCount = await planner.countInScopeLocalFiles();
			const plan = await planner.buildPlan();
			this.assertProtectModifyThreshold(plan, inScopeFileCount);

			// Phase 2 — Execute
			const executor = new SyncExecutor(
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
				this.payloadCodec,
				this.changeTracker,
				this.deviceId,
			);
			const result = await executor.execute(plan);

			// Phase 3 — Persist metadata
			if (result.success) {
				await this.journal.setMetadata('lastSuccessfulSyncAt', Date.now());
			}

			return result;
		} catch (error) {
			// Unexpected top-level failure (e.g. SyncPlanner threw, network
			// unavailable before any item started).  Wrap as a SyncResult so
			// callers always receive a uniform return type and can surface the
			// error via the status bar without crashing the plugin.
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
			this.changeTracker.setSyncInProgress(false);
		}
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
}
