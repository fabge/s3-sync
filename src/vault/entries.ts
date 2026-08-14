/** Discriminates the vault entry union without depending on Obsidian's classes. */

import { VaultEntry, VaultFile, VaultFolder } from '../types';

export function isVaultFile(entry: VaultEntry | null): entry is VaultFile {
	return !!entry && 'stat' in entry;
}

export function isVaultFolder(entry: VaultEntry | null): entry is VaultFolder {
	return !!entry && !isVaultFile(entry);
}
