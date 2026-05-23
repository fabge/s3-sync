import {
	buildS3ClientConfig,
	validateConnectionSettings,
} from '../../src/storage/S3Config';
import { S3SyncSettings } from '../../src/types';

function createTestSettings(
	overrides: Partial<S3SyncSettings> = {},
): S3SyncSettings {
	return {
		provider: 'aws',
		region: 'us-east-1',
		bucket: 'test-bucket',
		accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
		secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		syncEnabled: true,
		autoSyncEnabled: true,
		syncIntervalMinutes: 5,
		syncOnStartup: true,
		excludePatterns: [],
		protectModifyPercentage: 50,
		...overrides,
	};
}

describe('S3Config', () => {
	it('builds an AWS client config with region, credentials, and request handler', () => {
		const settings = createTestSettings({ region: 'us-west-2' });
		const config = buildS3ClientConfig(settings);

		expect(config.region).toBe('us-west-2');
		expect(config.credentials).toEqual({
			accessKeyId: settings.accessKeyId,
			secretAccessKey: settings.secretAccessKey,
		});
		expect(config.requestHandler).toBeDefined();
		expect(config.endpoint).toBeUndefined();
		expect(config.forcePathStyle).toBeUndefined();
	});

	it('defaults the region to us-east-1 when empty', () => {
		const config = buildS3ClientConfig(createTestSettings({ region: '' }));
		expect(config.region).toBe('us-east-1');
	});

	it('returns no validation errors for complete AWS settings', () => {
		expect(validateConnectionSettings(createTestSettings())).toEqual([]);
	});

	it('requires bucket, access key, secret key, and region', () => {
		const errors = validateConnectionSettings(
			createTestSettings({
				bucket: '',
				accessKeyId: '',
				secretAccessKey: '',
				region: '',
			}),
		);

		expect(errors).toEqual([
			'Bucket name is required',
			'Access Key ID is required',
			'Secret Access Key is required',
			'AWS S3 requires a region',
		]);
	});

});
