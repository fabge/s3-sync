import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { createObsidianVault } from '../../src/vault/ObsidianVault';

interface FakeStat {
	type: 'file' | 'folder';
	ctime: number;
	mtime: number;
	size: number;
}

function createApp() {
	const files = new Map<string, FakeStat>([
		['.claude/skills/qmd/SKILL.md', { type: 'file', ctime: 1, mtime: 2, size: 3 }],
		['.claude/settings.json', { type: 'file', ctime: 1, mtime: 2, size: 4 }],
	]);

	const adapter = {
		exists: jest.fn((path: string) => Promise.resolve(path === '.claude')),
		stat: jest.fn((path: string) => {
			if (path === '.claude' || path === '.claude/skills' || path === '.claude/skills/qmd') {
				return Promise.resolve({ type: 'folder', ctime: 0, mtime: 0, size: 0 });
			}
			return Promise.resolve(files.get(path) ?? null);
		}),
		list: jest.fn((path: string) => {
			const listing: Record<string, { files: string[]; folders: string[] }> = {
				'.claude': { files: ['.claude/settings.json'], folders: ['.claude/skills'] },
				'.claude/skills': { files: [], folders: ['.claude/skills/qmd'] },
				'.claude/skills/qmd': { files: ['.claude/skills/qmd/SKILL.md'], folders: [] },
			};
			return Promise.resolve(listing[path] ?? { files: [], folders: [] });
		}),
		readBinary: jest.fn(() => Promise.resolve(new ArrayBuffer(3))),
		writeBinary: jest.fn(() => Promise.resolve()),
		mkdir: jest.fn(() => Promise.resolve()),
		trashLocal: jest.fn(() => Promise.resolve()),
		rename: jest.fn(() => Promise.resolve()),
	};

	const vault = {
		adapter,
		configDir: '.obsidian',
		getFiles: jest.fn(() => []),
		getAbstractFileByPath: jest.fn(() => null),
		readBinary: jest.fn(() => Promise.resolve(new ArrayBuffer(8))),
		modifyBinary: jest.fn(() => Promise.resolve()),
		createBinary: jest.fn(() => Promise.resolve(null)),
		createFolder: jest.fn(() => Promise.resolve(null)),
		rename: jest.fn(() => Promise.resolve()),
	};

	const app = { vault, fileManager: { trashFile: jest.fn(() => Promise.resolve()) } };
	return { app: app as unknown as App, adapter, vault };
}

describe('createObsidianVault', () => {
	it('walks allowlisted hidden folders that the vault index cannot see', async () => {
		const { app } = createApp();
		const found = await createObsidianVault(app).getHiddenFiles(['.claude/**']);

		expect(found.map((file) => file.path).sort()).toEqual([
			'.claude/settings.json',
			'.claude/skills/qmd/SKILL.md',
		]);
	});

	// The port deliberately does not apply the globs: the planner filters with
	// the same shouldExclude it uses for notes, so conflict artifacts and other
	// paths the port cannot reason about stay visible to it.
	it('returns everything under a root regardless of the glob', async () => {
		const { app } = createApp();
		const found = await createObsidianVault(app).getHiddenFiles(['.claude/skills/**']);

		expect(found.map((file) => file.path).sort()).toEqual([
			'.claude/settings.json',
			'.claude/skills/qmd/SKILL.md',
		]);
	});

	it('derives file metadata from adapter stat for hidden lookups', async () => {
		const { app } = createApp();
		const entry = await createObsidianVault(app).getAbstractFileByPath('.claude/settings.json');

		expect(entry).toEqual({
			path: '.claude/settings.json',
			stat: { mtime: 2, size: 4 },
		});
	});

	// The whole point of the adapter route: hidden files never touch the vault
	// index, so Obsidian never turns them into notes.
	it('routes hidden reads and writes through the adapter, not the vault API', async () => {
		const { app, adapter, vault } = createApp();
		const port = createObsidianVault(app);
		const hidden = await port.getAbstractFileByPath('.claude/settings.json');

		await port.readBinary(hidden as never);
		await port.modifyBinary(hidden as never, new ArrayBuffer(2));
		await port.trashFile(hidden as never);

		expect(adapter.readBinary).toHaveBeenCalledWith('.claude/settings.json');
		expect(adapter.writeBinary).toHaveBeenCalledWith('.claude/settings.json', expect.anything());
		expect(adapter.trashLocal).toHaveBeenCalledWith('.claude/settings.json');
		expect(vault.readBinary).not.toHaveBeenCalled();
		expect(vault.modifyBinary).not.toHaveBeenCalled();
		expect(app.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it('routes visible paths through the vault API', async () => {
		const { app, adapter, vault } = createApp();
		const port = createObsidianVault(app);
		const file = new TFile();
		file.path = 'notes/visible.md';

		await port.readBinary(file as never);

		expect(vault.readBinary).toHaveBeenCalledWith(file);
		expect(adapter.readBinary).not.toHaveBeenCalled();
	});
	// The allowlist is a user-supplied glob, so the never-syncable roots have to
	// hold at the walker too, not only where patterns are entered.
	it('refuses never-syncable roots even when a glob names them', async () => {
		const { app, adapter } = createApp();
		const found = await createObsidianVault(app).getHiddenFiles([
			'.git/**',
			'.Git/**',
			'.trash/**',
		]);

		expect(found).toEqual([]);
		expect(adapter.list).not.toHaveBeenCalled();
	});

	it('prunes never-syncable subfolders during the walk', async () => {
		const { app, adapter } = createApp();
		adapter.list.mockImplementation((path: string) => {
			const listing: Record<string, { files: string[]; folders: string[] }> = {
				'.claude': { files: [], folders: ['.claude/.git', '.claude/skills'] },
				'.claude/skills': { files: ['.claude/skills/SKILL.md'], folders: [] },
				'.claude/.git': { files: ['.claude/.git/config'], folders: [] },
			};
			return Promise.resolve(listing[path] ?? { files: [], folders: [] });
		});
		adapter.stat.mockImplementation((path: string) =>
			Promise.resolve({ type: path.endsWith('.md') || path.endsWith('config') ? 'file' : 'folder', ctime: 0, mtime: 0, size: 1 }));

		const found = await createObsidianVault(app).getHiddenFiles(['.claude/**']);

		expect(found.map((file) => file.path)).toEqual(['.claude/skills/SKILL.md']);
		expect(adapter.list).not.toHaveBeenCalledWith('.claude/.git');
	});

	// A symlink pointing at an ancestor is invisible to the adapter API, so the
	// only available guard is a depth cap. Hitting it must fail the cycle:
	// returning a short list would read as 'locally deleted' and the planner
	// would delete those files from S3.
	it('fails instead of truncating when nesting runs away', async () => {
		const { app, adapter } = createApp();
		adapter.list.mockImplementation((path: string) =>
			Promise.resolve({ files: [`${path}/note.md`], folders: [`${path}/loop`] }));
		adapter.stat.mockImplementation((path: string) =>
			Promise.resolve({ type: path.endsWith('.md') ? 'file' : 'folder', ctime: 0, mtime: 0, size: 1 }));

		await expect(createObsidianVault(app).getHiddenFiles(['.claude/**']))
			.rejects.toThrow('Sync aborted');
	});

	it('fails the cycle rather than skipping an unreadable directory', async () => {
		const { app, adapter } = createApp();
		adapter.list.mockImplementation((path: string) =>
			(path === '.claude/skills'
				? Promise.reject(new Error('EACCES'))
				: Promise.resolve({ files: [], folders: ['.claude/skills'] })));

		await expect(createObsidianVault(app).getHiddenFiles(['.claude/**'])).rejects.toThrow('EACCES');
	});
});
