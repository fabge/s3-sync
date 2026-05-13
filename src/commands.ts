import type S3SyncPlugin from './main';

interface ObsidianSettingsApi {
	open: () => void;
	openTabById: (id: string) => void;
}

export function registerPluginCommands(plugin: S3SyncPlugin): void {
	plugin.addCommand({
		id: 'sync-now',
		name: 'Sync now',
		callback: async () => {
			await plugin.triggerManualSync();
		},
	});

	plugin.addCommand({
		id: 'open-settings',
		name: 'Open settings',
		callback: () => {
			const settingsApi = (
				plugin.app as unknown as { setting: ObsidianSettingsApi }
			).setting;
			settingsApi.open();
			settingsApi.openTabById('s3-sync');
		},
	});
}
