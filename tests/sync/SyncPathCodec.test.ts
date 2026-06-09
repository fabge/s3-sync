import { SyncPathCodec } from '../../src/sync/SyncPathCodec';

describe('SyncPathCodec', () => {
	const metadataDir = '.obsidian-s3-sync';

	describe('localToRemote', () => {
		it('normalizes local paths as bucket-root remote keys', () => {
			const codec = new SyncPathCodec();

			expect(codec.localToRemote('/Notes\\daily.md')).toBe('Notes/daily.md');
		});
	});

	describe('remoteToLocal', () => {
		it('normalizes remote keys as local paths', () => {
			const codec = new SyncPathCodec();

			expect(codec.remoteToLocal('Notes\\daily.md')).toBe('Notes/daily.md');
		});
	});

	describe('isMetadataKey', () => {
		it('returns true for metadata files', () => {
			const codec = new SyncPathCodec();

			expect(codec.isMetadataKey(`${metadataDir}/engine.json`)).toBe(true);
		});

		it('returns false for non-metadata files', () => {
			const codec = new SyncPathCodec();

			expect(codec.isMetadataKey('Notes/daily.md')).toBe(false);
		});

		it('returns false for the metadata directory root itself', () => {
			const codec = new SyncPathCodec();

			expect(codec.isMetadataKey(metadataDir)).toBe(false);
		});
	});

	describe('getListPrefix', () => {
		it('lists from the bucket root', () => {
			const codec = new SyncPathCodec();

			expect(codec.getListPrefix()).toBe('');
		});
	});

});
