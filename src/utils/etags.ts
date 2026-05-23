export function normalizeEntityTag(etag?: string | null): string {
	if (!etag) {
		return '';
	}

	const trimmed = etag.trim();
	const withoutWeakPrefix = /^W\//i.test(trimmed) ? trimmed.slice(2) : trimmed;
	const quotedMatch = withoutWeakPrefix.match(/^"(.*)"$/);

	return quotedMatch?.[1] ?? withoutWeakPrefix;
}
