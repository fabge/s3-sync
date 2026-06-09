import type { SyncUploadMetadata } from '../../src/types';
import { encodeMetadata } from '../../src/sync/SyncObjectMetadata';

describe('SyncObjectMetadata', () => {
	describe('encodeMetadata', () => {
		it('encodes sync metadata into S3 metadata headers', () => {
			const metadata: SyncUploadMetadata = {
				fingerprint: 'sha256:abc123',
				clientMtime: 1712345678901,
				deviceId: 'device-1',
			};

			expect(encodeMetadata(metadata)).toEqual({
				'obsidian-fingerprint': 'sha256:abc123',
				'obsidian-mtime': '1712345678901',
				'obsidian-device-id': 'device-1',
			});
		});
	});
});
