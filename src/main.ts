import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, S3SyncSettings, SyncResult } from './types';
import { S3SyncSettingTab } from './settings';
import { StatusBar } from './statusbar';
import { S3Provider } from './storage/S3Provider';
import { SyncJournal } from './sync/SyncJournal';
import { SyncPathCodec } from './sync/SyncPathCodec';
import { SyncEngine } from './sync/SyncEngine';
import { SyncScheduler } from './sync/SyncScheduler';
import { registerPluginCommands } from './commands';

export default class S3SyncPlugin extends Plugin {
	settings!: S3SyncSettings;

	private s3Provider: S3Provider | null = null;
	private statusBar: StatusBar | null = null;
	private syncJournal: SyncJournal | null = null;
	private pathCodec: SyncPathCodec | null = null;
	private syncEngine: SyncEngine | null = null;
	private syncScheduler: SyncScheduler | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.s3Provider = new S3Provider(this.settings);
		this.statusBar = new StatusBar(this);
		this.statusBar.setActionHandler(() => {
			void this.triggerManualSync();
		});
		this.statusBar.init();

		this.syncJournal = new SyncJournal(this.app.vault.getName());
		await this.syncJournal.initialize();

		this.pathCodec = new SyncPathCodec();

		this.syncEngine = new SyncEngine(
			this.app,
			this.s3Provider,
			this.syncJournal,
			this.pathCodec,
			this.settings,
		);

		this.syncScheduler = new SyncScheduler(this, this.syncEngine, this.settings);
		this.syncScheduler.setCallbacks({
			onSyncStart: () => {
				this.statusBar?.updateSyncState({
					status: 'syncing',
					isSyncing: true,
					lastError: null,
				});
			},
			onSyncComplete: (result) => {
				const status = result.errors.length > 0
					? 'error'
					: result.conflicts.length > 0
						? 'conflicts'
						: 'synced';

				this.statusBar?.updateSyncState({
					status,
					lastSyncTime: result.completedAt,
					isSyncing: false,
					conflictCount: result.conflicts.length,
					lastError: result.errors[0]?.message ?? null,
				});

				const nonRecoverableError = result.errors.find((error) => !error.recoverable);
				if (nonRecoverableError) {
					new Notice(nonRecoverableError.message, 15_000);
				}
			},
			onSyncError: (error) => {
				this.statusBar?.updateSyncState({
					status: 'error',
					isSyncing: false,
					lastError: error,
				});
			},
		});

		this.updateStatusBarFromSettings();
		this.addSettingTab(new S3SyncSettingTab(this.app, this));

		this.addRibbonIcon('refresh-cw', 'Sync vault', async () => {
			await this.triggerManualSync();
		});
		registerPluginCommands(this);
		this.startSyncServices();

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncEnabled && this.settings.syncOnStartup) {
				void this.triggerStartupSync();
			}
		});
	}

	onunload(): void {
		this.stopSyncServices();

		this.syncJournal?.close();
		this.syncJournal = null;
		this.s3Provider?.destroy();
		this.s3Provider = null;
		this.statusBar?.destroy();
		this.statusBar = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData() as Partial<S3SyncSettings> | null) ?? {},
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.s3Provider?.updateSettings(this.settings);
		this.syncEngine?.updateSettings(this.settings);
		this.syncScheduler?.updateSettings(this.settings);
	}

	onSettingsChanged(): void {
		this.updateStatusBarFromSettings();
		this.restartSyncServices();
	}

	private updateStatusBarFromSettings(): void {
		if (!this.statusBar) {
			return;
		}

		if (!this.settings.syncEnabled) {
			this.statusBar.updateSyncState({
				status: 'disabled',
				lastSyncTime: null,
				conflictCount: 0,
				isSyncing: false,
				lastError: null,
			});
			return;
		}

		this.statusBar.updateSyncState({
			status: 'idle',
			conflictCount: 0,
			isSyncing: false,
			lastError: null,
		});
	}

	private startSyncServices(): void {
		if (this.settings.syncEnabled && this.settings.autoSyncEnabled) {
			this.syncScheduler?.start();
		}
	}

	private stopSyncServices(): void {
		this.syncScheduler?.stop();
	}

	private restartSyncServices(): void {
		this.stopSyncServices();
		this.startSyncServices();
	}

	private async triggerStartupSync(): Promise<void> {
		await this.triggerSyncWithNotices();
	}

	private async triggerSyncWithNotices(): Promise<void> {
		new Notice('Starting sync...');
		const result = await this.syncScheduler?.triggerSync();
		if (!result) {
			return;
		}

		this.showSyncResultNotice(result);
	}

	private showSyncResultNotice(result: SyncResult): void {
		if (result.errors[0]) {
			new Notice(`Sync completed with errors: ${result.errors[0].message}`);
			return;
		}

		if (result.conflicts.length > 0) {
			new Notice(`Sync completed with ${result.conflicts.length} conflict(s)`);
			return;
		}

		const filesSynced =
			result.filesUploaded
			+ result.filesDownloaded
			+ result.filesDeleted;

		new Notice(
			`Sync completed: ${filesSynced} file(s) changed — ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded, ${result.filesDeleted} deleted`,
		);
	}

	async resetSyncJournal(): Promise<void> {
		if (!this.syncEngine) {
			throw new Error('Sync engine is not initialized yet.');
		}

		if (this.syncEngine.isInProgress()) {
			throw new Error('Cannot reset the sync journal while a sync is in progress.');
		}

		await this.syncEngine.resetJournalForCurrentDestination();
		this.updateStatusBarFromSettings();
	}

	async triggerManualSync(): Promise<void> {
		if (!this.settings.syncEnabled) {
			new Notice('Sync is disabled. Enable it in settings.');
			return;
		}

		if (this.syncEngine?.isInProgress()) {
			new Notice('Sync already in progress...');
			return;
		}

		await this.triggerSyncWithNotices();
	}

	getS3Provider(): S3Provider | null {
		return this.s3Provider;
	}
}
