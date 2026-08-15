/** S3 adapter. Uses ObsidianHttpHandler for CORS-safe requests and normalizes ETags. */

import {
    S3Client,
    S3ClientConfig,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { cloneSettings, S3DownloadResult, S3HeadResult, S3ObjectInfo, S3SyncSettings } from '../types';
import { normalizeEntityTag } from '../utils/etags';
import { ObsidianHttpHandler } from './ObsidianHttpHandler';

function buildS3ClientConfig(settings: S3SyncSettings): S3ClientConfig {
    return {
        region: settings.region || 'eu-central-1',
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
		requestHandler: new ObsidianHttpHandler(),
    };
}

function validateConnectionSettings(settings: S3SyncSettings): string[] {
    const errors: string[] = [];
    if (!settings.bucket) errors.push('Bucket name is required');
    if (!settings.accessKeyId) errors.push('Access Key ID is required');
    if (!settings.secretAccessKey) errors.push('Secret Access Key is required');
    if (!settings.region) errors.push('AWS S3 requires a region');
    return errors;
}

export class S3Provider {
    private client: S3Client | null = null;
    private settings: S3SyncSettings;

    constructor(settings: S3SyncSettings, client?: S3Client) {
        this.settings = cloneSettings(settings);
        this.client = client ?? null;
    }

    updateSettings(settings: S3SyncSettings): void {
        this.settings = cloneSettings(settings);
        this.client = null;
    }

    private getClient(): S3Client {
        if (!this.client) {
            this.client = new S3Client(buildS3ClientConfig(this.settings));
        }
        return this.client;
    }

    async testConnection(): Promise<string> {
        const settings = this.settings;
        const errors = validateConnectionSettings(settings);
        if (errors.length > 0) {
            throw new Error(`Configuration errors: ${errors.join(', ')}`);
        }

        try {
            await this.getClient().send(new HeadBucketCommand({
                Bucket: settings.bucket,
            }));
            return `Connected successfully to ${settings.bucket}`;
        } catch (error) {
            const err = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };

            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                throw new Error(`Bucket "${settings.bucket}" not found`);
            }
            if (err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) {
                throw new Error('Access denied. Check your credentials and bucket permissions.');
            }
            if (err.name === 'InvalidAccessKeyId') {
                throw new Error('Invalid Access Key ID');
            }
            if (err.name === 'SignatureDoesNotMatch') {
                throw new Error('Invalid Secret Access Key');
            }
            if (err.message?.includes('ENOTFOUND') || err.message?.includes('getaddrinfo')) {
                throw new Error('Could not reach S3. Check the region and your network connection.');
            }
            throw new Error(`Connection failed: ${err.message || 'Unknown error'}`);
        }
    }

    async listObjects(): Promise<S3ObjectInfo[]> {
        const settings = this.settings;
        const client = this.getClient();
        const objects: S3ObjectInfo[] = [];
        let continuationToken: string | undefined;

        do {
            const response: ListObjectsV2CommandOutput = await client.send(new ListObjectsV2Command({
                Bucket: settings.bucket,
                ContinuationToken: continuationToken,
            }));

            for (const item of response.Contents ?? []) {
                if (item.Key && !item.Key.endsWith('/')) {
                    objects.push({
                        key: item.Key,
                        etag: item.ETag,
                    });
                }
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        return objects;
    }

    /** Get content and metadata together to avoid a separate head+get race. */
    async downloadFileWithMetadata(key: string): Promise<S3DownloadResult | null> {
        const settings = this.settings;
        try {
            const response = await this.getClient().send(new GetObjectCommand({
                Bucket: settings.bucket,
                Key: key,
            }));

            if (!response.Body) {
                throw new Error(`Empty response for key: ${key}`);
            }

            const content = await this.bodyToUint8Array(response.Body, key);
            return { content, ...this.toS3HeadResult(response) };
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    /** ObsidianHttpHandler produces ReadableStream bodies, or Blob where streams are unavailable. */
    private async bodyToUint8Array(body: unknown, key: string): Promise<Uint8Array> {
        if (body instanceof Blob) {
            return new Uint8Array(await body.arrayBuffer());
        }
        if (typeof ReadableStream === 'function' && body instanceof ReadableStream) {
            return new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer());
        }
        throw new Error(`Unsupported response body type for key: ${key}`);
    }

    async headObject(key: string): Promise<S3HeadResult | null> {
        const settings = this.settings;
        try {
            const response = await this.getClient().send(new HeadObjectCommand({
                Bucket: settings.bucket,
                Key: key,
            }));
            return this.toS3HeadResult(response);
        } catch (error) {
            const err = error as Error & { name?: string };
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return null;
            }
            throw error;
        }
    }

    private toS3HeadResult(response: {
        ETag?: string;
        Metadata?: Record<string, string>;
    }): S3HeadResult {
        const metadata = response.Metadata ?? {};
        return {
            etag: normalizeEntityTag(response.ETag),
            fingerprint: metadata['obsidian-fingerprint'],
        };
    }

    /** Upload with optional conditional headers; ETag quotes are re-added for S3. */
    async uploadFile(
        key: string,
        content: Uint8Array,
		options?: { ifMatch?: string; ifNoneMatch?: string; metadata?: Record<string, string> }
    ): Promise<string> {
        const settings = this.settings;

        const response = await this.getClient().send(new PutObjectCommand({
            Bucket: settings.bucket,
            Key: key,
            Body: content,
            IfMatch: this.toConditionalEntityTag(options?.ifMatch),
            IfNoneMatch: this.toConditionalEntityTag(options?.ifNoneMatch),
            Metadata: options?.metadata,
        }));

        return normalizeEntityTag(response.ETag);
    }

    private toConditionalEntityTag(etag?: string): string | undefined {
        if (!etag) {
            return undefined;
        }
        if (etag === '*') {
            return etag;
        }
        return `"${normalizeEntityTag(etag)}"`;
    }

    async deleteFile(key: string, ifMatch?: string): Promise<void> {
        const settings = this.settings;
        await this.getClient().send(new DeleteObjectCommand({
            Bucket: settings.bucket,
            Key: key,
            IfMatch: this.toConditionalEntityTag(ifMatch),
        }));
    }

    destroy(): void {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
    }
}
