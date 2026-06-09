/** Browser-safe path helpers; Obsidian runtime cannot use Node's `path` module. */

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

export function normalizePrefix(prefix: string): string {
    return normalizePath(prefix)
        .trim()
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/');
}

export function getFilename(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

export function getExtension(path: string): string {
    const filename = getFilename(path);
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.substring(lastDot + 1) : '';
}

/** `*` matches within a path segment; `**` matches across segments. */
function matchGlob(path: string, pattern: string): boolean {
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

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => matchGlob(path, pattern));
}

export function addPrefix(path: string, prefix: string): string {
    const normalizedPrefix = normalizePrefix(prefix);
    const normalizedPath = normalizePath(path).replace(/^\/+/, '');

    if (!normalizedPrefix) return normalizedPath;
    if (!normalizedPath) return normalizedPrefix;
    return `${normalizedPrefix}/${normalizedPath}`;
}

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

export function isConflictFile(path: string): boolean {
    const filename = getFilename(path);
    return filename.startsWith('LOCAL_') || filename.startsWith('REMOTE_');
}

/** Must match the `id` in manifest.json. */
const PLUGIN_ID = 's3-sync';

/** Non-overridable exclusion for this plugin's own settings/credential files. */
export function isPluginOwnPath(path: string, configDir: string): boolean {
	const normalized = normalizePath(path);
	const pluginDir = `${normalizePath(configDir)}/plugins/${PLUGIN_ID}/`;
	return normalized.startsWith(pluginDir) || normalized === pluginDir.slice(0, -1);
}
