/** Converts between vault paths and bucket-root S3 keys. */

// Hidden dir (dot-prefixed) for plugin-internal objects; detected by isMetadataKey().
export const METADATA_DIR = '.obsidian-s3-sync';

/** Vault paths are already normalized (forward slashes, no leading slash). */
export function localToRemote(localPath: string): string {
	return localPath;
}

/**
 * Returns null for keys that cannot round-trip as safe vault paths
 * (backslashes, empty segments, leading slashes, `.`/`..` traversal) —
 * such foreign objects are left untouched.
 */
export function remoteToLocal(remoteKey: string): string | null {
	if (remoteKey.includes('\\')) {
		return null;
	}

	const segments = remoteKey.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return null;
	}

	return remoteKey;
}

export function isMetadataKey(remoteKey: string): boolean {
	return remoteKey.startsWith(`${METADATA_DIR}/`);
}
