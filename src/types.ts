/** Type definitions for the minimal AWS-only sync build. */

export type SyncIntervalMinutes = 1 | 2 | 5 | 10 | 15 | 30;

export interface S3SyncSettings {
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	syncEnabled: boolean;
	autoSyncEnabled: boolean;
	syncIntervalMinutes: SyncIntervalMinutes;
	syncOnStartup: boolean;
	excludePatterns: string[];
	/**
	 * Globs opting dot-prefixed paths into sync. Obsidian hides these from its
	 * vault index, so they are enumerated and transferred through the vault
	 * adapter and never become notes. Empty means no hidden path syncs.
	 */
	includeHiddenPaths: string[];
	protectModifyPercentage: number;
}

export const DEFAULT_SETTINGS: S3SyncSettings = {
	region: 'eu-central-1',
	bucket: '',
	accessKeyId: '',
	secretAccessKey: '',
	syncEnabled: false,
	autoSyncEnabled: false,
	syncIntervalMinutes: 5,
	syncOnStartup: false,
	excludePatterns: [],
	includeHiddenPaths: [],
	protectModifyPercentage: 50,
};

export function cloneSettings(settings: S3SyncSettings): S3SyncSettings {
	return {
		...settings,
		excludePatterns: [...settings.excludePatterns],
		includeHiddenPaths: [...settings.includeHiddenPaths],
	};
}

export type VaultFileKind = 'text' | 'binary';

export type SyncAction =
	| 'skip'
	| 'adopt'
	| 'upload'
	| 'download'
	| 'delete-local'
	| 'delete-remote'
	| 'conflict'
	| 'forget';

export type ConflictMode = 'both' | 'local-only' | 'remote-only';

export interface SyncStateRecord {
	path: string;
	contentFingerprint: string;
	localMtime: number;
	localSize: number;
	remoteEtag?: string;
}

export interface ConflictRecord {
	path: string;
	mode: ConflictMode;
	localArtifactPath?: string;
	remoteArtifactPath?: string;
}

export interface SyncPlanItem {
	path: string;
	action: SyncAction;
	conflictMode?: ConflictMode;
	expectedRemoteEtag?: string;
	expectRemoteAbsent?: boolean;
	expectedLocalMtime?: number;
	expectedLocalSize?: number;
	expectLocalAbsent?: boolean;
}

export interface SyncResult {
	success: boolean;
	startedAt: number;
	completedAt: number;
	filesUploaded: number;
	filesDownloaded: number;
	filesDeleted: number;
	conflicts: string[];
	errors: SyncError[];
}

export interface SyncError {
	path: string;
	action: SyncAction;
	message: string;
	recoverable: boolean;
}

export type LocalClassification = 'L0' | 'L+' | 'L=' | 'LΔ';
export type RemoteClassification = 'R0' | 'R+' | 'R=' | 'RΔ';

export interface DecisionInput {
	path: string;
	local: LocalClassification;
	remote: RemoteClassification;
	hasUnresolvedConflict: boolean;
	hasConflictArtifacts: boolean;
	localFingerprint?: string;
	remoteFingerprint?: string;
}

export interface S3HeadResult {
	etag: string;
	fingerprint?: string;
}

export interface S3DownloadResult {
	content: Uint8Array;
	etag: string;
	fingerprint?: string;
}

export type SyncStatus =
	| 'idle'
	| 'synced'
	| 'syncing'
	| 'error'
	| 'conflicts'
	| 'disabled';

export interface SyncState {
	status: SyncStatus;
	lastSyncTime: number | null;
	conflictCount: number;
	lastError: string | null;
}

export interface S3ObjectInfo {
	key: string;
	etag?: string;
}

/**
 * Structural vault contract shared by the index-backed Obsidian vault and the
 * adapter-backed access used for allowlisted hidden paths. The sync core
 * depends on this instead of Obsidian's classes so neither path has to
 * masquerade as the other.
 */
export interface VaultFile {
	path: string;
	stat: { mtime: number; size: number };
}

export interface VaultFolder {
	path: string;
}

export type VaultEntry = VaultFile | VaultFolder;

export interface VaultLike {
	readonly configDir: string;
	getFiles(): VaultFile[];
	/** Allowlisted dot-prefixed files, which `getFiles` can never return. */
	getHiddenFiles(patterns: string[]): Promise<VaultFile[]>;
	getAbstractFileByPath(path: string): Promise<VaultEntry | null>;
	readBinary(file: VaultFile): Promise<ArrayBuffer>;
	modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void>;
	createBinary(path: string, data: ArrayBuffer): Promise<void>;
	createFolder(path: string): Promise<VaultFolder>;
	rename(entry: VaultEntry, newPath: string): Promise<void>;
	trashFile(file: VaultFile): Promise<void>;
}
