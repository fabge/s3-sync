import { App, Notice, PluginSettingTab, Setting, TextAreaComponent } from 'obsidian';
import type S3SyncPlugin from './main';
import { SyncIntervalMinutes } from './types';
import { validateHiddenPatterns } from './vault/hiddenPaths';

const SYNC_INTERVAL_NAMES: Record<SyncIntervalMinutes, string> = {
	1: '1 minute',
	2: '2 minutes',
	5: '5 minutes',
	10: '10 minutes',
	15: '15 minutes',
	30: '30 minutes',
};

export class S3SyncSettingTab extends PluginSettingTab {
	private hiddenPathsField: TextAreaComponent | null = null;

	constructor(app: App, private plugin: S3SyncPlugin) {
		super(app, plugin);
	}

	/**
	 * Blur alone is not enough: closing the modal while the field still has
	 * focus would drop whatever was typed, so flush here as well.
	 */
	hide(): void {
		const field = this.hiddenPathsField;
		this.hiddenPathsField = null;
		if (field) {
			// Cannot be awaited from a synchronous lifecycle hook, so failures
			// are surfaced here rather than becoming an unhandled rejection.
			this.applyHiddenPaths(field).catch((error: unknown) => {
				console.error('[S3 Sync] Could not save hidden paths:', error);
				new Notice('Could not save hidden folder patterns.');
			});
		}
		super.hide();
	}

	private async applyHiddenPaths(text: TextAreaComponent): Promise<void> {
		const requested = text
			.getValue()
			.split('\n')
			.map((pattern) => pattern.trim())
			.filter((pattern) => pattern.length > 0);
		const { accepted, rejected } = validateHiddenPatterns(requested, this.app.vault.configDir);
		const unchanged = rejected.length === 0
			&& accepted.length === this.plugin.settings.includeHiddenPaths.length
			&& accepted.every((pattern, index) => pattern === this.plugin.settings.includeHiddenPaths[index]);
		if (unchanged) return;

		if (rejected.length > 0) {
			new Notice(
				'Ignored hidden path patterns:\n'
				+ rejected.map((failure) => `${failure.pattern} — ${failure.reason}`).join('\n'),
			);
		}

		// Rewritten so the field shows what is actually stored; otherwise a
		// rejected line stays on screen looking as though it took effect.
		text.setValue(accepted.join('\n'));
		this.plugin.settings.includeHiddenPaths = accepted;
		await this.plugin.saveSettings();
		this.plugin.onSettingsChanged();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderConnectionSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAdvancedSection(containerEl);
	}

	private renderConnectionSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Connection').setHeading();

		new Setting(containerEl)
			.setName('Region')
			.setDesc('Region of the bucket, for example eu-central-1')
			.addText((text) => {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal example value
				text.setPlaceholder('eu-central-1');
				text.setValue(this.plugin.settings.region);
				text.onChange(async (value) => {
					this.plugin.settings.region = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Bucket')
			.setDesc('Name of your S3 bucket')
			.addText((text) => {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal example value
				text.setPlaceholder('bucket-name');
				text.setValue(this.plugin.settings.bucket);
				text.onChange(async (value) => {
					this.plugin.settings.bucket = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Access key ID')
			.setDesc('Access key for the bucket')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setValue(this.plugin.settings.accessKeyId);
				text.onChange(async (value) => {
					this.plugin.settings.accessKeyId = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Secret access key')
			.setDesc('Secret access key for the bucket')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setValue(this.plugin.settings.secretAccessKey);
				text.onChange(async (value) => {
					this.plugin.settings.secretAccessKey = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Verify bucket access with the configured credentials')
			.addButton((button) => {
				button.setButtonText('Test connection');
				button.onClick(async () => {
					const provider = this.plugin.getS3Provider();
					if (!provider) {
						new Notice('S3 provider is not initialized yet.');
						return;
					}

					try {
						const message = await provider.testConnection();
						new Notice(message);
					} catch (error) {
						new Notice(error instanceof Error ? error.message : 'Connection failed');
					}
				});
			});
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Enable sync')
			.setDesc('Enable bi-directional vault synchronization')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.syncEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.syncEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.display();
				});
			});

		if (!this.plugin.settings.syncEnabled) {
			return;
		}

		new Setting(containerEl)
			.setName('Auto-sync')
			.setDesc('Automatically sync at regular intervals')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoSyncEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.autoSyncEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.display();
				});
			});

		if (this.plugin.settings.autoSyncEnabled) {
			new Setting(containerEl)
				.setName('Sync interval')
				.setDesc('How often to automatically sync')
				.addDropdown((dropdown) => {
					for (const [value, name] of Object.entries(SYNC_INTERVAL_NAMES)) {
						dropdown.addOption(value, name);
					}
					dropdown.setValue(String(this.plugin.settings.syncIntervalMinutes));
					dropdown.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = Number.parseInt(
							value,
							10,
						) as SyncIntervalMinutes;
						await this.plugin.saveSettings();
						this.plugin.onSettingsChanged();
					});
				});
		}

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Run one sync after the vault has finished loading')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.syncOnStartup);
				toggle.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				});
			});
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('Abort if changed files exceed threshold')
			.setDesc(
				'Aborts sync when the share of already-synced files that would change exceeds this percentage. The first sync to a destination is exempt. Use 100 to disable the protection.',
			)
			.addText((text) => {
				text.setPlaceholder('50');
				text.setValue(String(this.plugin.settings.protectModifyPercentage));
				text.onChange(async (value) => {
					const parsed = Number.parseFloat(value);
					if (Number.isNaN(parsed)) {
						return;
					}
					this.plugin.settings.protectModifyPercentage = Math.max(
						0,
						Math.min(100, parsed),
					);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Exclude patterns')
			.setDesc('One glob pattern per line')
			.addTextArea((text) => {
				text.setPlaceholder('**/workspace*\n.trash/**');
				text.setValue(this.plugin.settings.excludePatterns.join('\n'));
				text.inputEl.rows = 6;
				text.onChange(async (value) => {
					this.plugin.settings.excludePatterns = value
						.split('\n')
						.map((p) => p.trim())
						.filter((p) => p.length > 0);
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
				});
			});

		new Setting(containerEl)
			.setName('Sync hidden folders')
			.setDesc(
				'One glob per line, each starting with a dot-prefixed folder (for example .claude/**). '
				+ 'Obsidian hides these from its vault index, so they sync as plain files and never '
				+ 'appear as notes. .git, .trash and the Obsidian config folder can never be added.',
			)
			.addTextArea((text) => {
				this.hiddenPathsField = text;
				text.setPlaceholder('.claude/**\n.codex/**');
				text.setValue(this.plugin.settings.includeHiddenPaths.join('\n'));
				text.inputEl.rows = 4;
				// Validated on blur rather than per keystroke: a half-typed glob
				// is not an error, and validating as you type both saves partial
				// patterns and fires one notice per character.
				text.inputEl.addEventListener('blur', () => {
					this.applyHiddenPaths(text).catch((error: unknown) => {
						console.error('[S3 Sync] Could not save hidden paths:', error);
						new Notice('Could not save hidden folder patterns.');
					});
				});
			});

		new Setting(containerEl)
			.setName('Reset sync journal')
			.setDesc('Clears remembered sync baselines for the current bucket and region. Use this after intentionally switching destinations.')
			.addButton((button) => {
				button.setWarning();
				button.setButtonText('Reset sync journal');
				button.onClick(async () => {
					try {
						await this.plugin.resetSyncJournal();
						new Notice('Sync journal reset for the current destination.');
					} catch (error) {
						new Notice(error instanceof Error ? error.message : 'Failed to reset sync journal');
					}
				});
			});
	}
}
