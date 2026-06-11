jest.mock('obsidian');

jest.mock('../../src/sync/SyncEngine', () => ({
	SyncEngine: jest.fn(),
}));

import { Plugin } from 'obsidian';
import { SyncScheduler } from '../../src/sync/SyncScheduler';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS, S3SyncSettings, SyncResult } from '../../src/types';

interface MockPlugin {
	registerInterval: jest.Mock<number, [number]>;
}

interface MockSyncEngine {
	isInProgress: jest.Mock<boolean, []>;
	sync: jest.Mock<Promise<SyncResult>, []>;
}

interface SchedulerContext {
	plugin: Plugin;
	pluginMocks: MockPlugin;
	syncEngine: SyncEngine;
	syncEngineMocks: MockSyncEngine;
	scheduler: SyncScheduler;
	settings: S3SyncSettings;
}

function createSettings(overrides: Partial<S3SyncSettings> = {}): S3SyncSettings {
	return {
		...DEFAULT_SETTINGS,
		syncEnabled: true,
		autoSyncEnabled: true,
		...overrides,
	};
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		success: true,
		startedAt: 100,
		completedAt: 200,
		filesUploaded: 1,
		filesDownloaded: 0,
		filesDeleted: 0,
		conflicts: [],
		errors: [],
		...overrides,
	};
}

function createSchedulerContext(overrides: Partial<S3SyncSettings> = {}): SchedulerContext {
	const settings = createSettings(overrides);
	const pluginMocks: MockPlugin = {
		registerInterval: jest.fn((id: number) => id),
	};
	const syncEngineMocks: MockSyncEngine = {
		isInProgress: jest.fn().mockReturnValue(false),
		sync: jest.fn().mockResolvedValue(createSyncResult()),
	};
	const plugin = pluginMocks as unknown as Plugin;
	const syncEngine = syncEngineMocks as unknown as SyncEngine;
	const scheduler = new SyncScheduler(plugin, syncEngine, settings);

	return {
		plugin,
		pluginMocks,
		syncEngine,
		syncEngineMocks,
		scheduler,
		settings,
	};
}

/**
 * Covers SyncScheduler public lifecycle, interval, and callback orchestration.
 */
describe('SyncScheduler', () => {
	let setIntervalSpy: jest.SpiedFunction<typeof globalThis.setInterval>;
	let clearIntervalSpy: jest.SpiedFunction<typeof globalThis.clearInterval>;
	let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		jest.clearAllMocks();
		Object.defineProperty(globalThis, 'window', {
			value: globalThis,
			configurable: true,
			writable: true,
		});
		setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
		clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		jest.useRealTimers();
	});

	/**
	 * Verifies scheduler start and stop behavior around enablement guards and intervals.
	 */
	describe('start and stop', () => {
		it('does not start when syncEnabled is false', () => {
			const { scheduler, pluginMocks } = createSchedulerContext({ syncEnabled: false });

			scheduler.start();

			expect(pluginMocks.registerInterval).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
		});

		it('does not start when autoSyncEnabled is false', () => {
			const { scheduler, pluginMocks } = createSchedulerContext({ autoSyncEnabled: false });

			scheduler.start();

			expect(pluginMocks.registerInterval).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
		});

		it('does not register a second interval when start is called twice', () => {
			const { scheduler, pluginMocks } = createSchedulerContext();

			scheduler.start();
			scheduler.start();

			expect(pluginMocks.registerInterval).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		});

		it('registers the interval using syncIntervalMinutes converted to milliseconds', () => {
			const { scheduler, pluginMocks } = createSchedulerContext({ syncIntervalMinutes: 10 });

			scheduler.start();
			const registeredIntervalId = setIntervalSpy.mock.results[0]?.value;

			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 600000);
			expect(pluginMocks.registerInterval).toHaveBeenCalledTimes(1);
			expect(pluginMocks.registerInterval).toHaveBeenCalledWith(registeredIntervalId as number);
		});

		it('clears the active interval and resets the scheduler state when stopped', () => {
			const { scheduler } = createSchedulerContext();

			scheduler.start();
			scheduler.stop();

			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		});

		it('does nothing when stop is called while the scheduler is not running', () => {
			const { scheduler } = createSchedulerContext();

			scheduler.stop();

			expect(clearIntervalSpy).not.toHaveBeenCalled();
		});
	});

	/**
	 * Verifies scheduled ticks and triggerSync guard behavior without asserting engine internals.
	 */
	describe('scheduled ticks and trigger guards', () => {
		it('triggers scheduled syncs on each timer tick', () => {
			const { scheduler, settings } = createSchedulerContext();
			const triggerSyncSpy = jest.spyOn(scheduler, 'triggerSync').mockResolvedValue(null);

			scheduler.start();
			jest.advanceTimersByTime(settings.syncIntervalMinutes * 60 * 1000);
			jest.advanceTimersByTime(settings.syncIntervalMinutes * 60 * 1000);

			expect(triggerSyncSpy).toHaveBeenCalledTimes(2);
		});

		it('skips triggerSync when the sync engine reports an in-progress run', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			syncEngineMocks.isInProgress.mockReturnValue(true);

			const result = await scheduler.triggerSync();

			expect(result).toBeNull();
			expect(syncEngineMocks.sync).not.toHaveBeenCalled();
		});

	});

	/**
	 * Verifies callback ordering, error forwarding, and triggerSync return values.
	 */
	describe('triggerSync callbacks', () => {
		it('calls onSyncStart before syncing and onSyncComplete after a successful sync', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			const events: string[] = [];
			const result = createSyncResult({ filesUploaded: 2 });
			syncEngineMocks.sync.mockImplementation(async () => {
				events.push('sync');
				return result;
			});

			scheduler.setCallbacks({
				onSyncStart: () => {
					events.push('start');
				},
				onSyncComplete: (syncResult: SyncResult) => {
					events.push(`complete:${syncResult.filesUploaded}`);
				},
			});

			await scheduler.triggerSync();

			expect(events).toEqual(['start', 'sync', 'complete:2']);
		});

		it('calls onSyncError when the sync engine throws an exception', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			const onSyncError = jest.fn<void, [string]>();
			syncEngineMocks.sync.mockRejectedValue(new Error('Sync exploded'));

			scheduler.setCallbacks({ onSyncError });

			const result = await scheduler.triggerSync();

			expect(result).toBeNull();
			expect(onSyncError).toHaveBeenCalledTimes(1);
			expect(onSyncError).toHaveBeenCalledWith('Sync exploded');
		});

		it('returns the SyncResult on success and null when the sync is skipped', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			const successResult = createSyncResult({ filesDownloaded: 3 });
			syncEngineMocks.sync.mockResolvedValue(successResult);

			await expect(scheduler.triggerSync()).resolves.toEqual(successResult);

			syncEngineMocks.isInProgress.mockReturnValue(true);
			await expect(scheduler.triggerSync()).resolves.toBeNull();
		});
	});

	/**
	 * Verifies updateSettings only stores settings; main owns the restart.
	 */
	describe('settings updates', () => {
		it('does not restart the timer itself; the next start uses the updated interval', () => {
			const { scheduler } = createSchedulerContext({ syncIntervalMinutes: 5 });

			scheduler.start();
			scheduler.updateSettings(createSettings({ syncIntervalMinutes: 10 }));

			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(clearIntervalSpy).not.toHaveBeenCalled();

			scheduler.stop();
			scheduler.start();

			expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 600000);
		});
	});
});
