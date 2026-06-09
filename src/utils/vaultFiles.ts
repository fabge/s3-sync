/**
 * Vault file read helpers. Text files are read as UTF-8 strings via
 * `vault.read()`; everything else goes through `vault.readBinary()`. Only add
 * extensions to {@link TEXT_FILE_EXTENSIONS} that are lossless as UTF-8 —
 * binary formats would be corrupted.
 */

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

/** `'text'` or `'binary'` by extension; extensionless files (e.g. `Makefile`) count as text. */
export function getVaultFileKind(path: string): VaultFileKind {
    const extension = getExtension(path).toLowerCase();

    if (!extension) {
        return 'text';
    }

    return TEXT_FILE_EXTENSIONS.has(extension) ? 'text' : 'binary';
}

/** Read a vault file via the correct API: `string` for text, `Uint8Array` for binary. */
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
