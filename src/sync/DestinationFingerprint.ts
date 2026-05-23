import { S3SyncSettings } from '../types';

export function computeDestinationFingerprint(settings: S3SyncSettings): string {
	return JSON.stringify({
		bucket: settings.bucket,
		region: settings.region,
	});
}
