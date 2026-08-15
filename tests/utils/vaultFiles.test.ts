jest.mock('obsidian');

import { TFile, Vault } from 'obsidian';
import { readVaultFile, toArrayBuffer } from '../../src/utils/vaultFiles';
import { VaultLike } from '../../src/types';

class MockTFile extends TFile {}

function createFile(path: string): TFile {
    const file = new MockTFile();
    file.path = path;
    return file;
}

describe('vaultFiles', () => {
    describe('readVaultFile', () => {
        it('reads every file as raw bytes through vault.readBinary', async () => {
            const vault = new Vault();
            const file = createFile('note.md');
            const bytes = new Uint8Array([1, 2, 3, 4]);
            const readSpy = jest.spyOn(vault, 'read');
            const binarySpy = jest.spyOn(vault, 'readBinary').mockResolvedValue(bytes.buffer);

            const result = await readVaultFile(vault as unknown as VaultLike, file);

            expect(result).toBeInstanceOf(Uint8Array);
            expect(Array.from(result)).toEqual([1, 2, 3, 4]);
            expect(readSpy).not.toHaveBeenCalled();
            expect(binarySpy).toHaveBeenCalledWith(file);
        });
    });

    describe('toArrayBuffer', () => {
        it('returns a matching ArrayBuffer', () => {
            const content = new Uint8Array([10, 20, 30]);

            const buffer = toArrayBuffer(content);

            expect(buffer).toBeInstanceOf(ArrayBuffer);
            expect(Array.from(new Uint8Array(buffer))).toEqual([10, 20, 30]);
        });
    });
});
