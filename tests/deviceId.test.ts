import { App } from 'obsidian';
import { getOrCreateDeviceId } from '../src/deviceId';

describe('getOrCreateDeviceId', () => {
	it('reuses an existing vault-local device ID', () => {
		const app = new App();
		app.saveLocalStorage('s3-sync-device-id', 'device-existing');

		const result = getOrCreateDeviceId(app);

		expect(result).toBe('device-existing');
	});

	it('generates a fresh device ID when none exists', () => {
		const app = new App();
		jest
			.spyOn(global.crypto, 'randomUUID')
			.mockReturnValue('11111111-2222-4333-8444-555555555555');

		const result = getOrCreateDeviceId(app);

		expect(result).toBe('11111111-2222-4333-8444-555555555555');
		expect(app.loadLocalStorage('s3-sync-device-id')).toBe('11111111-2222-4333-8444-555555555555');
	});
});
