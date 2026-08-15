/** AWS SDK v3 HttpHandler via Obsidian `requestUrl`; required to bypass browser CORS. */

import { requestUrl, RequestUrlParam } from 'obsidian';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import { buildQueryString } from '@smithy/querystring-builder';

export class ObsidianHttpHandler {
	async handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
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

		const obsidianResponse = await requestUrl(requestParams);

        const responseHeaders: Record<string, string> = {};
        if (obsidianResponse.headers) {
            for (const [key, value] of Object.entries(obsidianResponse.headers)) {
                responseHeaders[key.toLowerCase()] = value;
            }
        }

        return {
            response: new HttpResponse({
                statusCode: obsidianResponse.status,
                headers: responseHeaders,
                body: this.createResponseBody(obsidianResponse.arrayBuffer),
            }),
        };
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

}
