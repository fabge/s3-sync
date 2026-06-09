/**
 * Converts between vault paths and S3 keys, applying an optional sync prefix —
 * the single source of truth for the S3 key layout. All methods are pure.
 */

import { addPrefix, removePrefix, normalizePrefix } from '../utils/paths';

// Hidden dir (dot-prefixed) for plugin-internal objects; detected by isMetadataKey().
const METADATA_DIR = '.obsidian-s3-sync';

export class SyncPathCodec {
	private normalizedPrefix: string;

	/** @param syncPrefix - S3 key prefix for all vault files (`''` = bucket root). */
	constructor(syncPrefix = '') {
		this.normalizedPrefix = normalizePrefix(syncPrefix);
	}

	/** Vault path → S3 key (e.g. `Notes/a.md` → `vault/Notes/a.md`). */
	localToRemote(localPath: string): string {
		return addPrefix(localPath, this.normalizedPrefix);
	}

	/** S3 key → vault path, or `null` if the key is outside this prefix. */
	remoteToLocal(remoteKey: string): string | null {
		return removePrefix(remoteKey, this.normalizedPrefix);
	}

	/** `true` if the key is a plugin-internal metadata object, not a user file. */
	isMetadataKey(remoteKey: string): boolean {
		const relativePath = removePrefix(remoteKey, this.normalizedPrefix);
		return relativePath?.startsWith(`${METADATA_DIR}/`) ?? false;
	}

	/** Prefix (with trailing slash) for listing the sync namespace, or `''` when unprefixed. */
	getListPrefix(): string {
		return this.normalizedPrefix ? `${this.normalizedPrefix}/` : '';
	}
}
