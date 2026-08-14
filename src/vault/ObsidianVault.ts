import { App, DataAdapter, TAbstractFile, TFile } from 'obsidian';
import { VaultEntry, VaultFile, VaultFolder, VaultLike } from '../types';
import { isHiddenPath } from '../utils/paths';
import { hiddenRoots, isNeverSyncable } from './hiddenPaths';

/** Config trees are shallow; this only exists to stop a symlink cycle. */
const MAX_HIDDEN_DEPTH = 16;

/**
 * Adapts Obsidian to the structural vault port.
 *
 * Two access paths live behind one interface. Ordinary notes go through the
 * index-backed vault API so Obsidian stays aware of every change. Allowlisted
 * dot-prefixed paths go through the raw adapter, because the vault index cannot
 * represent them at all — which is exactly why they never become notes, never
 * appear in search, and never enter the graph.
 *
 * Callers never choose; routing is decided per path by {@link isHiddenPath}.
 */
export function createObsidianVault(app: App): VaultLike {
	const vault = app.vault;
	const adapter: DataAdapter = vault.adapter;

	function asTFile(file: VaultFile): TFile {
		if (!(file instanceof TFile)) {
			throw new Error(`Vault entry is not an Obsidian file: ${file.path}`);
		}
		return file;
	}

	function asTAbstractFile(entry: VaultEntry): TAbstractFile {
		if (!(entry instanceof TAbstractFile)) {
			throw new Error(`Vault entry does not belong to this vault: ${entry.path}`);
		}
		return entry;
	}

	function toVaultFile(path: string, stat: { mtime: number; size: number }): VaultFile {
		return { path, stat: { mtime: stat.mtime, size: stat.size } };
	}

	/**
	 * Enumeration is all-or-nothing. A file that exists but is missing from the
	 * result reads to the planner as locally deleted, and `L0 + R=` plans a
	 * delete-remote — so a partial walk silently destroys the S3 copy. Every
	 * failure here therefore aborts the cycle instead of returning less.
	 *
	 * The adapter cannot report symlinks, so a link pointing at an ancestor
	 * would recurse forever; depth is capped, and hitting the cap is a failure
	 * rather than a truncation for the same reason.
	 */
	async function walkHidden(directory: string, found: VaultFile[], depth: number): Promise<void> {
		if (depth > MAX_HIDDEN_DEPTH) {
			throw new Error(
				`Hidden path nesting exceeds ${MAX_HIDDEN_DEPTH} levels at ${directory}. `
				+ 'Sync aborted rather than treating the deeper files as deleted.',
			);
		}

		const listing = await adapter.list(directory);
		const stats = await Promise.all(listing.files.map((filePath) => adapter.stat(filePath)));
		listing.files.forEach((filePath, index) => {
			const stat = stats[index];
			if (stat?.type === 'file') found.push(toVaultFile(filePath, stat));
		});

		// Pruned during the walk, not after: there is no point listing a nested
		// .git or .trash only to drop every file it yields.
		const walkable = listing.folders.filter(
			(folderPath) => !isNeverSyncable(folderPath, vault.configDir),
		);
		// Subfolders are walked one at a time. Fanning out over the whole tree
		// puts an unbounded number of concurrent calls into the adapter, which
		// matters on mobile; the files within a directory still stat together.
		for (const folderPath of walkable) {
			await walkHidden(folderPath, found, depth + 1);
		}
	}

	return {
		get configDir(): string {
			return vault.configDir;
		},

		getFiles: (): VaultFile[] => vault.getFiles(),

		getHiddenFiles: async (patterns: string[]): Promise<VaultFile[]> => {
			const found: VaultFile[] = [];
			for (const root of hiddenRoots(patterns)) {
				if (isNeverSyncable(root, vault.configDir)) continue;
				// stat alone answers both "does it exist" and "what is it".
				// Validation guarantees every root is a folder, so a file here
				// means the user replaced the folder with a file of that name.
				const stat = await adapter.stat(root);
				if (stat?.type !== 'folder') continue;
				await walkHidden(root, found, 1);
			}
			return found;
		},

		getAbstractFileByPath: async (path: string): Promise<VaultEntry | null> => {
			if (!isHiddenPath(path)) {
				return vault.getAbstractFileByPath(path);
			}
			const stat = await adapter.stat(path);
			if (!stat) return null;
			return stat.type === 'file' ? toVaultFile(path, stat) : { path };
		},

		readBinary: (file: VaultFile): Promise<ArrayBuffer> =>
			isHiddenPath(file.path)
				? adapter.readBinary(file.path)
				: vault.readBinary(asTFile(file)),

		modifyBinary: async (file: VaultFile, data: ArrayBuffer): Promise<void> => {
			if (isHiddenPath(file.path)) {
				await adapter.writeBinary(file.path, data);
				return;
			}
			await vault.modifyBinary(asTFile(file), data);
		},

		createBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
			if (isHiddenPath(path)) {
				await adapter.writeBinary(path, data);
				return;
			}
			await vault.createBinary(path, data);
		},

		createFolder: async (path: string): Promise<VaultFolder> => {
			if (!isHiddenPath(path)) {
				return vault.createFolder(path);
			}
			await adapter.mkdir(path);
			return { path };
		},

		rename: async (entry: VaultEntry, newPath: string): Promise<void> => {
			if (isHiddenPath(entry.path) || isHiddenPath(newPath)) {
				await adapter.rename(entry.path, newPath);
				return;
			}
			await vault.rename(asTAbstractFile(entry), newPath);
		},

		trashFile: async (file: VaultFile): Promise<void> => {
			// The adapter has no vault-aware trash, so hidden files go to the
			// local .trash folder rather than being removed outright.
			if (isHiddenPath(file.path)) {
				await adapter.trashLocal(file.path);
				return;
			}
			await app.fileManager.trashFile(asTFile(file));
		},
	};
}
