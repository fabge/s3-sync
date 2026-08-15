/** Sync I/O always uses raw bytes so no encoding round-trip can corrupt files. */

import { VaultFile, VaultLike } from '../types';

export async function readVaultFile(vault: VaultLike, file: VaultFile): Promise<Uint8Array> {
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
