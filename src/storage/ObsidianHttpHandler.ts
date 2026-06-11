/** AWS SDK v3 HttpHandler via Obsidian `requestUrl`; required to bypass browser CORS. */

import { requestUrl, RequestUrlParam } from 'obsidian';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import { buildQueryString } from '@smithy/querystring-builder';
import { HttpHandlerOptions } from '@smithy/types';

export class ObsidianHttpHandler {
    private requestTimeout: number;

    constructor(options?: { requestTimeout?: number }) {
        this.requestTimeout = options?.requestTimeout ?? 30000;
    }

    async handle(
        request: HttpRequest,
        _options?: HttpHandlerOptions
    ): Promise<{ response: HttpResponse }> {
        const url = this.buildUrl(request);

        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
            if (value === undefined) continue;
            // requestUrl sets Content-Length and Host itself; sending the signed
            // values too causes duplicates or AWS signature mismatches.
            const lowerKey = key.toLowerCase();
            if (lowerKey === 'content-length' || lowerKey === 'host') continue;
            headers[key] = value;
        }

        const requestParams: RequestUrlParam = {
            url,
            method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
            headers,
            // Don't throw on 4xx/5xx — return them so the SDK's error parser can
            // produce the correct typed error (NoSuchKey, AccessDenied, etc.).
            throw: false,
        };

        if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
            if (request.body instanceof Uint8Array) {
                requestParams.body = request.body.buffer.slice(
                    request.body.byteOffset,
                    request.body.byteOffset + request.body.byteLength
                );
            } else if (typeof request.body === 'string' || request.body instanceof ArrayBuffer) {
                requestParams.body = request.body;
            }
        }

        try {
            console.debug(`[S3 HTTP] ${request.method} ${url}`);
            const obsidianResponse = await requestUrl(requestParams);
            console.debug(`[S3 HTTP] Response: ${obsidianResponse.status}`);

            const responseHeaders: Record<string, string> = {};
            if (obsidianResponse.headers) {
                for (const [key, value] of Object.entries(obsidianResponse.headers)) {
                    responseHeaders[key.toLowerCase()] = value;
                }
            }

            const response = new HttpResponse({
                statusCode: obsidianResponse.status,
                headers: responseHeaders,
                body: this.createResponseBody(obsidianResponse.arrayBuffer),
            });
            return { response };
        } catch (error) {
            console.error('[S3 HTTP] Request error:', error);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Request failed: ${message}`);
        }
    }

    private buildUrl(request: HttpRequest): string {
        let protocol = request.protocol || 'https:';
        if (!protocol.endsWith(':')) protocol += ':';

        let path = request.path || '/';
        if (!path.startsWith('/')) path = '/' + path;

        let url = `${protocol}//${request.hostname}`;
        if (request.port && request.port !== 80 && request.port !== 443) {
            url += `:${request.port}`;
        }
        url += path;

        // buildQueryString uses the same escaping as the SigV4 signer; an ad-hoc
        // encodeURIComponent serialization can differ on !'()* and break signatures.
        const queryString = request.query ? buildQueryString(request.query) : '';
        if (queryString) {
            url += `?${queryString}`;
        }

        return url;
    }

    /** Browser checksum middleware expects ReadableStream when available. */
    private createResponseBody(arrayBuffer: ArrayBuffer): ReadableStream<Uint8Array> | Blob {
        if (typeof ReadableStream === 'function') {
            const chunk = new Uint8Array(arrayBuffer);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    if (chunk.byteLength > 0) controller.enqueue(chunk);
                    controller.close();
                },
            });
        }
        return new Blob([arrayBuffer]);
    }

    updateHttpClientConfig(_key: never, _value: never): void {
        // No configurable socket layer behind requestUrl.
    }

    httpHandlerConfigs(): Record<string, unknown> {
        return { requestTimeout: this.requestTimeout };
    }

    destroy(): void {
        // requestUrl manages its own lifecycle; nothing to release.
    }
}
