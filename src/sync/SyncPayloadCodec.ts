import { PayloadFormat } from '../types';

export class SyncPayloadCodec {
	getActivePayloadFormat(): PayloadFormat {
		return 'plaintext-v1';
	}

	async fingerprint(plaintext: string | Uint8Array): Promise<string> {
		const bytes = typeof plaintext === 'string'
			? new TextEncoder().encode(plaintext)
			: plaintext;
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		const hex = Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		return `sha256:${hex}`;
	}

	encodeForUpload(plaintext: string | Uint8Array): Uint8Array {
		return typeof plaintext === 'string'
			? new TextEncoder().encode(plaintext)
			: plaintext;
	}

	decodeAfterDownload(payload: Uint8Array, payloadFormat?: string): Uint8Array {
		if (payloadFormat && payloadFormat !== 'plaintext-v1') {
			throw new Error(`Unsupported payload format: ${payloadFormat}`);
		}
		return payload;
	}

	decodeToString(payload: Uint8Array, payloadFormat?: string): string {
		const bytes = this.decodeAfterDownload(payload, payloadFormat);
		return new TextDecoder().decode(bytes);
	}
}
