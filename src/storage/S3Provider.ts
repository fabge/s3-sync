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
import { S3DownloadResult, S3HeadResult, S3ObjectInfo, S3SyncSettings } from '../types';
import { normalizeEntityTag } from '../utils/etags';
import { ObsidianHttpHandler } from './ObsidianHttpHandler';

function buildS3ClientConfig(settings: S3SyncSettings): S3ClientConfig {
    return {
        region: settings.region || 'eu-central-1',
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
        requestHandler: new ObsidianHttpHandler({ requestTimeout: 30000 }),
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
        this.settings = settings;
        this.client = client ?? null;
    }

    updateSettings(settings: S3SyncSettings): void {
        this.settings = settings;
        this.client = null;
    }

    private getClient(): S3Client {
        if (!this.client) {
            this.client = new S3Client(buildS3ClientConfig(this.settings));
        }
        return this.client;
    }

    async testConnection(): Promise<string> {
        const errors = validateConnectionSettings(this.settings);
        if (errors.length > 0) {
            throw new Error(`Configuration errors: ${errors.join(', ')}`);
        }

        try {
            await this.getClient().send(new HeadBucketCommand({
                Bucket: this.settings.bucket,
            }));
            return `Connected successfully to ${this.settings.bucket}`;
        } catch (error) {
            const err = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };

            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                throw new Error(`Bucket "${this.settings.bucket}" not found`);
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
                throw new Error('Could not reach endpoint. Check your endpoint URL and network connection.');
            }
            throw new Error(`Connection failed: ${err.message || 'Unknown error'}`);
        }
    }

    async listObjects(prefix: string, recursive = true): Promise<S3ObjectInfo[]> {
        const client = this.getClient();
        const objects: S3ObjectInfo[] = [];
        let continuationToken: string | undefined;

        do {
            const response: ListObjectsV2CommandOutput = await client.send(new ListObjectsV2Command({
                Bucket: this.settings.bucket,
                Prefix: prefix,
                Delimiter: recursive ? undefined : '/',
                ContinuationToken: continuationToken,
            }));

            for (const item of response.Contents ?? []) {
                if (item.Key) {
                    objects.push({
                        key: item.Key,
                        size: item.Size || 0,
                        lastModified: item.LastModified || new Date(),
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
        try {
            const response = await this.getClient().send(new GetObjectCommand({
                Bucket: this.settings.bucket,
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

    /** Normalize AWS SDK response bodies across Obsidian/Electron and tests. */
    private async bodyToUint8Array(body: unknown, key: string): Promise<Uint8Array> {
        const responseBody = body as
            | Uint8Array
            | ArrayBuffer
            | Blob
            | ReadableStream<Uint8Array>
            | { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }
            | { transformToByteArray?: () => Promise<Uint8Array> }
            | string;
        type ByteArrayTransformable = { transformToByteArray: () => Promise<Uint8Array> };

        if (responseBody instanceof Uint8Array) {
            return responseBody;
        }
        if (responseBody instanceof ArrayBuffer) {
            return new Uint8Array(responseBody);
        }
        if (typeof responseBody === 'string') {
            return new TextEncoder().encode(responseBody);
        }
        if (typeof responseBody === 'object' && responseBody !== null && 'transformToByteArray' in responseBody) {
            const transformableBody = responseBody as ByteArrayTransformable;
            if (typeof transformableBody.transformToByteArray === 'function') {
                return await transformableBody.transformToByteArray();
            }
        }
        if (responseBody instanceof Blob) {
            return new Uint8Array(await responseBody.arrayBuffer());
        }

        const chunks: Uint8Array[] = [];

        if (typeof responseBody === 'object' && responseBody !== null && 'getReader' in responseBody && typeof responseBody.getReader === 'function') {
            const reader = responseBody.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
            }
        } else if (typeof responseBody === 'object' && responseBody !== null && Symbol.asyncIterator in responseBody) {
            for await (const chunk of responseBody as { [Symbol.asyncIterator](): AsyncIteratorLike<Uint8Array> }) {
                chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            }
        } else {
            throw new Error(`Unsupported response body type for key: ${key}`);
        }

        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    async headObject(key: string): Promise<S3HeadResult | null> {
        try {
            const response = await this.getClient().send(new HeadObjectCommand({
                Bucket: this.settings.bucket,
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
        ContentLength?: number;
        LastModified?: Date;
        Metadata?: Record<string, string>;
    }): S3HeadResult {
        const metadata = response.Metadata ?? {};
        return {
            etag: normalizeEntityTag(response.ETag),
            size: response.ContentLength || 0,
            lastModified: response.LastModified?.getTime() || 0,
            fingerprint: metadata['obsidian-fingerprint'],
            clientMtime: this.parseMetadataNumber(metadata['obsidian-mtime']),
            deviceId: metadata['obsidian-device-id'],
        };
    }

    private parseMetadataNumber(value?: string): number | undefined {
        if (!value) {
            return undefined;
        }
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    /** Upload with optional conditional headers; ETag quotes are re-added for S3. */
	async uploadFile(
		key: string,
		content: Uint8Array | string,
		options?: { contentType?: string; ifMatch?: string; ifNoneMatch?: string; metadata?: Record<string, string> }
	): Promise<string> {
        const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;

        const response = await this.getClient().send(new PutObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
            Body: body,
            ContentType: options?.contentType,
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

    async deleteFile(key: string): Promise<void> {
        await this.getClient().send(new DeleteObjectCommand({
            Bucket: this.settings.bucket,
            Key: key,
        }));
    }

    destroy(): void {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
    }
}

interface AsyncIteratorLike<T> {
    next(): Promise<IteratorResult<T>>;
}
