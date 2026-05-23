import { computeDestinationFingerprint } from '../../src/sync/DestinationFingerprint';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('computeDestinationFingerprint', () => {
	it('uses only bucket and region', () => {
		const base = computeDestinationFingerprint({
			...DEFAULT_SETTINGS,
			bucket: 'vault-a',
			region: 'eu-central-1',
		});

		const sameDestination = computeDestinationFingerprint({
			...DEFAULT_SETTINGS,
			bucket: 'vault-a',
			region: 'eu-central-1',
			accessKeyId: 'different',
			secretAccessKey: 'different',
			autoSyncEnabled: false,
		});

		const changedBucket = computeDestinationFingerprint({
			...DEFAULT_SETTINGS,
			bucket: 'vault-b',
			region: 'eu-central-1',
		});

		expect(sameDestination).toBe(base);
		expect(changedBucket).not.toBe(base);
	});
});
