/**
 * Encodes custom S3 object metadata for sync uploads.
 *
 * S3 lowercases custom metadata keys and stores values as strings, so we use
 * lowercase keys and stringify numbers. The AWS SDK prepends `x-amz-meta-`;
 * callers work with the bare key names. Decoding happens inline in `S3Provider`.
 */

import { SyncUploadMetadata } from '../types';

const KEY_FINGERPRINT = 'obsidian-fingerprint';
const KEY_MTIME = 'obsidian-mtime';
const KEY_DEVICE_ID = 'obsidian-device-id';

export function encodeMetadata(meta: SyncUploadMetadata): Record<string, string> {
	return {
		[KEY_FINGERPRINT]: meta.fingerprint,
		[KEY_MTIME]: String(meta.clientMtime),
		[KEY_DEVICE_ID]: meta.deviceId,
	};
}
