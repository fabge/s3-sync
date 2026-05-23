import { normalizeEntityTag } from '../../src/utils/etags';

describe('normalizeEntityTag', () => {
	it.each([
		['"abc123"', 'abc123'],
		['W/"abc123"', 'abc123'],
		['w/"abc123"', 'abc123'],
		['abc123', 'abc123'],
		[' W/"abc123" ', 'abc123'],
		[undefined, ''],
		[null, ''],
	])('normalizes %p to %p', (input, expected) => {
		expect(normalizeEntityTag(input)).toBe(expected);
	});
});
