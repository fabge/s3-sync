/**
 * Browser-safe path helpers for S3 key ↔ vault path conversion, glob matching,
 * and conflict-file detection. Avoids Node's `path` module (unavailable in the
 * Obsidian runtime); S3 keys always use forward slashes.
 */

/** Normalize backslashes to forward slashes (Windows paths → S3 keys). */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

/** Normalize a user-configured S3 prefix: trim, drop leading/trailing slashes, collapse interior ones. */
export function normalizePrefix(prefix: string): string {
    return normalizePath(prefix)
        .trim()
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/');
}

/** Filename portion of a path (everything after the last `/`). */
export function getFilename(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

/** File extension without the leading dot, or `''` if none. */
export function getExtension(path: string): string {
    const filename = getFilename(path);
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.substring(lastDot + 1) : '';
}

/**
 * Match a path against a glob pattern. `*` matches within a path segment (not
 * `/`); `**` matches across segments; all other characters are literal.
 */
export function matchGlob(path: string, pattern: string): boolean {
    const normalized = normalizePath(path);

    // Stash wildcards as placeholders, escape regex metachars, then restore:
    // single * → [^/]* (within a segment), ** → .* (across segments).
    const regexPattern = pattern
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '<<<STAR>>>')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/<<<STAR>>>/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*');

    return new RegExp(`^${regexPattern}$`).test(normalized);
}

/** `true` if `path` matches any pattern in the list. */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => matchGlob(path, pattern));
}

/**
 * Prepend an S3 prefix to a vault path. Both are normalized; if either is empty
 * the other is returned alone (no stray slashes).
 */
export function addPrefix(path: string, prefix: string): string {
    const normalizedPrefix = normalizePrefix(prefix);
    const normalizedPath = normalizePath(path).replace(/^\/+/, '');

    if (!normalizedPrefix) return normalizedPath;
    if (!normalizedPath) return normalizedPrefix;
    return `${normalizedPrefix}/${normalizedPath}`;
}

/**
 * Strip an S3 prefix from a key, returning the vault path: `''` if the key
 * equals the prefix, or `null` if the key is outside the prefix.
 */
export function removePrefix(path: string, prefix: string): string | null {
    const normalizedPath = normalizePath(path);
    const normalizedPrefix = normalizePrefix(prefix);

    if (!normalizedPrefix) return normalizedPath;

    const prefixWithSlash = `${normalizedPrefix}/`;
    if (normalizedPath === normalizedPrefix) return '';
    if (normalizedPath.startsWith(prefixWithSlash)) {
        return normalizedPath.substring(prefixWithSlash.length);
    }
    return null;
}

/** `true` if the filename is a `LOCAL_`/`REMOTE_` conflict artifact (filename only, not the directory). */
export function isConflictFile(path: string): boolean {
    const filename = getFilename(path);
    return filename.startsWith('LOCAL_') || filename.startsWith('REMOTE_');
}

/** Must match the `id` in manifest.json. */
const PLUGIN_ID = 's3-sync';

/**
 * `true` if `path` is inside this plugin's own settings directory. Hardcoded,
 * non-overridable exclusion so `data.json` (AWS credentials) and other plugin
 * artifacts never sync to S3.
 */
export function isPluginOwnPath(path: string, configDir: string): boolean {
	const normalized = normalizePath(path);
	const pluginDir = `${normalizePath(configDir)}/plugins/${PLUGIN_ID}/`;
	return normalized.startsWith(pluginDir) || normalized === pluginDir.slice(0, -1);
}
