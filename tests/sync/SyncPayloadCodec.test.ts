import { SyncPayloadCodec } from '../../src/sync/SyncPayloadCodec';

describe('SyncPayloadCodec', () => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	it('always reports plaintext-v1 as the active payload format', () => {
		const codec = new SyncPayloadCodec();
		expect(codec.getActivePayloadFormat()).toBe('plaintext-v1');
	});

	it('returns a sha256-prefixed fingerprint for string input', async () => {
		const codec = new SyncPayloadCodec();
		await expect(codec.fingerprint('plain text')).resolves.toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it('returns a sha256-prefixed fingerprint for binary input', async () => {
		const codec = new SyncPayloadCodec();
		await expect(codec.fingerprint(Uint8Array.from([1, 2, 3]))).resolves.toMatch(
			/^sha256:[a-f0-9]{64}$/,
		);
	});

	it('encodes string input as UTF-8 bytes', () => {
		const codec = new SyncPayloadCodec();
		expect(codec.encodeForUpload('hello')).toEqual(encoder.encode('hello'));
	});

	it('returns binary input unchanged on upload', () => {
		const codec = new SyncPayloadCodec();
		const payload = Uint8Array.from([4, 5, 6]);
		expect(codec.encodeForUpload(payload)).toBe(payload);
	});

	it('returns plaintext payloads unchanged after download', () => {
		const codec = new SyncPayloadCodec();
		const payload = Uint8Array.from([7, 8, 9]);
		expect(codec.decodeAfterDownload(payload)).toBe(payload);
	});

	it('throws for unsupported payload formats', () => {
		const codec = new SyncPayloadCodec();
		expect(() =>
			codec.decodeAfterDownload(Uint8Array.from([1, 2, 3]), 'xsalsa20poly1305-v1'),
		).toThrow('Unsupported payload format: xsalsa20poly1305-v1');
	});

	it('decodes UTF-8 payloads to strings', () => {
		const codec = new SyncPayloadCodec();
		expect(codec.decodeToString(encoder.encode('plain text'))).toBe(
			decoder.decode(encoder.encode('plain text')),
		);
	});
});
