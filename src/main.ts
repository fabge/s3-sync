import { Notice, Plugin } from 'obsidian';
import { cloneSettings, DEFAULT_SETTINGS, S3SyncSettings, SyncResult } from './types';
import { S3SyncSettingTab } from './settings';
import { StatusBar } from './statusbar';
import { S3Provider } from './storage/S3Provider';
import { SyncJournal } from './sync/SyncJournal';
import { createObsidianVault } from './vault/ObsidianVault';
import { validateHiddenPatterns } from './vault/hiddenPaths';
import { SyncEngine } from './sync/SyncEngine';
import { SyncScheduler } from './sync/SyncScheduler';

interface PersistedPluginData extends Partial<S3SyncSettings> {
	journalId?: unknown;
}

interface ObsidianSettingsApi {
	open: () => void;
	openTabById: (id: string) => void;
}

/** data.json is user-editable, so a persisted glob list may be any shape. */
function toPatternList(value: unknown): { patterns: string[]; discarded: number } {
	if (!Array.isArray(value)) {
		return { patterns: [], discarded: value === undefined ? 0 : 1 };
	}
	const patterns = value.filter((entry): entry is string => typeof entry === 'string');
	return { patterns, discarded: value.length - patterns.length };
}

export default class S3SyncPlugin extends Plugin {
	settings!: S3SyncSettings;

	private journalId = '';
	private s3Provider: S3Provider | null = null;
	private statusBar: StatusBar | null = null;
	private lastConflicts: string[] = [];
	private syncJournal: SyncJournal | null = null;
	private syncEngine: SyncEngine | null = null;
	private syncScheduler: SyncScheduler | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.s3Provider = new S3Provider(this.settings);
		this.statusBar = new StatusBar(this, () => {
			if (this.lastConflicts.length > 0) {
				this.showConflictNotice();
				return;
			}
			void this.triggerManualSync();
		});
		this.statusBar.init();

		this.syncJournal = new SyncJournal(this.journalId);
		await this.syncJournal.initialize();

		this.syncEngine = new SyncEngine(
			createObsidianVault(this.app),
			this.s3Provider,
			this.syncJournal,
			this.settings,
		);

		this.syncScheduler = new SyncScheduler(this, this.syncEngine, this.settings);
		this.syncScheduler.setCallbacks({
			onSyncStart: () => {
				this.statusBar?.updateSyncState({
					status: 'syncing',
					lastError: null,
				});
			},
			onSyncComplete: (result) => {
				this.lastConflicts = result.conflicts;
				const status = result.errors.length > 0
					? 'error'
					: result.conflicts.length > 0
						? 'conflicts'
						: 'synced';

				this.statusBar?.updateSyncState({
					status,
					lastSyncTime: result.completedAt,
					conflictCount: result.conflicts.length,
					lastError: result.errors[0]?.message ?? null,
				});

				const nonRecoverableError = result.errors.find((error) => !error.recoverable);
				if (nonRecoverableError) {
					new Notice(nonRecoverableError.message, 15_000);
				}
			},
		});

		this.updateStatusBarFromSettings();
		this.addSettingTab(new S3SyncSettingTab(this.app, this));

		this.addRibbonIcon('refresh-cw', 'Sync vault', async () => {
			await this.triggerManualSync();
		});
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: async () => this.triggerManualSync(),
		});
		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => {
				const settings = (this.app as unknown as { setting: ObsidianSettingsApi }).setting;
				settings.open();
				settings.openTabById(this.manifest.id);
			},
		});
		this.startSyncServices();

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncEnabled && this.settings.syncOnStartup) {
				void this.triggerSyncWithNotices();
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
		const data = ((await this.loadData()) as PersistedPluginData | null) ?? {};
		const { journalId, ...settingsData } = data;
		const existingJournalId = typeof journalId === 'string' && journalId.length > 0
			? journalId
			: undefined;

		// data.json is hand-editable, so both glob lists are coerced to string
		// arrays before anything reads them. cloneSettings spreads them, so a
		// hand-edited `null` here would throw out of onload and leave no UI to
		// repair it from.
		const merged = { ...DEFAULT_SETTINGS, ...settingsData };
		const hidden = toPatternList(merged.includeHiddenPaths);
		const excludes = toPatternList(merged.excludePatterns);
		merged.includeHiddenPaths = hidden.patterns;
		merged.excludePatterns = excludes.patterns;
		this.settings = cloneSettings(merged);

		// Assigned before anything can persist: persistSettings() writes
		// journalId, so saving while it is still '' would orphan the journal
		// and silently discard every sync baseline on the next launch.
		this.journalId = existingJournalId ?? crypto.randomUUID();

		const { accepted, rejected } = validateHiddenPatterns(
			this.settings.includeHiddenPaths,
			this.app.vault.configDir,
		);
		this.settings.includeHiddenPaths = accepted;

		const dropped = hidden.discarded + excludes.discarded;
		for (const failure of rejected) {
			console.warn(`[S3 Sync] Dropped hidden path "${failure.pattern}": ${failure.reason}`);
		}
		if (dropped > 0) {
			console.warn(`[S3 Sync] Dropped ${dropped} non-string pattern(s) from data.json.`);
		}

		// Written back so an invalid entry is reported once, not on every load.
		if (!existingJournalId || rejected.length > 0 || dropped > 0) {
			await this.persistSettings();
		}
	}

	async saveSettings(): Promise<void> {
		if (this.syncEngine?.isInProgress()) {
			await this.loadSettings();
			new Notice('Cannot change settings while a sync is in progress.');
			return;
		}

		// No awaits between the in-progress check and these updates — an await
		// here would let a scheduled sync start against half-applied settings.
		this.s3Provider?.updateSettings(this.settings);
		this.syncEngine?.updateSettings(this.settings);
		this.syncScheduler?.updateSettings(this.settings);
		await this.persistSettings();
	}

	private async persistSettings(): Promise<void> {
		await this.saveData({
			...this.settings,
			journalId: this.journalId,
		});
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
				lastError: null,
			});
			return;
		}

		this.statusBar.updateSyncState({
			status: this.lastConflicts.length > 0 ? 'conflicts' : 'idle',
			conflictCount: this.lastConflicts.length,
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

	private async triggerSyncWithNotices(): Promise<void> {
		new Notice('Starting sync...');
		const result = await this.syncScheduler?.triggerSync();
		if (!result) {
			new Notice('Sync did not run.');
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

	private showConflictNotice(): void {
		const shown = this.lastConflicts.slice(0, 10);
		const more = this.lastConflicts.length - shown.length;
		new Notice(
			`${this.lastConflicts.length} unresolved conflict(s):\n`
			+ shown.join('\n')
			+ (more > 0 ? `\n…and ${more} more` : '')
			+ '\n\nEach one has LOCAL_ and REMOTE_ copies beside it. Keep the version you want '
			+ 'and delete both copies to resolve.',
			15_000,
		);
	}

	async resetSyncJournal(): Promise<void> {
		if (!this.syncEngine) {
			throw new Error('Sync engine is not initialized yet.');
		}

		await this.syncEngine.resetJournalForCurrentDestination();
		this.lastConflicts = [];
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
