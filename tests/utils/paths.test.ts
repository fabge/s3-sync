import {
    getExtension,
    matchesAnyGlob,
} from '../../src/utils/paths';

describe('Path Utils', () => {

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



});
