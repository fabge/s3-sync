/** The hidden-path allowlist and the paths it may never reach. */

import { pathSegments } from '../utils/paths';

/**
 * Refused at any depth, whatever the allowlist says. A synced `.git` directory
 * corrupts repositories and `.trash` is Obsidian's deletion staging.
 */
const NEVER_SYNCABLE = ['.git', '.trash'];

export interface HiddenPatternResult {
	accepted: string[];
	rejected: { pattern: string; reason: string }[];
}

/**
 * Checked at the exclusion boundary rather than only where patterns are
 * entered, so a nested `.claude/.trash/x` is refused just like a top-level one.
 */
export function isNeverSyncable(path: string, configDir: string): boolean {
	const segments = pathSegments(path).map((segment) => segment.toLowerCase());
	if (segments.some((segment) => NEVER_SYNCABLE.includes(segment))) return true;

	// Root-anchored, so a user folder that merely shares the config directory's
	// name still syncs, and a multi-segment configDir is matched in full rather
	// than leaving its data.json exposed as an ordinary file.
	const config = pathSegments(configDir).filter(Boolean).map((segment) => segment.toLowerCase());
	return config.length > 0 && config.every((segment, index) => segments[index] === segment);
}

/**
 * A pattern is accepted in exactly one shape: a concrete dot-prefixed root
 * followed by at least one more component, e.g. `.claude/**`.
 *
 * Anything else is refused rather than repaired. A pattern decides which files
 * leave the machine, so this validator has no normalising special cases —
 * rewriting input into a valid shape is how `..` becomes a directory walk of
 * the vault's parent.
 */
function checkPattern(pattern: string, configDir: string): string | null {
	if (pattern.includes('\\')) return 'use forward slashes';

	const segments = pattern.replace(/\/+$/, '').split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return 'must not contain empty or relative path segments';
	}

	const root = segments[0] ?? '';
	if (!/^\.[^*?]+$/.test(root)) {
		return 'must start with a concrete dot-prefixed folder name';
	}
	if (segments.length < 2) {
		return `add a subtree glob, for example ${root}/**`;
	}
	if (isNeverSyncable(root, configDir)) {
		return `${root} can never be synced`;
	}

	return null;
}

/**
 * Hidden files are only discoverable under a hidden top-level directory, since
 * enumerating the whole vault through the adapter on every cycle would be far
 * too expensive. Patterns must therefore name a concrete hidden root.
 */
export function validateHiddenPatterns(patterns: string[], configDir: string): HiddenPatternResult {
	const accepted: string[] = [];
	const rejected: { pattern: string; reason: string }[] = [];

	for (const pattern of patterns) {
		const reason = checkPattern(pattern, configDir);
		if (reason) {
			rejected.push({ pattern, reason });
			continue;
		}
		accepted.push(pattern.replace(/\/+$/, ''));
	}

	return { accepted, rejected };
}

/**
 * Concrete hidden roots that need walking. Every accepted pattern starts with
 * one, so these are always folders — never a file, never a traversal.
 */
export function hiddenRoots(patterns: string[]): string[] {
	return [...new Set(patterns.map((pattern) => pathSegments(pattern)[0] ?? '').filter(Boolean))];
}
