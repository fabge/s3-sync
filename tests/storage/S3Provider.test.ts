/**
 * Unit tests for S3Provider request shaping.
 */

import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Provider } from '../../src/storage/S3Provider';
import { S3SyncSettings } from '../../src/types';

function createSettings(overrides: Partial<S3SyncSettings> = {}): S3SyncSettings {
	return {
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

	it('ignores S3 folder marker objects when listing', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({
			Contents: [
				{ Key: 'notes/', Size: 0 },
				{ Key: 'notes/file.md', Size: 5 },
			],
		});
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		const objects = await provider.listObjects();

		const command = send.mock.calls[0][0] as ListObjectsV2Command;
		expect(command).toBeInstanceOf(ListObjectsV2Command);
		expect(objects.map((object) => object.key)).toEqual(['notes/file.md']);
	});

	it('passes If-Match for conditional deletes', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({});
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		await provider.deleteFile('vault/test.md', 'abc123');

		const command = send.mock.calls[0][0] as DeleteObjectCommand;
		expect(command).toBeInstanceOf(DeleteObjectCommand);
		expect(command.input.IfMatch).toBe('"abc123"');
	});
});
