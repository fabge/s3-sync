import { isMetadataKey, localToRemote, remoteToLocal } from '../../src/sync/SyncPathCodec';

describe('SyncPathCodec', () => {
	const metadataDir = '.obsidian-s3-sync';

	describe('localToRemote', () => {
		it('uses vault paths directly as bucket-root remote keys', () => {
			expect(localToRemote('Notes/daily.md')).toBe('Notes/daily.md');
		});
	});

	describe('remoteToLocal', () => {
		it('round-trips safe keys unchanged', () => {
			expect(remoteToLocal('Notes/daily.md')).toBe('Notes/daily.md');
			expect(localToRemote(remoteToLocal('Notes/daily.md')!)).toBe('Notes/daily.md');
		});

		it('rejects keys containing backslashes', () => {
			expect(remoteToLocal('Notes\\daily.md')).toBeNull();
		});

		it('rejects keys with leading slashes or empty segments', () => {
			expect(remoteToLocal('/Notes/daily.md')).toBeNull();
			expect(remoteToLocal('Notes//daily.md')).toBeNull();
		});

		it('rejects keys with traversal segments', () => {
			expect(remoteToLocal('../escape.md')).toBeNull();
			expect(remoteToLocal('Notes/../escape.md')).toBeNull();
			expect(remoteToLocal('Notes/./daily.md')).toBeNull();
		});

		it('keeps dot-prefixed but non-traversal segments', () => {
			expect(remoteToLocal('.obsidian/app.json')).toBe('.obsidian/app.json');
		});
	});

	describe('isMetadataKey', () => {
		it('returns true for metadata files', () => {
			expect(isMetadataKey(`${metadataDir}/engine.json`)).toBe(true);
		});

		it('returns false for non-metadata files', () => {
			expect(isMetadataKey('Notes/daily.md')).toBe(false);
		});

		it('returns false for the metadata directory root itself', () => {
			expect(isMetadataKey(metadataDir)).toBe(false);
		});
	});
});
