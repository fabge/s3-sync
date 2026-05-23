import { App } from 'obsidian';

const DEVICE_ID_STORAGE_KEY = 's3-sync-device-id';

export function getOrCreateDeviceId(app: App): string {
	const existing: unknown = app.loadLocalStorage(DEVICE_ID_STORAGE_KEY);
	if (typeof existing === 'string' && existing.trim().length > 0) {
		return existing;
	}

	const deviceId = crypto.randomUUID();
	app.saveLocalStorage(DEVICE_ID_STORAGE_KEY, deviceId);
	return deviceId;
}
