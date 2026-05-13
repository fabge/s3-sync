/**
 * Unit tests for time utilities
 */

import { formatRelativeTime } from '../../src/utils/time';

describe('Time Utils', () => {
    describe('formatRelativeTime', () => {
        it('should format "just now" for recent times', () => {
            const now = Date.now();
            expect(formatRelativeTime(now)).toBe('just now');
            expect(formatRelativeTime(now - 30000)).toBe('just now'); // 30s ago
        });

        it('should format minutes', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 2 * 60 * 1000)).toBe('2m ago');
            expect(formatRelativeTime(now - 45 * 60 * 1000)).toBe('45m ago');
        });

        it('should format hours', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 2 * 60 * 60 * 1000)).toBe('2h ago');
            expect(formatRelativeTime(now - 12 * 60 * 60 * 1000)).toBe('12h ago');
        });

        it('should format days', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000)).toBe('2d ago');
            expect(formatRelativeTime(now - 5 * 24 * 60 * 60 * 1000)).toBe('5d ago');
        });

        it('should format weeks', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe('2w ago');
        });

        it('should handle null timestamp', () => {
            expect(formatRelativeTime(null)).toBe('');
        });
    });
});
