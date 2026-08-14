import { VaultEntry, VaultFile, VaultLike } from '../../src/types';
import { isHiddenPath } from '../../src/utils/paths';

export interface FakeVault extends VaultLike {
	/** Paths written through the hidden (adapter) route rather than the index. */
	hiddenWrites: string[];
	/** Paths trashed through the hidden route. */
	hiddenTrashed: string[];
	addHidden(path: string, mtime?: number, size?: number): VaultFile;
}

/**
 * Mirrors the routing rule in ObsidianVault: hidden paths are served from a
 * separate store, exactly as the real adapter serves them from outside the
 * vault index. Without this split a "hidden path" test proves nothing, since
 * the visible mock answers every lookup regardless of path shape.
 */
export function createFakeVault(index: Map<string, VaultEntry>): FakeVault {
	const hidden = new Map<string, VaultFile>();
	const hiddenWrites: string[] = [];
	const hiddenTrashed: string[] = [];

	const lookup = (path: string): VaultEntry | null =>
		(isHiddenPath(path) ? hidden.get(path) : index.get(path)) ?? null;

	return {
		hiddenWrites,
		hiddenTrashed,
		configDir: '.obsidian',
		addHidden(path, mtime = 100, size = 10) {
			const file: VaultFile = { path, stat: { mtime, size } };
			hidden.set(path, file);
			return file;
		},
		getFiles: () => [...index.values()].filter((entry): entry is VaultFile => 'stat' in entry),
		getHiddenFiles: () => Promise.resolve([...hidden.values()]),
		getAbstractFileByPath: (path) => Promise.resolve(lookup(path)),
		readBinary: () => Promise.resolve(new ArrayBuffer(0)),
		modifyBinary: (file) => {
			if (isHiddenPath(file.path)) hiddenWrites.push(file.path);
			return Promise.resolve();
		},
		createBinary: (path) => {
			if (isHiddenPath(path)) {
				hiddenWrites.push(path);
				hidden.set(path, { path, stat: { mtime: 1, size: 1 } });
			}
			return Promise.resolve();
		},
		createFolder: (path) => Promise.resolve({ path }),
		rename: () => Promise.resolve(),
		trashFile: (file) => {
			if (isHiddenPath(file.path)) {
				hiddenTrashed.push(file.path);
				hidden.delete(file.path);
			}
			return Promise.resolve();
		},
	};
}
