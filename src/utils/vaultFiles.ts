/** Only add extensions here when they are lossless as UTF-8; binary files would corrupt. */

import { TFile, Vault } from 'obsidian';
import { VaultFileKind } from '../types';
import { getExtension } from './paths';

const TEXT_FILE_EXTENSIONS = new Set([
    'md',
    'markdown',
    'txt',
    'json',
    'canvas',
    'yaml',
    'yml',
    'csv',
    'tsv',
    'svg',
    'html',
    'htm',
    'xml',
    'opml',
    'css',
    'js',
    'cjs',
    'mjs',
    'ts',
    'tsx',
    'jsx',
    'py',
    'sh',
]);

export function getVaultFileKind(path: string): VaultFileKind {
    const extension = getExtension(path).toLowerCase();

    if (!extension) {
        return 'text';
    }

    return TEXT_FILE_EXTENSIONS.has(extension) ? 'text' : 'binary';
}

export async function readVaultFile(vault: Vault, file: TFile): Promise<string | Uint8Array> {
    if (getVaultFileKind(file.path) === 'text') {
        return await vault.read(file);
    }

    return new Uint8Array(await vault.readBinary(file));
}

/**
 * Slice a `Uint8Array` view into a compact, zero-offset `ArrayBuffer`. A view
 * may cover only part of a larger buffer, so passing `.buffer` directly to APIs
 * like S3 `PutObject` could send unexpected extra bytes.
 */
export function toArrayBuffer(content: Uint8Array): ArrayBuffer {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
}
