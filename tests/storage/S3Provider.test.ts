/**
 * Unit tests for S3Provider request shaping.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Provider } from '../../src/storage/S3Provider';
import { S3SyncSettings } from '../../src/types';

function createSettings(overrides: Partial<S3SyncSettings> = {}): S3SyncSettings {
	return {
		provider: 'aws',
		region: 'us-east-1',
		bucket: 'test-bucket',
		accessKeyId: 'test-key',
		secretAccessKey: 'test-secret',
		syncEnabled: true,
		autoSyncEnabled: false,
		syncIntervalMinutes: 5,
		syncOnStartup: false,
		excludePatterns: [],
		protectModifyPercentage: 100,
		...overrides,
	};
}

describe('S3Provider', () => {
	it('quotes If-Match ETags for conditional uploads', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: '"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		const etag = await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: 'abc123',
			ifNoneMatch: '*',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command).toBeInstanceOf(PutObjectCommand);
		expect(command.input.IfMatch).toBe('"abc123"');
		expect(command.input.IfNoneMatch).toBe('*');
		expect(etag).toBe('returned-etag');
	});

	it('preserves already quoted conditional ETags', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: '"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: '"abc123"',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command.input.IfMatch).toBe('"abc123"');
	});

	it('normalizes weak ETags for conditional uploads and responses', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: 'W/"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		const etag = await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: 'W/"abc123"',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command.input.IfMatch).toBe('"abc123"');
		expect(etag).toBe('returned-etag');
	});
});
