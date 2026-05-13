/**
 * Encodes custom S3 object metadata for sync uploads.
 *
 * S3 custom metadata keys are lowercased by most providers, so we use
 * lowercase keys consistently. The AWS SDK automatically prepends the
 * `x-amz-meta-` prefix when sending; callers work with the bare key names.
 *
 * Decoding is performed inline in `S3Provider` against these same keys.
 */

import { SyncUploadMetadata } from '../types';

/** Current sync metadata schema version written to every uploaded object. */
const SYNC_VERSION = 2;

const KEY_SYNC_VERSION = 'obsidian-sync-version';
const KEY_FINGERPRINT = 'obsidian-fingerprint';
const KEY_MTIME = 'obsidian-mtime';
const KEY_DEVICE_ID = 'obsidian-device-id';
const KEY_PAYLOAD_FORMAT = 'obsidian-payload-format';

/**
 * Serialises a `SyncUploadMetadata` record into the flat string dictionary
 * that the AWS SDK accepts as S3 custom metadata. Numeric values become
 * decimal strings because S3 metadata values must be strings.
 */
export function encodeMetadata(meta: SyncUploadMetadata): Record<string, string> {
	return {
		[KEY_SYNC_VERSION]: String(SYNC_VERSION),
		[KEY_FINGERPRINT]: meta.fingerprint,
		[KEY_MTIME]: String(meta.clientMtime),
		[KEY_DEVICE_ID]: meta.deviceId,
		[KEY_PAYLOAD_FORMAT]: meta.payloadFormat,
	};
}
