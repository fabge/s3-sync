jest.mock('obsidian');

jest.mock('../../src/storage/S3Provider', () => ({
	S3Provider: jest.fn(),
}));

jest.mock('../../src/sync/SyncJournal', () => ({
	SyncJournal: jest.fn(),
}));

jest.mock('../../src/sync/SyncPlanner', () => ({
	SyncPlanner: jest.fn(),
}));

jest.mock('../../src/sync/SyncExecutor', () => ({
	SyncExecutor: jest.fn(),
}));

import { S3Provider } from '../../src/storage/S3Provider';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { SyncExecutor } from '../../src/sync/SyncExecutor';
import { SyncJournal } from '../../src/sync/SyncJournal';
import { SyncPlan, SyncPlanner } from '../../src/sync/SyncPlanner';
import { DEFAULT_SETTINGS, S3SyncSettings, SyncPlanItem, SyncResult, VaultLike } from '../../src/types';

interface MockPlanner {
	buildPlan: jest.Mock<Promise<SyncPlan>, []>;
}

interface MockExecutor {
	execute: jest.Mock<Promise<SyncResult>, [SyncPlanItem[]]>;
}

interface MockJournal {
	getMetadata: jest.Mock<Promise<string | number | boolean | undefined>, [string]>;
	setMetadata: jest.Mock<Promise<void>, [string, string | number | boolean]>;
	resetForDestination: jest.Mock<Promise<void>, [string]>;
}

interface MockS3Provider {
	readonly kind: 's3-provider';
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface EngineContext {
	app: VaultLike;
	s3Provider: MockS3Provider;
	journal: MockJournal;
	planner: MockPlanner;
	executor: MockExecutor;
	settings: S3SyncSettings;
	engine: SyncEngine;
}

const mockedSyncPlanner = jest.mocked(SyncPlanner);
const mockedSyncExecutor = jest.mocked(SyncExecutor);

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

function createSettings(overrides: Partial<S3SyncSettings> = {}): S3SyncSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
	};
}

function createPlanItem(path: string, action: SyncPlanItem['action'] = 'skip'): SyncPlanItem {
	return {
		path,
		action,
	};
}

function createPlan(
	items: SyncPlanItem[] = [],
	counts: Partial<Pick<SyncPlan, 'syncedFileCount' | 'changedSyncedFileCount'>> = {},
): SyncPlan {
	return {
		items,
		syncedFileCount: counts.syncedFileCount ?? 10,
		changedSyncedFileCount: counts.changedSyncedFileCount ?? 0,
	};
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		completedAt: 200,
		filesUploaded: 0,
		filesDownloaded: 0,
		filesDeleted: 0,
		conflicts: [],
		errors: [],
		...overrides,
	};
}

function createEngineContext(overrides: Partial<S3SyncSettings> = {}): EngineContext {
	// SyncEngine only forwards the vault port to planner and executor, both
	// of which are mocked here, so an empty port stub is enough.
	const app = { configDir: '.obsidian' } as unknown as VaultLike;
	const s3Provider: MockS3Provider = { kind: 's3-provider' };
	const settings = createSettings(overrides);
	const journal: MockJournal = {
		getMetadata: jest.fn(async (key: string) => {
			if (key === 'destinationFingerprint') {
				return JSON.stringify({ bucket: settings.bucket, region: settings.region });
			}
			if (key === 'lastSuccessfulSyncAt') {
				return 111;
			}
			return undefined;
		}),
		setMetadata: jest.fn().mockResolvedValue(undefined),
		resetForDestination: jest.fn().mockResolvedValue(undefined),
	};
	const planner: MockPlanner = {
		buildPlan: jest.fn().mockResolvedValue(createPlan()),
	};
	const executor: MockExecutor = {
		execute: jest.fn().mockResolvedValue(createSyncResult()),
	};

	mockedSyncPlanner.mockImplementation(() => planner as unknown as SyncPlanner);
	mockedSyncExecutor.mockImplementation(() => executor as unknown as SyncExecutor);

	const engine = new SyncEngine(
		app,
		s3Provider as unknown as S3Provider,
		journal as unknown as SyncJournal,
		settings,
	);

	return {
		app,
		s3Provider,
		journal,
		planner,
		executor,
		settings,
		engine,
	};
}

/**
 * Covers SyncEngine's top-level orchestration responsibilities:
 * mutex behavior, lifecycle flags, planner/executor wiring, metadata persistence,
 * runtime settings propagation, wrapped errors, and debug logging.
 */
describe('SyncEngine', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	/**
	 * Covers SyncEngine's mutex and in-progress lifecycle behavior around sync entry,
	 * exit, and finally-block cleanup.
	 */
	describe('sync lifecycle', () => {
		it('throws when sync is called while another sync is already in progress', async () => {
			const context = createEngineContext();
			const plannerDeferred = createDeferred<SyncPlan>();
			context.planner.buildPlan.mockReturnValueOnce(plannerDeferred.promise);

			const activeSync = context.engine.sync();

			expect(context.engine.isInProgress()).toBe(true);
			await expect(context.engine.sync()).rejects.toThrow('Sync already in progress');

			plannerDeferred.resolve(createPlan());
			await activeSync;
		});

		it('resets isSyncing to false after a successful sync completes', async () => {
			const context = createEngineContext();

			expect(context.engine.isInProgress()).toBe(false);
			await context.engine.sync();
			expect(context.engine.isInProgress()).toBe(false);
		});

		it('resets isSyncing to false after a failed sync when the planner throws', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockRejectedValueOnce(new Error('planner exploded'));

			const result = await context.engine.sync();

			expect(result.errors).not.toHaveLength(0);
			expect(context.engine.isInProgress()).toBe(false);
		});

		it('returns true from isInProgress during sync and false before and after completion', async () => {
			const context = createEngineContext();
			const executeDeferred = createDeferred<SyncResult>();
			context.executor.execute.mockReturnValueOnce(executeDeferred.promise);

			expect(context.engine.isInProgress()).toBe(false);
			const syncPromise = context.engine.sync();
			expect(context.engine.isInProgress()).toBe(true);

			executeDeferred.resolve(createSyncResult());
			await syncPromise;

			expect(context.engine.isInProgress()).toBe(false);
		});
	});

	/**
	 * Covers SyncEngine's planner-to-executor orchestration contract, ensuring it builds
	 * a plan first and then hands that exact plan to the executor.
	 */
	describe('planner and executor orchestration', () => {
		it('calls planner.buildPlan before executor.execute during a sync cycle', async () => {
			const context = createEngineContext();
			const plan = createPlan([createPlanItem('notes/one.md')]);
			context.planner.buildPlan.mockResolvedValueOnce(plan);

			await context.engine.sync();

			expect(context.planner.buildPlan).toHaveBeenCalledTimes(1);
			expect(context.executor.execute).toHaveBeenCalledTimes(1);
			expect(context.planner.buildPlan.mock.invocationCallOrder[0]).toBeLessThan(
				context.executor.execute.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
			);
		});

		it('passes the planner output directly to executor.execute', async () => {
			const context = createEngineContext();
			const items = [createPlanItem('notes/one.md', 'upload'), createPlanItem('notes/two.md', 'download')];
			context.planner.buildPlan.mockResolvedValueOnce(createPlan(items));

			await context.engine.sync();

			expect(context.executor.execute).toHaveBeenCalledWith(items);
		});
	});

	/**
	 * Covers SyncEngine's success and failure result handling, including journal metadata
	 * persistence and conversion of unexpected top-level failures into SyncResult values.
	 */
	describe('result handling', () => {
		it('records a destination fingerprint when none is stored yet', async () => {
			const context = createEngineContext();
			context.journal.getMetadata.mockImplementation(async (key: string) => {
				if (key === 'destinationFingerprint') {
					return undefined;
				}
				if (key === 'lastSuccessfulSyncAt') {
					return 111;
				}
				return undefined;
			});
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(12_345);

			await context.engine.sync();

			expect(context.journal.setMetadata).toHaveBeenNthCalledWith(
				1,
				'destinationFingerprint',
				JSON.stringify({ bucket: context.settings.bucket, region: context.settings.region }),
			);
			expect(context.journal.setMetadata).toHaveBeenNthCalledWith(2, 'lastSuccessfulSyncAt', 12_345);
			nowSpy.mockRestore();
		});

		it('does not record a destination fingerprint when planning fails', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			context.journal.getMetadata.mockImplementation(async (key: string) => {
				if (key === 'destinationFingerprint') {
					return undefined;
				}
				if (key === 'lastSuccessfulSyncAt') {
					return 111;
				}
				return undefined;
			});
			context.planner.buildPlan.mockRejectedValueOnce(new Error('list failed'));

			const result = await context.engine.sync();

			expect(result.errors).not.toHaveLength(0);
			expect(context.journal.setMetadata).not.toHaveBeenCalled();
			consoleErrorSpy.mockRestore();
		});

		it('persists lastSuccessfulSyncAt metadata after a successful sync', async () => {
			const context = createEngineContext();
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(12_345);

			await context.engine.sync();

			expect(context.journal.setMetadata).toHaveBeenCalledWith('lastSuccessfulSyncAt', 12_345);
			nowSpy.mockRestore();
		});

		it('blocks sync when the destination fingerprint differs from the stored value', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			context.journal.getMetadata.mockImplementation(async (key: string) => {
				if (key === 'destinationFingerprint') {
					return JSON.stringify({ bucket: 'other-bucket', region: context.settings.region });
				}
				if (key === 'lastSuccessfulSyncAt') {
					return 111;
				}
				return undefined;
			});

			const result = await context.engine.sync();

			expect(result.errors).not.toHaveLength(0);
			expect(result.errors[0]?.recoverable).toBe(false);
			expect(result.errors[0]?.message).toContain('Reset sync journal');
			expect(context.planner.buildPlan).not.toHaveBeenCalled();
			expect(context.executor.execute).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalled();
			consoleErrorSpy.mockRestore();
		});

		it('rejects settings updates while sync is in progress', async () => {
			const context = createEngineContext();
			const planDeferred = createDeferred<SyncPlan>();
			context.planner.buildPlan.mockReturnValueOnce(planDeferred.promise);

			const syncPromise = context.engine.sync();
			expect(() => context.engine.updateSettings(createSettings({ bucket: 'changed-bucket' })))
				.toThrow('Cannot update sync settings while a sync is in progress.');
			planDeferred.resolve(createPlan());

			const result = await syncPromise;

			expect(result.errors).toEqual([]);
			expect(context.executor.execute).toHaveBeenCalledTimes(1);
		});

		it('blocks the plan when changed synced files exceed the protection threshold', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			context.planner.buildPlan.mockResolvedValueOnce(createPlan(
				[createPlanItem('notes/one.md', 'upload'), createPlanItem('notes/two.md', 'upload')],
				{ syncedFileCount: 2, changedSyncedFileCount: 2 },
			));

			const result = await context.engine.sync();

			expect(result.errors).not.toHaveLength(0);
			expect(result.errors[0]?.recoverable).toBe(false);
			expect(result.errors[0]?.message).toContain('protection threshold');
			expect(context.executor.execute).not.toHaveBeenCalled();
			consoleErrorSpy.mockRestore();
		});

		it('does not block when only new files change and the synced set is untouched', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockResolvedValueOnce(createPlan(
				[
					createPlanItem('notes/new-1.md', 'upload'),
					createPlanItem('notes/new-2.md', 'upload'),
					createPlanItem('notes/new-3.md', 'upload'),
				],
				{ syncedFileCount: 4, changedSyncedFileCount: 0 },
			));

			const result = await context.engine.sync();

			expect(result.errors).toEqual([]);
			expect(context.executor.execute).toHaveBeenCalledTimes(1);
		});

		it('blocks delete-local plans when there is no prior successful sync', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockResolvedValueOnce(createPlan([
				createPlanItem('notes/one.md', 'delete-local'),
			]));
			context.journal.getMetadata.mockImplementation(async (key: string) => {
				if (key === 'destinationFingerprint') {
					return JSON.stringify({ bucket: context.settings.bucket, region: context.settings.region });
				}
				if (key === 'lastSuccessfulSyncAt') {
					return undefined;
				}
				return undefined;
			});
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const result = await context.engine.sync();

			expect(result.errors).not.toHaveLength(0);
			expect(result.errors[0]?.action).toBe('delete-local');
			expect(result.errors[0]?.message).toContain('destructive plan blocked');
			expect(context.executor.execute).not.toHaveBeenCalled();
			consoleErrorSpy.mockRestore();
		});

		it('does not persist lastSuccessfulSyncAt when the executor returns a failed result', async () => {
			const context = createEngineContext();
			context.executor.execute.mockResolvedValueOnce(createSyncResult({
				errors: [{ path: 'notes/fail.md', action: 'upload', message: 'failed', recoverable: true }],
			}));

			await context.engine.sync();

			expect(context.journal.setMetadata).not.toHaveBeenCalled();
		});

		it('wraps an unexpected planner Error into a failed SyncResult', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(54_321);
			context.planner.buildPlan.mockRejectedValueOnce(new Error('planner exploded'));

			const result = await context.engine.sync();

			expect(result).toEqual({
				completedAt: 54_321,
				filesUploaded: 0,
				filesDownloaded: 0,
				filesDeleted: 0,
				conflicts: [],
				errors: [{ path: '', action: 'skip', message: 'planner exploded', recoverable: false }],
			});
			expect(consoleErrorSpy).toHaveBeenCalledWith('[S3 Sync] Sync failed: planner exploded');

			nowSpy.mockRestore();
			consoleErrorSpy.mockRestore();
		});

		it('wraps a non-Error throwable into a failed SyncResult with an unknown error message', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(98_765);
			context.planner.buildPlan.mockRejectedValueOnce('bad payload');

			const result = await context.engine.sync();

			expect(result.errors).toEqual([{ path: '', action: 'skip', message: 'Unknown error', recoverable: false }]);
			expect(result.completedAt).toBe(98_765);
			expect(consoleErrorSpy).toHaveBeenCalledWith('[S3 Sync] Sync failed: Unknown error');

			nowSpy.mockRestore();
			consoleErrorSpy.mockRestore();
		});
	});

	/**
	 * Covers SyncEngine's runtime configuration updates, verifying future planner
	 * and executor instances reflect the latest settings snapshot.
	 */
	describe('updateSettings', () => {
		it('propagates updated settings to future planner and executor instances', async () => {
			const context = createEngineContext();
			const updatedSettings = createSettings({
				excludePatterns: ['**/.cache/**'],
				protectModifyPercentage: 75,
			});

			context.engine.updateSettings(updatedSettings);
			await context.engine.sync();

			expect(mockedSyncPlanner).toHaveBeenLastCalledWith(
				context.app,
				context.s3Provider,
				context.journal,
				updatedSettings,
			);
			expect(mockedSyncExecutor).toHaveBeenLastCalledWith(
				context.app,
				context.s3Provider,
				context.journal,
			);
		});

		describe('journal reset', () => {
			it('resets the journal for the current destination fingerprint', async () => {
				const context = createEngineContext({
					bucket: 'vault-b',
					region: 'us-west-2',
				});

				await context.engine.resetJournalForCurrentDestination();

				expect(context.journal.resetForDestination).toHaveBeenCalledWith(
					JSON.stringify({ bucket: 'vault-b', region: 'us-west-2' }),
				);
			});

			it('refuses to reset the journal while a sync is in progress', async () => {
				const context = createEngineContext();
				const plannerDeferred = createDeferred<SyncPlan>();
				context.planner.buildPlan.mockReturnValueOnce(plannerDeferred.promise);

				const syncPromise = context.engine.sync();
				await expect(context.engine.resetJournalForCurrentDestination())
					.rejects.toThrow('Cannot reset the sync journal while a sync is in progress.');
				expect(context.journal.resetForDestination).not.toHaveBeenCalled();

				plannerDeferred.resolve(createPlan());
				await syncPromise;
			});

			it('reports in-progress while a reset is running', async () => {
				const context = createEngineContext();
				const resetDeferred = createDeferred<void>();
				context.journal.resetForDestination.mockReturnValueOnce(resetDeferred.promise);

				const resetPromise = context.engine.resetJournalForCurrentDestination();
				expect(context.engine.isInProgress()).toBe(true);

				resetDeferred.resolve(undefined);
				await resetPromise;
				expect(context.engine.isInProgress()).toBe(false);
			});
		});
	});
});
