/** Browser-safe path helpers; Obsidian runtime cannot use Node's `path` module. */

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

/** Normalized path segments; the one place backslash handling lives. */
export function pathSegments(path: string): string[] {
    return normalizePath(path).split('/');
}

function getFilename(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

export function getExtension(path: string): string {
    const filename = getFilename(path);
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.substring(lastDot + 1) : '';
}

// Patterns are matched against every vault file, remote object, and baseline
// each sync cycle; cache the compiled form instead of recompiling per call.
const globRegexCache = new Map<string, RegExp>();

/** `*` matches within a path segment; `**` matches across segments. */
function matchGlob(path: string, rawPattern: string): boolean {
    const normalized = normalizePath(path);
    // Normalized on both sides: a pattern written with backslashes must behave
    // like the equivalent forward-slash pattern, not silently match nothing.
    const pattern = normalizePath(rawPattern);

    let regex = globRegexCache.get(pattern);
    if (!regex) {
        // Stash wildcards as placeholders, escape regex metachars, then restore:
        // single * → [^/]* (within a segment), ** → .* (across segments).
        const regexPattern = pattern
            .replace(/\*\*/g, '<<<GLOBSTAR>>>')
            .replace(/\*/g, '<<<STAR>>>')
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/<<<STAR>>>/g, '[^/]*')
            .replace(/<<<GLOBSTAR>>>/g, '.*');
        regex = new RegExp(`^${regexPattern}$`);
        globRegexCache.set(pattern, regex);
    }

    return regex.test(normalized);
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => matchGlob(path, pattern));
}


/**
 * Obsidian's vault index never surfaces dot-prefixed files or folders. Such
 * paths only sync when explicitly allowlisted, and are then read and written
 * through the vault adapter instead of the index-backed vault API.
 */
export function isHiddenPath(path: string): boolean {
	return pathSegments(path).some((segment) => segment.startsWith('.'));
}
