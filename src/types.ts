/** Type definitions for the minimal AWS-only sync build. */

export type S3ProviderType = 'aws';

export type SyncIntervalMinutes = 1 | 2 | 5 | 10 | 15 | 30;

export interface S3SyncSettings {
	provider: S3ProviderType;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	syncEnabled: boolean;
	autoSyncEnabled: boolean;
	syncIntervalMinutes: SyncIntervalMinutes;
	syncOnStartup: boolean;
	excludePatterns: string[];
	protectModifyPercentage: number;
}

export const DEFAULT_SETTINGS: S3SyncSettings = {
	provider: 'aws',
	region: 'eu-central-1',
	bucket: '',
	accessKeyId: '',
	secretAccessKey: '',
	syncEnabled: true,
	autoSyncEnabled: true,
	syncIntervalMinutes: 5,
	syncOnStartup: true,
	excludePatterns: ['**/workspace*', '.trash/**'],
	protectModifyPercentage: 50,
};

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
	remoteKey: string;
	contentFingerprint: string;
	localMtime: number;
	localSize: number;
	remoteClientMtime: number | null;
	remoteObjectSize: number;
	remoteEtag?: string;
	remoteLastModified: number | null;
	lastWriterDeviceId?: string;
	lastSyncedAt: number;
}

export interface ConflictRecord {
	path: string;
	mode: ConflictMode;
	localArtifactPath?: string;
	remoteArtifactPath?: string;
	baselineFingerprint?: string;
	detectedAt: number;
}

export interface SyncPlanItem {
	path: string;
	action: SyncAction;
	conflictMode?: ConflictMode;
	reason: string;
	expectedRemoteEtag?: string;
	expectRemoteAbsent?: boolean;
}

export interface SyncResult {
	success: boolean;
	startedAt: number;
	completedAt: number;
	filesUploaded: number;
	filesDownloaded: number;
	filesDeleted: number;
	filesAdopted: number;
	filesForgotten: number;
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
	localExists: boolean;
	remoteExists: boolean;
	hasBaseline: boolean;
	localFingerprint?: string;
	remoteFingerprint?: string;
}

export interface S3HeadResult {
	etag: string;
	size: number;
	lastModified: number;
	fingerprint?: string;
	clientMtime?: number;
	deviceId?: string;
}

export interface S3DownloadResult {
	content: Uint8Array;
	etag: string;
	size: number;
	lastModified: number;
	fingerprint?: string;
	clientMtime?: number;
	deviceId?: string;
}

export interface SyncUploadMetadata {
	fingerprint: string;
	clientMtime: number;
	deviceId: string;
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
	isSyncing: boolean;
	lastError: string | null;
}

export interface S3ObjectInfo {
	key: string;
	size: number;
	lastModified: Date;
	etag?: string;
}
