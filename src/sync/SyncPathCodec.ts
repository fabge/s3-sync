/** Converts between vault paths and bucket-root S3 keys. */

// Hidden dir (dot-prefixed) for plugin-internal objects; detected by isMetadataKey().
const METADATA_DIR = '.obsidian-s3-sync';

export class SyncPathCodec {
	localToRemote(localPath: string): string {
		return localPath.replace(/\\/g, '/').replace(/^\/+/, '');
	}

	remoteToLocal(remoteKey: string): string {
		return remoteKey.replace(/\\/g, '/');
	}

	isMetadataKey(remoteKey: string): boolean {
		return this.remoteToLocal(remoteKey).startsWith(`${METADATA_DIR}/`);
	}

	getListPrefix(): string {
		return '';
	}
}
