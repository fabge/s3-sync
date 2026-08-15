import { hiddenRoots, isNeverSyncable, validateHiddenPatterns } from '../../src/vault/hiddenPaths';

describe('validateHiddenPatterns', () => {
	it('accepts globs rooted at a dot-prefixed folder', () => {
		const result = validateHiddenPatterns(['.claude/**', '.codex/**'], '.obsidian');
		expect(result.accepted).toEqual(['.claude/**', '.codex/**']);
		expect(result.rejected).toEqual([]);
	});

	it('rejects globs that do not start with a hidden segment', () => {
		const result = validateHiddenPatterns(['notes/**', '**/*.md'], '.obsidian');
		expect(result.accepted).toEqual([]);
		expect(result.rejected).toHaveLength(2);
	});

	// Syncing a Git directory between machines corrupts repositories, and the
	// config folder is Obsidian's own state, so neither may ever be opted in.
	it('rejects Git, trash, and the Obsidian config folder', () => {
		const result = validateHiddenPatterns(
			['.git/**', '.Git/**', '.trash/**', '.Trash/**', '.obsidian/**', '.Obsidian/**'],
			'.obsidian',
		);
		expect(result.accepted).toEqual([]);
		expect(result.rejected.map((entry) => entry.pattern)).toEqual([
			'.git/**',
			'.Git/**',
			'.trash/**',
			'.Trash/**',
			'.obsidian/**',
			'.Obsidian/**',
		]);
	});

	it('honours a non-default config directory', () => {
		const result = validateHiddenPatterns(['.obsidian-work/**'], '.obsidian-work');
		expect(result.accepted).toEqual([]);
	});
});

describe('hiddenRoots', () => {
	it('reduces globs to the concrete folders that must be walked', () => {
		expect(hiddenRoots(['.claude/**', '.claude/skills/*', '.codex/**'])).toEqual([
			'.claude',
			'.codex',
		]);
	});
});

describe('isNeverSyncable', () => {
	// Absorbed from the former isGitInternalPath / isPluginOwnPath helpers,
	// which this predicate now subsumes.
	it('matches the forbidden roots at any depth', () => {
		expect(isNeverSyncable('.git', '.obsidian')).toBe(true);
		expect(isNeverSyncable('.git/config', '.obsidian')).toBe(true);
		expect(isNeverSyncable('nested/.git/index', '.obsidian')).toBe(true);
		expect(isNeverSyncable('.trash/old.md', '.obsidian')).toBe(true);
		expect(isNeverSyncable('.Git/config', '.obsidian')).toBe(true);
		expect(isNeverSyncable('nested/.TRASH/old.md', '.obsidian')).toBe(true);
	});

	it('covers the config dir, including the plugin\'s own settings', () => {
		expect(isNeverSyncable('.obsidian/plugins/s3-sync/data.json', '.obsidian')).toBe(true);
		expect(isNeverSyncable('.obsidian/plugins/other-plugin/data.json', '.obsidian')).toBe(true);
		expect(isNeverSyncable('.obsidian/workspace.json', '.obsidian')).toBe(true);
		expect(isNeverSyncable('.config/plugins/s3-sync/data.json', '.config')).toBe(true);
		expect(isNeverSyncable('.Obsidian/workspace.json', '.obsidian')).toBe(true);
	});

	it('normalizes backslashes so a Windows-style path cannot slip through', () => {
		expect(isNeverSyncable('nested\\.git\\config', '.obsidian')).toBe(true);
	});

	it('leaves ordinary notes and unrelated dotfiles alone', () => {
		expect(isNeverSyncable('notes/my-note.md', '.obsidian')).toBe(false);
		expect(isNeverSyncable('.claude/skills/qmd/SKILL.md', '.obsidian')).toBe(false);
		expect(isNeverSyncable('.gitignore', '.obsidian')).toBe(false);
	});
});

describe('validateHiddenPatterns — pattern shape', () => {
	// Rewriting input into a valid shape is what produced the `..` -> `../**`
	// traversal, so a bare folder name is now refused with the correction in
	// the message instead of being repaired silently.
	it('refuses a bare folder name and names the fix', () => {
		const result = validateHiddenPatterns(['.claude'], '.obsidian');
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain('.claude/**');
	});

	it('refuses relative segments that would escape the vault', () => {
		const result = validateHiddenPatterns(['..', '.', '../**', '.claude/../../etc/**'], '.obsidian');
		expect(result.accepted).toEqual([]);
		expect(result.rejected).toHaveLength(4);
	});

	it('strips a trailing slash instead of storing a glob that matches nothing', () => {
		expect(validateHiddenPatterns(['.claude/**/'], '.obsidian').accepted).toEqual(['.claude/**']);
	});

	it('refuses a wildcard in the root segment', () => {
		expect(validateHiddenPatterns(['.*/**'], '.obsidian').accepted).toEqual([]);
	});

	it('leaves an explicit glob untouched', () => {
		expect(validateHiddenPatterns(['.claude/skills/**'], '.obsidian').accepted)
			.toEqual(['.claude/skills/**']);
	});

	it('rejects backslash patterns outright rather than storing an inert one', () => {
		const result = validateHiddenPatterns(['notes\\.claude/**', '.claude\\**'], '.obsidian');
		expect(result.accepted).toEqual([]);
		expect(result.rejected).toHaveLength(2);
	});
});
