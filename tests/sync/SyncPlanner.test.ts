import { App, TFile, Vault } from 'obsidian';
import { VaultEntry, VaultFile, VaultLike } from '../../src/types';
import { SyncPlanner } from '../../src/sync/SyncPlanner';
import {
	ConflictRecord,
	DEFAULT_SETTINGS,
	LocalClassification,
	RemoteClassification,
	S3DownloadResult,
	S3HeadResult,
	S3ObjectInfo,
	S3SyncSettings,
	SyncPlanItem,
	SyncStateRecord,
} from '../../src/types';
import { decide } from '../../src/sync/SyncDecisionTable';
import { readVaultFile } from '../../src/utils/vaultFiles';
import { S3Provider } from '../../src/storage/S3Provider';
import { SyncJournal } from '../../src/sync/SyncJournal';
import { fingerprint } from '../../src/utils/fingerprint';

jest.mock('../../src/storage/S3Provider', () => ({
	S3Provider: jest.fn().mockImplementation(() => ({
		listObjects: jest.fn(),
		headObject: jest.fn(),
		downloadFileWithMetadata: jest.fn(),
	})),
}));

jest.mock('../../src/sync/SyncJournal', () => ({
	SyncJournal: jest.fn().mockImplementation(() => ({
		getAllStateRecords: jest.fn(),
		getAllConflicts: jest.fn(),
	})),
}));

jest.mock('../../src/utils/fingerprint', () => ({
	fingerprint: jest.fn(),
}));

jest.mock('../../src/sync/SyncDecisionTable', () => ({
	decide: jest.fn(),
}));

jest.mock('../../src/utils/vaultFiles', () => ({
	readVaultFile: jest.fn(),
}));

interface LocalSnapshotLike {
	file: TFile;
	mtime: number;
	size: number;
}

interface RemoteSnapshotLike {
	objectInfo: S3ObjectInfo;
	head?: S3HeadResult;
}

interface PathContextLike {
	path: string;
	local?: LocalSnapshotLike;
	remote?: RemoteSnapshotLike;
	baseline?: SyncStateRecord;
	conflict?: ConflictRecord;
	hasConflictArtifacts: boolean;
	localFingerprint?: string;
	remoteFingerprint?: string;
}

interface SyncPlannerPrivate {
	discoverState(): Promise<Map<string, PathContextLike>>;
	classifyLocal(ctx: PathContextLike): Promise<LocalClassification>;
	classifyRemote(ctx: PathContextLike): Promise<RemoteClassification>;
	sortPlan(plan: SyncPlanItem[]): SyncPlanItem[];
	shouldExclude(path: string): boolean;
}

interface MockS3Provider {
	listObjects: jest.Mock<Promise<S3ObjectInfo[]>, []>;
	headObject: jest.Mock<Promise<S3HeadResult | null>, [string]>;
	downloadFileWithMetadata: jest.Mock<Promise<S3DownloadResult | null>, [string]>;
}

interface MockSyncJournal {
	getAllStateRecords: jest.Mock<Promise<SyncStateRecord[]>, []>;
	getAllConflicts: jest.Mock<Promise<ConflictRecord[]>, []>;
}

interface VaultWithAddFile extends Vault {
	_addFile(path: string, content: string): TFile;
}

function createSettings(overrides: Partial<S3SyncSettings> = {}): S3SyncSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
	};
}

function createStateRecord(overrides: Partial<SyncStateRecord> = {}): SyncStateRecord {
	return {
		path: 'note.md',
		contentFingerprint: 'sha256:baseline',
		localMtime: 100,
		localSize: 10,
		remoteEtag: 'etag-baseline',
		...overrides,
	};
}

function createConflictRecord(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
	return {
		path: 'note.md',
		mode: 'both',
		localArtifactPath: 'LOCAL_note.md',
		remoteArtifactPath: 'REMOTE_note.md',
		...overrides,
	};
}

function createRemoteObject(overrides: Partial<S3ObjectInfo> = {}): S3ObjectInfo {
	return {
		key: 'note.md',
		etag: 'etag-remote',
		...overrides,
	};
}

function createDownloadResult(overrides: Partial<S3DownloadResult> = {}): S3DownloadResult {
	return {
		content: new Uint8Array([1, 2, 3]),
		etag: 'etag-download',
		...overrides,
	};
}

function createPlanItem(path: string, action: SyncPlanItem['action']): SyncPlanItem {
	return {
		path,
		action,
	};
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function getPlannerPrivate(planner: SyncPlanner): SyncPlannerPrivate {
	return planner as unknown as SyncPlannerPrivate;
}

describe('SyncPlanner', () => {
	let app: App;
	let vault: VaultWithAddFile;
	let vaultPort: VaultLike;
	let hiddenFiles: VaultFile[];
	let settings: S3SyncSettings;
	let s3Provider: MockS3Provider;
	let journal: MockSyncJournal;
	let planner: SyncPlanner;

	const mockedDecide = jest.mocked(decide);
	const mockedReadVaultFile = jest.mocked(readVaultFile);
	const mockedFingerprint = jest.mocked(fingerprint);

	function createPlanner(overrides: Partial<S3SyncSettings> = {}): SyncPlanner {
		settings = createSettings(overrides);
		return new SyncPlanner(
			vaultPort,
			s3Provider as unknown as S3Provider,
			journal as unknown as SyncJournal,
			settings,
		);
	}

	function addVaultFile(path: string, content = 'content', mtime = 100, size = content.length): TFile {
		const file = vault._addFile(path, content);
		file.stat.mtime = mtime;
		file.stat.ctime = mtime - 1;
		file.stat.size = size;
		return file;
	}

	beforeEach(() => {
		jest.clearAllMocks();

		app = new App();
		vault = new Vault() as VaultWithAddFile;
		app.vault = vault;
		hiddenFiles = [];

		// Mirrors the shape the plugin's Obsidian adapter builds: index-backed
		// files from getFiles, allowlisted hidden files from getHiddenFiles.
		vaultPort = {
			configDir: '.obsidian',
			getFiles: () => vault.getFiles() as unknown as VaultFile[],
			getHiddenFiles: () => Promise.resolve(hiddenFiles),
			getAbstractFileByPath: (path: string) =>
				Promise.resolve((vault.getAbstractFileByPath?.(path) ?? null) as VaultEntry | null),
			readBinary: (file) => vault.readBinary(file as unknown as TFile),
			modifyBinary: (file, data) => vault.modifyBinary(file as unknown as TFile, data),
			createBinary: async (path, data) => { await vault.createBinary(path, data); },
			createFolder: (path) => vault.createFolder(path),
			rename: (entry, newPath) => vault.rename(entry as unknown as TFile, newPath),
			trashFile: () => Promise.resolve(),
		};

		s3Provider = {
			listObjects: jest.fn(),
			headObject: jest.fn(),
			downloadFileWithMetadata: jest.fn(),
		};

		journal = {
			getAllStateRecords: jest.fn(),
			getAllConflicts: jest.fn(),
		};

		s3Provider.listObjects.mockResolvedValue([]);
		s3Provider.headObject.mockResolvedValue(null);
		s3Provider.downloadFileWithMetadata.mockResolvedValue(null);
		journal.getAllStateRecords.mockResolvedValue([]);
		journal.getAllConflicts.mockResolvedValue([]);
		mockedFingerprint.mockResolvedValue('sha256:fingerprint');
		mockedReadVaultFile.mockResolvedValue(encode('local-content'));
		mockedDecide.mockImplementation((input) => ({
			path: input.path,
			action: 'skip',
		}));

		planner = createPlanner();
	});

	describe('buildPlan', () => {
		it('returns an empty plan for an empty vault, empty remote, and no baselines', async () => {
			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([]);
			expect(plan.syncedFileCount).toBe(0);
			expect(plan.changedSyncedFileCount).toBe(0);
			expect(s3Provider.listObjects).toHaveBeenCalledWith();
			expect(mockedDecide).not.toHaveBeenCalled();
		});

		it('counts only baselined files toward the change-protection numbers', async () => {
			// One baselined file that the plan changes, one untouched baselined
			// file, and one brand-new file: new files must not count as changes.
			addVaultFile('changed.md', 'changed', 200, 7);
			addVaultFile('stable.md', 'stable', 100, 6);
			addVaultFile('brand-new.md', 'new', 300, 3);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: 'changed.md', localMtime: 100, localSize: 7 }),
				createStateRecord({ path: 'stable.md', localMtime: 100, localSize: 6 }),
			]);
			mockedDecide.mockImplementation((input) => {
				const actions: Record<string, SyncPlanItem['action']> = {
					'changed.md': 'upload',
					'stable.md': 'skip',
					'brand-new.md': 'upload',
				};
				return createPlanItem(input.path, actions[input.path] as SyncPlanItem['action']);
			});

			const plan = await planner.buildPlan();

			expect(plan.items).toHaveLength(2);
			expect(plan.syncedFileCount).toBe(2);
			expect(plan.changedSyncedFileCount).toBe(1);
		});

		it('plans an upload for a local-only file with no baseline', async () => {
			addVaultFile('local-only.md', 'content', 123, 7);
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L+');
				expect(input.remote).toBe('R0');
				return createPlanItem(input.path, 'upload');
			});

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([
				expect.objectContaining({
					path: 'local-only.md',
					action: 'upload',
					expectRemoteAbsent: true,
					expectedLocalMtime: 123,
					expectedLocalSize: 7,
				}),
			]);
		});

		it('plans a download for a remote-only file with no baseline', async () => {
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'remote-only.md', etag: 'remote-etag' }),
			]);
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L0');
				expect(input.remote).toBe('R+');
				return createPlanItem(input.path, 'download');
			});

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([
				expect.objectContaining({
					path: 'remote-only.md',
					action: 'download',
					expectedRemoteEtag: 'remote-etag',
					expectLocalAbsent: true,
				}),
			]);
		});

		it('passes fingerprints into first-sync decisions when both sides exist', async () => {
			addVaultFile('same.md', 'same content');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'same.md' }),
			]);
			s3Provider.headObject.mockResolvedValue({
				etag: 'remote-etag',
				fingerprint: 'sha256:same',
			});
			mockedReadVaultFile.mockResolvedValue(encode('same content'));
			mockedFingerprint.mockResolvedValue('sha256:same');
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L+');
				expect(input.remote).toBe('R+');
				expect(input.localFingerprint).toBe('sha256:same');
				expect(input.remoteFingerprint).toBe('sha256:same');
				return createPlanItem(input.path, 'adopt');
			});

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([
				expect.objectContaining({
					path: 'same.md',
					action: 'adopt',
				}),
			]);
		});

		it('filters skip items when local and remote both match the baseline', async () => {
			addVaultFile('stable.md', '1234567890', 500, 10);
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'stable.md', etag: '"etag-stable"' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({
					path: 'stable.md',
					contentFingerprint: 'sha256:stable',
					localMtime: 500,
					localSize: 10,
					remoteEtag: 'etag-stable',
				}),
			]);
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L=');
				expect(input.remote).toBe('R=');
				return createPlanItem(input.path, 'skip');
			});

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([]);
		});

		it('passes conflict state into decide and returns the decided plan item', async () => {
			addVaultFile('conflicted.md');
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord({ path: 'conflicted.md', mode: 'local-only' }),
			]);
			mockedDecide.mockImplementation((input) => {
				expect(input.hasUnresolvedConflict).toBe(true);
				return {
					path: input.path,
					action: 'conflict',
					conflictMode: 'local-only',
				};
			});

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([
				expect.objectContaining({
					path: 'conflicted.md',
					action: 'conflict',
					conflictMode: 'local-only',
					expectRemoteAbsent: true,
					expectedLocalMtime: 100,
					expectedLocalSize: 7,
				}),
			]);
		});

		it('strips quotes from remote ETags before attaching them to plan items', async () => {
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'quoted.md', etag: '"abc"' }),
			]);
			mockedDecide.mockReturnValue(createPlanItem('quoted.md', 'download'));

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([
				expect.objectContaining({
					path: 'quoted.md',
					expectedRemoteEtag: 'abc',
				}),
			]);
		});

		it('marks plan items as expecting the remote object to be absent when no remote exists', async () => {
			addVaultFile('missing-remote.md');
			mockedDecide.mockReturnValue(createPlanItem('missing-remote.md', 'upload'));

			const plan = await planner.buildPlan();

			expect(plan.items).toEqual([
				expect.objectContaining({
					path: 'missing-remote.md',
					expectRemoteAbsent: true,
					expectedLocalMtime: 100,
					expectedLocalSize: 7,
				}),
			]);
		});

		it('sorts non-skip actions by priority order', async () => {
			addVaultFile('upload-f.md');
			addVaultFile('delete-remote-d.md');
			addVaultFile('adopt-a.md');
			addVaultFile('conflict-g.md');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'delete-local-c.md' }),
				createRemoteObject({ key: 'download-e.md' }),
				createRemoteObject({ key: 'adopt-a.md' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: 'forget-b.md' }),
			]);
			mockedDecide.mockImplementation((input) => {
				const actions: Record<string, SyncPlanItem['action']> = {
					'adopt-a.md': 'adopt',
					'forget-b.md': 'forget',
					'delete-local-c.md': 'delete-local',
					'delete-remote-d.md': 'delete-remote',
					'download-e.md': 'download',
					'upload-f.md': 'upload',
					'conflict-g.md': 'conflict',
				};

				return createPlanItem(input.path, actions[input.path] as SyncPlanItem['action']);
			});

			const plan = await planner.buildPlan();

			expect(plan.items.map((item) => item.action)).toEqual([
				'adopt',
				'forget',
				'delete-local',
				'delete-remote',
				'download',
				'upload',
				'conflict',
			]);
			expect(plan.items.map((item) => item.path)).toEqual([
				'adopt-a.md',
				'forget-b.md',
				'delete-local-c.md',
				'delete-remote-d.md',
				'download-e.md',
				'upload-f.md',
				'conflict-g.md',
			]);
		});
	});

	describe('discoverState', () => {
		it('excludes recorded conflict artifacts and hidden remotes, and attaches journal state', async () => {
			addVaultFile('dir/note.md');
			addVaultFile('dir/LOCAL_note.md');
			addVaultFile('dir/REMOTE_note.md');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'dir/note.md', etag: '"remote-etag"' }),
				createRemoteObject({ key: '.hidden/engine.json' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: 'dir/note.md' }),
			]);
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord({
					path: 'dir/note.md',
					localArtifactPath: 'dir/LOCAL_note.md',
					remoteArtifactPath: 'dir/REMOTE_note.md',
				}),
			]);

			const contexts = await getPlannerPrivate(planner).discoverState();
			const context = contexts.get('dir/note.md');

			expect(context).toEqual(expect.objectContaining({
				path: 'dir/note.md',
				hasConflictArtifacts: true,
				baseline: expect.objectContaining({ path: 'dir/note.md' }),
				conflict: expect.objectContaining({ path: 'dir/note.md' }),
			}));
			expect(context?.local?.file.path).toBe('dir/note.md');
			expect(context?.remote?.objectInfo.etag).toBe('remote-etag');
			expect(contexts.has('dir/LOCAL_note.md')).toBe(false);
			expect(contexts.has('dir/REMOTE_note.md')).toBe(false);
			expect(contexts.has('.hidden/engine.json')).toBe(false);
		});

		it('keeps LOCAL_ and REMOTE_ files when they are not recorded conflict artifacts', async () => {
			addVaultFile('dir/LOCAL_note.md');
			addVaultFile('dir/REMOTE_note.md');

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect(contexts.has('dir/LOCAL_note.md')).toBe(true);
			expect(contexts.has('dir/REMOTE_note.md')).toBe(true);
		});

		it('excludes local, remote, and baseline entries that match exclusion rules', async () => {
			// Covers both routes: the never-syncable rule and a configured glob.
			planner = createPlanner({ excludePatterns: ['archive/**'] });
			addVaultFile('.trash/local.md');
			addVaultFile('archive/local.md');
			addVaultFile('folder/.hidden-local.md');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: '.trash/remote.md' }),
				createRemoteObject({ key: 'archive/remote.md' }),
				createRemoteObject({ key: 'folder/.hidden-remote.md' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: '.trash/baseline.md' }),
				createStateRecord({ path: 'archive/baseline.md' }),
			]);

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect(contexts.size).toBe(0);
			expect(contexts.has('.trash/local.md')).toBe(false);
			expect(contexts.has('archive/local.md')).toBe(false);
			expect(contexts.has('archive/remote.md')).toBe(false);
			expect(contexts.has('archive/baseline.md')).toBe(false);
			expect(contexts.has('folder/.hidden-local.md')).toBe(false);
			expect(contexts.has('.trash/baseline.md')).toBe(false);
		});

		// The port returns everything under an allowlisted root, so an artifact
		// is enumerated whether or not the user's glob matches its
		// LOCAL_/REMOTE_ filename.
		it('sees a hidden conflict artifact the glob does not match', async () => {
			journal.getAllConflicts.mockResolvedValue([{
				path: '.claude/skills/SKILL.md',
				mode: 'both',
				localArtifactPath: '.claude/skills/LOCAL_SKILL.md',
			}]);
			hiddenFiles = [{ path: '.claude/skills/LOCAL_SKILL.md', stat: { mtime: 1, size: 1 } }];
			planner = createPlanner({ includeHiddenPaths: ['.claude/**/SKILL.md'] });

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect(contexts.get('.claude/skills/SKILL.md')?.hasConflictArtifacts).toBe(true);
		});

		it('keeps enumerating a hidden root while it contains unresolved conflict artifacts', async () => {
			journal.getAllConflicts.mockResolvedValue([{
				path: '.claude/skills/SKILL.md',
				mode: 'both',
				localArtifactPath: '.claude/skills/LOCAL_SKILL.md',
				remoteArtifactPath: '.claude/skills/REMOTE_SKILL.md',
			}]);
			vaultPort.getHiddenFiles = jest.fn(async (patterns: string[]) =>
				patterns.includes('.claude/**')
					? [{ path: '.claude/skills/LOCAL_SKILL.md', stat: { mtime: 1, size: 1 } }]
					: []);
			planner = createPlanner({ includeHiddenPaths: [] });

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect(vaultPort.getHiddenFiles).toHaveBeenCalledWith(['.claude/**']);
			expect(contexts.get('.claude/skills/SKILL.md')?.hasConflictArtifacts).toBe(true);
		});

		it('plans allowlisted hidden files alongside index-backed files', async () => {
			addVaultFile('notes/visible.md');
			hiddenFiles = [{
				path: '.claude/skills/qmd/SKILL.md',
				stat: { mtime: 100, size: 12 },
			}];
			planner = createPlanner({ includeHiddenPaths: ['.claude/**'] });

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect([...contexts.keys()].sort()).toEqual([
				'.claude/skills/qmd/SKILL.md',
				'notes/visible.md',
			]);
		});

		it('drops hidden files that the allowlist does not cover', async () => {
			hiddenFiles = [{
				path: '.codex/skills/qmd/SKILL.md',
				stat: { mtime: 100, size: 12 },
			}];
			planner = createPlanner({ includeHiddenPaths: ['.claude/**'] });

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect([...contexts.keys()]).toEqual([]);
		});

		it('keeps conflict records for excluded paths so they can still resolve', async () => {
			planner = createPlanner();
			addVaultFile('.trash/LOCAL_conflict.md');
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord({
					path: '.trash/conflict.md',
					localArtifactPath: '.trash/LOCAL_conflict.md',
					remoteArtifactPath: '.trash/REMOTE_conflict.md',
				}),
			]);

			const contexts = await getPlannerPrivate(planner).discoverState();
			const context = contexts.get('.trash/conflict.md');

			expect(context?.conflict).toBeDefined();
			expect(context?.hasConflictArtifacts).toBe(true);
			// Artifacts of an excluded conflict are never treated as ordinary files.
			expect(contexts.has('.trash/LOCAL_conflict.md')).toBe(false);
		});
	});

	describe('classifyLocal', () => {
		it('returns L0 when no local file exists', async () => {
			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'missing.md',
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L0');
		});

		it('returns L+ when a local file exists without a baseline', async () => {
			const file = addVaultFile('new.md');

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'new.md',
				local: { file, mtime: file.stat.mtime, size: file.stat.size },
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L+');
		});

		it('returns L= by fast path when local mtime and size match the baseline', async () => {
			const file = addVaultFile('stable.md', 'abcdefghij', 321, 10);

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'stable.md',
				local: { file, mtime: 321, size: 10 },
				baseline: createStateRecord({ path: 'stable.md', localMtime: 321, localSize: 10 }),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L=');
			expect(mockedReadVaultFile).not.toHaveBeenCalled();
			expect(mockedFingerprint).not.toHaveBeenCalled();
		});

		it('returns L= when local metadata changed but the fingerprint matches the baseline', async () => {
			const file = addVaultFile('same-content.md', 'hello world', 400, 11);
			mockedReadVaultFile.mockResolvedValue(encode('hello world'));
			mockedFingerprint.mockResolvedValue('sha256:same');

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'same-content.md',
				local: { file, mtime: 401, size: 11 },
				baseline: createStateRecord({
					path: 'same-content.md',
					contentFingerprint: 'sha256:same',
					localMtime: 400,
					localSize: 11,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L=');
			expect(mockedReadVaultFile).toHaveBeenCalledWith(vaultPort, file);
			expect(mockedFingerprint).toHaveBeenCalledWith(encode('hello world'));
		});

		it('returns LΔ when local fingerprint differs from the baseline', async () => {
			const file = addVaultFile('changed.md', 'new content', 200, 11);
			mockedReadVaultFile.mockResolvedValue(encode('new content'));
			mockedFingerprint.mockResolvedValue('sha256:new');

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'changed.md',
				local: { file, mtime: 200, size: 11 },
				baseline: createStateRecord({
					path: 'changed.md',
					contentFingerprint: 'sha256:old',
					localMtime: 199,
					localSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('LΔ');
		});
	});

	describe('classifyRemote', () => {
		it('returns R0 when no remote object exists', async () => {
			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'missing.md',
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R0');
		});

		it('returns R+ when a remote object exists without a baseline', async () => {
			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'remote.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'remote.md' }),
				},
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R+');
		});

		it('returns R= by fast path when the remote ETag matches the baseline', async () => {
			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'etag.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'etag.md', etag: 'etag-1' }),
				},
				baseline: createStateRecord({ path: 'etag.md', remoteEtag: 'etag-1' }),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
			expect(s3Provider.headObject).not.toHaveBeenCalled();
			expect(s3Provider.downloadFileWithMetadata).not.toHaveBeenCalled();
		});

		it('returns R= when the ETag differs but the fingerprint matches the baseline', async () => {
			s3Provider.headObject.mockResolvedValue({
				etag: 'etag-2',
				fingerprint: 'sha256:match',
			});

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'fp-match.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'fp-match.md', etag: 'etag-2' }),
				},
				baseline: createStateRecord({
					path: 'fp-match.md',
					contentFingerprint: 'sha256:match',
					remoteEtag: 'etag-1',
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
			expect(s3Provider.headObject).toHaveBeenCalledWith('fp-match.md');
		});

		it('returns RΔ when the ETag differs and the fingerprint differs from the baseline', async () => {
			s3Provider.headObject.mockResolvedValue({
				etag: 'etag-2',
				fingerprint: 'sha256:remote',
			});

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'fp-diff.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'fp-diff.md', etag: 'etag-2' }),
				},
				baseline: createStateRecord({
					path: 'fp-diff.md',
					contentFingerprint: 'sha256:baseline',
					remoteEtag: 'etag-1',
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('RΔ');
		});

		it('falls back to download and hashing when headObject returns null', async () => {
			const downloaded = createDownloadResult({ content: new Uint8Array([7, 8, 9]) });
			s3Provider.headObject.mockResolvedValue(null);
			s3Provider.downloadFileWithMetadata.mockResolvedValue(downloaded);
			mockedFingerprint.mockResolvedValue('sha256:match');

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'fallback.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'fallback.md', etag: 'etag-2' }),
				},
				baseline: createStateRecord({
					path: 'fallback.md',
					contentFingerprint: 'sha256:match',
					remoteEtag: 'etag-1',
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
			expect(s3Provider.headObject).toHaveBeenCalledWith('fallback.md');
			expect(s3Provider.downloadFileWithMetadata).toHaveBeenCalledWith('fallback.md');
			expect(mockedFingerprint).toHaveBeenCalledWith(downloaded.content);
		});
	});

	describe('sortPlan', () => {
		it('sorts actions by planner priority order', () => {
			const plan = [
				createPlanItem('upload.md', 'upload'),
				createPlanItem('conflict.md', 'conflict'),
				createPlanItem('download.md', 'download'),
				createPlanItem('delete-remote.md', 'delete-remote'),
				createPlanItem('forget.md', 'forget'),
				createPlanItem('adopt.md', 'adopt'),
				createPlanItem('delete-local.md', 'delete-local'),
			];

			const sorted = getPlannerPrivate(planner).sortPlan(plan);

			expect(sorted.map((item) => item.action)).toEqual([
				'adopt',
				'forget',
				'delete-local',
				'delete-remote',
				'download',
				'upload',
				'conflict',
			]);
		});

		it('sorts items with the same action alphabetically by path', () => {
			const plan = [
				createPlanItem('zeta.md', 'upload'),
				createPlanItem('alpha.md', 'upload'),
				createPlanItem('middle.md', 'upload'),
			];

			const sorted = getPlannerPrivate(planner).sortPlan(plan);

			expect(sorted.map((item) => item.path)).toEqual([
				'alpha.md',
				'middle.md',
				'zeta.md',
			]);
		});
	});

	describe('shouldExclude', () => {
		// Obsidian's index cannot see dot-prefixed paths, so they are excluded
		// unless a hidden-path glob opts them in explicitly.
		it('excludes dot-prefixed paths unless they are allowlisted', () => {
			expect(getPlannerPrivate(planner).shouldExclude('.git')).toBe(true);
			expect(getPlannerPrivate(planner).shouldExclude('.git/config')).toBe(true);
			expect(getPlannerPrivate(planner).shouldExclude('nested/.git/index')).toBe(true);
			expect(getPlannerPrivate(planner).shouldExclude('.gitignore')).toBe(true);
			expect(getPlannerPrivate(planner).shouldExclude('.claude/skills/qmd/SKILL.md')).toBe(true);
			expect(getPlannerPrivate(planner).shouldExclude('notes/regular.md')).toBe(false);

			const allowlisted = createPlanner({ includeHiddenPaths: ['.claude/**'] });
			expect(getPlannerPrivate(allowlisted).shouldExclude('.claude/skills/qmd/SKILL.md')).toBe(false);
			expect(getPlannerPrivate(allowlisted).shouldExclude('.codex/skills/qmd/SKILL.md')).toBe(true);
		});

		// A glob is user input, so the never-syncable list is enforced here
		// rather than only where patterns are entered in settings.
		it('never lets an allowlist reach Git, trash, or the config dir', () => {
			const wideOpen = createPlanner({ includeHiddenPaths: ['.claude/**', '.git/**'] });
			const excluded = (path: string): boolean => getPlannerPrivate(wideOpen).shouldExclude(path);

			expect(excluded('.git/config')).toBe(true);
			expect(excluded('.obsidian/appearance.json')).toBe(true);
			// Nested under an allowlisted root, which the pattern does match.
			expect(excluded('.claude/.git/config')).toBe(true);
			expect(excluded('.claude/.trash/old.md')).toBe(true);
			expect(excluded('.claude/skills/qmd/SKILL.md')).toBe(false);
		});

		it('does not globally exclude LOCAL_ and REMOTE_ filenames', () => {
			expect(getPlannerPrivate(planner).shouldExclude('folder/LOCAL_note.md')).toBe(false);
			expect(getPlannerPrivate(planner).shouldExclude('folder/REMOTE_note.md')).toBe(false);
		});

		// Uses a visible path: with the defaults now empty, asserting on
		// .trash/ would pass through the never-syncable rule and this test
		// would keep passing even if glob exclusion stopped working entirely.
		it('excludes files that match the configured glob patterns', () => {
			const configured = createPlanner({ excludePatterns: ['archive/**', '**/*.tmp'] });
			const excluded = (path: string): boolean => getPlannerPrivate(configured).shouldExclude(path);

			expect(excluded('archive/old.md')).toBe(true);
			expect(excluded('archive/deep/older.md')).toBe(true);
			expect(excluded('notes/scratch.tmp')).toBe(true);
			expect(excluded('notes/keep.md')).toBe(false);
			expect(excluded('archived/not-matched.md')).toBe(false);
		});

		it('does not exclude ordinary files', () => {
			expect(getPlannerPrivate(planner).shouldExclude('notes/regular.md')).toBe(false);
		});
	});

});
