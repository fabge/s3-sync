import { decide } from '../../src/sync/SyncDecisionTable';
import { DecisionInput, SyncPlanItem } from '../../src/types';

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
	return {
		path: 'test.md',
		local: 'L=',
		remote: 'R=',
		hasUnresolvedConflict: false,
		hasConflictArtifacts: false,
		...overrides,
	};
}

function expectAction(item: SyncPlanItem, action: string): void {
	expect(item.action).toBe(action);
}

describe('SyncDecisionTable', () => {
	describe('unresolved conflict mode', () => {
		it('skips when conflict artifacts are still present', () => {
			const result = decide(input({
				hasUnresolvedConflict: true,
				hasConflictArtifacts: true,
			}));
			expectAction(result, 'skip');
		});

		it('uploads when conflict resolved and local exists', () => {
			const result = decide(input({
				hasUnresolvedConflict: true,
				hasConflictArtifacts: false,
				local: 'L=',
			}));
			expectAction(result, 'upload');
		});

		it('restores remote when conflict resolved, local absent, remote exists', () => {
			const result = decide(input({
				hasUnresolvedConflict: true,
				hasConflictArtifacts: false,
				local: 'L0',
				remote: 'R=',
			}));
			expectAction(result, 'download');
		});

		it('forgets when conflict resolved and both sides absent', () => {
			const result = decide(input({
				hasUnresolvedConflict: true,
				hasConflictArtifacts: false,
				local: 'L0',
				remote: 'R0',
			}));
			expectAction(result, 'forget');
		});
	});

	describe('no baseline (first sync)', () => {
		it('uploads L+/R0', () => {
			const result = decide(input({
				local: 'L+',
				remote: 'R0',
			}));
			expectAction(result, 'upload');
		});

		it('downloads L0/R+', () => {
			const result = decide(input({
				local: 'L0',
				remote: 'R+',
			}));
			expectAction(result, 'download');
		});

		it('adopts L+/R+ with matching fingerprints', () => {
			const result = decide(input({
				local: 'L+',
				remote: 'R+',
				localFingerprint: 'sha256:abc',
				remoteFingerprint: 'sha256:abc',
			}));
			expectAction(result, 'adopt');
		});

		it('conflicts L+/R+ with different fingerprints', () => {
			const result = decide(input({
				local: 'L+',
				remote: 'R+',
				localFingerprint: 'sha256:abc',
				remoteFingerprint: 'sha256:def',
			}));
			expectAction(result, 'conflict');
			expect(result.conflictMode).toBe('both');
		});

		it('conflicts L+/R+ when fingerprints are missing', () => {
			const result = decide(input({
				local: 'L+',
				remote: 'R+',
			}));
			expectAction(result, 'conflict');
			expect(result.conflictMode).toBe('both');
		});

		it('skips L+/R= (inconsistent state fallthrough)', () => {
			const result = decide(input({
				local: 'L+',
				remote: 'R=',
			}));
			expectAction(result, 'skip');
		});

		it('skips L+/RΔ (inconsistent state fallthrough)', () => {
			const result = decide(input({
				local: 'L+',
				remote: 'RΔ',
			}));
			expectAction(result, 'skip');
		});

		it('skips L=/R+ (inconsistent state fallthrough)', () => {
			const result = decide(input({
				local: 'L=',
				remote: 'R+',
			}));
			expectAction(result, 'skip');
		});

		it('skips LΔ/R+ (inconsistent state fallthrough)', () => {
			const result = decide(input({
				local: 'LΔ',
				remote: 'R+',
			}));
			expectAction(result, 'skip');
		});
	});

	describe('baseline exists — standard three-way', () => {
		it('skips L=/R=', () => {
			expectAction(decide(input({ local: 'L=', remote: 'R=' })), 'skip');
		});

		it('uploads LΔ/R=', () => {
			expectAction(decide(input({ local: 'LΔ', remote: 'R=' })), 'upload');
		});

		it('downloads L=/RΔ', () => {
			expectAction(decide(input({ local: 'L=', remote: 'RΔ' })), 'download');
		});

		it('adopts LΔ/RΔ with matching fingerprints', () => {
			const result = decide(input({
				local: 'LΔ',
				remote: 'RΔ',
				localFingerprint: 'sha256:same',
				remoteFingerprint: 'sha256:same',
			}));
			expectAction(result, 'adopt');
		});

		it('conflicts LΔ/RΔ with different fingerprints', () => {
			const result = decide(input({
				local: 'LΔ',
				remote: 'RΔ',
				localFingerprint: 'sha256:aaa',
				remoteFingerprint: 'sha256:bbb',
			}));
			expectAction(result, 'conflict');
			expect(result.conflictMode).toBe('both');
		});

		it('conflicts LΔ/RΔ when one fingerprint is undefined', () => {
			const result = decide(input({
				local: 'LΔ',
				remote: 'RΔ',
				localFingerprint: 'sha256:aaa',
			}));
			expectAction(result, 'conflict');
		});

		it('conflicts LΔ/RΔ when both fingerprints are undefined', () => {
			const result = decide(input({
				local: 'LΔ',
				remote: 'RΔ',
			}));
			expectAction(result, 'conflict');
			expect(result.conflictMode).toBe('both');
		});

		it('deletes remote L0/R=', () => {
			expectAction(decide(input({
				local: 'L0',
				remote: 'R=',
			})), 'delete-remote');
		});

		it('deletes local L=/R0', () => {
			expectAction(decide(input({
				local: 'L=',
				remote: 'R0',
			})), 'delete-local');
		});

		it('forgets L0/R0 (both deleted)', () => {
			expectAction(decide(input({
				local: 'L0',
				remote: 'R0',
			})), 'forget');
		});

		it('conflicts LΔ/R0 (local modified, remote deleted)', () => {
			const result = decide(input({
				local: 'LΔ',
				remote: 'R0',
			}));
			expectAction(result, 'conflict');
			expect(result.conflictMode).toBe('local-only');
		});

		it('conflicts L0/RΔ (remote modified, local deleted)', () => {
			const result = decide(input({
				local: 'L0',
				remote: 'RΔ',
			}));
			expectAction(result, 'conflict');
			expect(result.conflictMode).toBe('remote-only');
		});
	});

	describe('plan item structure', () => {
		it('always includes the path', () => {
			const result = decide(input({ local: 'L=', remote: 'R=' }));
			expect(result.path).toBe('test.md');
		});

		it('includes conflictMode only for conflict actions', () => {
			const skip = decide(input({ local: 'L=', remote: 'R=' }));
			expect(skip.conflictMode).toBeUndefined();

			const conflict = decide(input({
				local: 'LΔ',
				remote: 'RΔ',
				localFingerprint: 'a',
				remoteFingerprint: 'b',
			}));
			expect(conflict.conflictMode).toBeDefined();
		});
	});

	describe('edge: unresolved conflict with artifacts and no local/remote', () => {
		it('skips even when local and remote are both absent', () => {
			const result = decide(input({
				hasUnresolvedConflict: true,
				hasConflictArtifacts: true,
				local: 'L0',
				remote: 'R0',
			}));
			expectAction(result, 'skip');
		});
	});
});
