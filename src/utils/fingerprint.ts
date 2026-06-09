/** SHA-256 content fingerprint, prefixed `sha256:`, used as the authoritative content identity. */
export async function fingerprint(content: string | Uint8Array): Promise<string> {
	const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `sha256:${hex}`;
}
