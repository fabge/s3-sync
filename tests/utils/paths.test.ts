import {
    getFilename,
    getExtension,
    matchesAnyGlob,
    isConflictFile,
    addPrefix,
    removePrefix,
    isPluginOwnPath,
} from '../../src/utils/paths';

describe('Path Utils', () => {
    describe('getFilename', () => {
        it('should extract filename from path', () => {
            expect(getFilename('folder/file.md')).toBe('file.md');
        });

        it('should handle root files', () => {
            expect(getFilename('file.md')).toBe('file.md');
        });

        it('should handle nested paths', () => {
            expect(getFilename('a/b/c/file.md')).toBe('file.md');
        });
    });

    describe('getExtension', () => {
        it('should extract file extension', () => {
            expect(getExtension('file.md')).toBe('md');
        });

        it('should handle multiple dots', () => {
            expect(getExtension('file.test.md')).toBe('md');
        });

        it('should handle no extension', () => {
            expect(getExtension('README')).toBe('');
        });
    });

    describe('matchesAnyGlob', () => {
        it('should match any pattern in list', () => {
            const patterns = ['*.md', '*.txt', '**/*.canvas', '.obsidian/**'];
            expect(matchesAnyGlob('file.md', patterns)).toBe(true);
            expect(matchesAnyGlob('file.txt', patterns)).toBe(true);
            expect(matchesAnyGlob('dir/file.canvas', patterns)).toBe(true);
            expect(matchesAnyGlob('.obsidian/workspace.json', patterns)).toBe(true);
            expect(matchesAnyGlob('file.pdf', patterns)).toBe(false);
        });

        it('should return false for empty patterns', () => {
            expect(matchesAnyGlob('file.md', [])).toBe(false);
        });
    });

    describe('isConflictFile', () => {
        it('should detect LOCAL_ prefix', () => {
            expect(isConflictFile('folder/LOCAL_file.md')).toBe(true);
        });

        it('should detect REMOTE_ prefix', () => {
            expect(isConflictFile('folder/REMOTE_file.md')).toBe(true);
        });

        it('should not match normal files', () => {
            expect(isConflictFile('file.md')).toBe(false);
        });

        it('should match at filename level only', () => {
            expect(isConflictFile('LOCAL_folder/file.md')).toBe(false);
        });
    });

    describe('addPrefix', () => {
        it('should add prefix to path', () => {
            expect(addPrefix('file.md', 'vault')).toBe('vault/file.md');
            expect(addPrefix('dir/file.md', 'vault')).toBe('vault/dir/file.md');
        });

        it('should handle empty prefix', () => {
            expect(addPrefix('file.md', '')).toBe('file.md');
        });

        it('should normalize trailing slashes in prefix', () => {
            expect(addPrefix('file.md', 'vault/')).toBe('vault/file.md');
        });

        it('should normalize leading slashes in path', () => {
            expect(addPrefix('/file.md', 'vault')).toBe('vault/file.md');
        });

        it('should handle both trailing and leading slashes', () => {
            expect(addPrefix('/file.md', 'vault/')).toBe('vault/file.md');
        });

        it('should handle backslashes in path', () => {
            expect(addPrefix('dir\\file.md', 'vault')).toBe('vault/dir/file.md');
        });

        it('should handle backslashes in prefix', () => {
            expect(addPrefix('file.md', 'vault\\subdir')).toBe('vault/subdir/file.md');
        });

        it('should handle nested directories', () => {
            expect(addPrefix('a/b/c/file.md', 'vault')).toBe('vault/a/b/c/file.md');
        });
    });

    describe('removePrefix', () => {
        it('should remove prefix from path', () => {
            expect(removePrefix('vault/file.md', 'vault')).toBe('file.md');
            expect(removePrefix('vault/dir/file.md', 'vault')).toBe('dir/file.md');
        });

        it('should return null if prefix does not match', () => {
            expect(removePrefix('other/file.md', 'vault')).toBeNull();
            expect(removePrefix('file.md', 'vault')).toBeNull();
        });

        it('should handle trailing slashes in prefix', () => {
            expect(removePrefix('vault/file.md', 'vault/')).toBe('file.md');
        });

        it('should handle backslashes', () => {
            expect(removePrefix('vault\\file.md', 'vault')).toBe('file.md');
        });

        it('should handle nested prefixes', () => {
            expect(removePrefix('vault/subdir/file.md', 'vault/subdir')).toBe('file.md');
        });

        it('should be case-sensitive', () => {
            expect(removePrefix('Vault/file.md', 'vault')).toBeNull();
        });

        it('should not match partial directory names', () => {
            expect(removePrefix('vault2/file.md', 'vault')).toBeNull();
        });

        it('should handle empty string paths', () => {
            expect(removePrefix('', 'vault')).toBeNull();
        });

        it('should handle deeply nested paths', () => {
            expect(removePrefix('vault/a/b/c/d/file.md', 'vault')).toBe('a/b/c/d/file.md');
        });
    });

    describe('isPluginOwnPath', () => {
        it('should match data.json inside plugin directory', () => {
            expect(isPluginOwnPath('.obsidian/plugins/s3-sync/data.json', '.obsidian')).toBe(true);
        });

        it('should match main.js inside plugin directory', () => {
            expect(isPluginOwnPath('.obsidian/plugins/s3-sync/main.js', '.obsidian')).toBe(true);
        });

        it('should match the plugin directory itself', () => {
            expect(isPluginOwnPath('.obsidian/plugins/s3-sync', '.obsidian')).toBe(true);
        });

        it('should not match other plugin directories', () => {
            expect(isPluginOwnPath('.obsidian/plugins/other-plugin/data.json', '.obsidian')).toBe(false);
        });

        it('should not match files outside plugins directory', () => {
            expect(isPluginOwnPath('.obsidian/workspace.json', '.obsidian')).toBe(false);
            expect(isPluginOwnPath('Notes/my-note.md', '.obsidian')).toBe(false);
        });

        it('should work with custom configDir', () => {
            expect(isPluginOwnPath('.config/plugins/s3-sync/data.json', '.config')).toBe(true);
            expect(isPluginOwnPath('.obsidian/plugins/s3-sync/data.json', '.config')).toBe(false);
        });

        it('should normalize backslashes in path', () => {
            expect(isPluginOwnPath('.obsidian\\plugins\\s3-sync\\data.json', '.obsidian')).toBe(true);
        });
    });

});
