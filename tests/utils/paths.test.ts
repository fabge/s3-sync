import { matchesAnyGlob, remoteToLocal } from '../../src/utils/paths';

describe('Path Utils', () => {

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

    it('rejects unsafe remote keys', () => {
        expect(remoteToLocal('Notes/daily.md')).toBe('Notes/daily.md');
        expect(remoteToLocal('Notes\\daily.md')).toBeNull();
        expect(remoteToLocal('/Notes/daily.md')).toBeNull();
        expect(remoteToLocal('Notes//daily.md')).toBeNull();
        expect(remoteToLocal('../escape.md')).toBeNull();
        expect(remoteToLocal('Notes/../escape.md')).toBeNull();
        expect(remoteToLocal('Notes/./daily.md')).toBeNull();
    });
});
