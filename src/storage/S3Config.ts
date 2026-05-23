/**
 * S3 configuration for the AWS-only build.
 *
 * The rebuilt plugin intentionally targets AWS S3 only, so the client config is
 * much simpler than the upstream comparison repo's provider matrix. We still use
 * Obsidian's requestUrl-backed HTTP handler to avoid browser CORS issues.
 */

import { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3SyncSettings } from '../types';
import { ObsidianHttpHandler } from './ObsidianHttpHandler';

export function buildS3ClientConfig(settings: S3SyncSettings): S3ClientConfig {
    return {
        region: settings.region || 'eu-central-1',
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
        requestHandler: new ObsidianHttpHandler({
            requestTimeout: 30000,
        }),
    };
}

export function validateConnectionSettings(settings: S3SyncSettings): string[] {
    const errors: string[] = [];

    if (!settings.bucket) {
        errors.push('Bucket name is required');
    }

    if (!settings.accessKeyId) {
        errors.push('Access Key ID is required');
    }

    if (!settings.secretAccessKey) {
        errors.push('Secret Access Key is required');
    }

    if (!settings.region) {
        errors.push('AWS S3 requires a region');
    }

    return errors;
}
