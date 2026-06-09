import {
    getFilename,
    getExtension,
    matchesAnyGlob,
    isConflictFile,
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
