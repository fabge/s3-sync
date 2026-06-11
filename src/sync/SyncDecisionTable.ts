/**
 * Deterministic three-way sync decision table; all I/O stays in planner/executor.
 *
 * Each file is classified independently on both sides relative to the journal baseline:
 * - `L0 / R0` — absent (never existed or already deleted)
 * - `L+ / R+` — new (no baseline record exists)
 * - `L= / R=` — unchanged (matches baseline fingerprint/mtime)
 * - `LΔ / RΔ` — modified (differs from baseline)
 *
 * The Cartesian product of these states plus the conflict flag fully determines
 * the action with no further I/O.
 */

import {
	ConflictMode,
	DecisionInput,
	SyncAction,
	SyncPlanItem,
} from '../types';

export function decide(input: DecisionInput): SyncPlanItem {
	if (input.hasUnresolvedConflict) {
		return decideConflictMode(input);
	}

	// Without a baseline, whichever side exists classifies as new ('+').
	if (input.local === 'L+' || input.remote === 'R+') {
		return decideNoBaseline(input);
	}

	return decideWithBaseline(input);
}

/**
 * Mode 1 — unresolved conflict. While artifacts remain the user hasn't merged;
 * once they're gone, which side still exists decides the follow-up. The plugin
 * itself renames the original away while a conflict is open, so a missing
 * original is never treated as intent to delete — the remote copy is restored
 * instead, and the user can delete the restored file if that's what they meant.
 *
 * | Local original | Artifacts present | Action             |
 * |----------------|-------------------|--------------------|
 * | any            | yes               | skip               |
 * | exists         | no                | upload (resolved)  |
 * | absent + R exists | no             | download (restore) |
 * | absent + R absent | no             | forget             |
 */
function decideConflictMode(input: DecisionInput): SyncPlanItem {
	if (input.hasConflictArtifacts) {
		return plan(input.path, 'skip');
	}

	if (input.local !== 'L0') {
		return plan(input.path, 'upload');
	}

	if (input.remote !== 'R0') {
		return plan(input.path, 'download');
	}

	return plan(input.path, 'forget');
}

/**
 * Mode 2 — no baseline (first sync). Compare existence only; when both sides
 * exist, fall back to fingerprint: identical → adopt, differing → conflict(both).
 *
 * | Local | Remote | Action                                    |
 * |-------|--------|-------------------------------------------|
 * | L+    | R0     | upload                                    |
 * | L0    | R+     | download                                  |
 * | L+    | R+     | adopt (same fingerprint) / conflict(both) |
 */
function decideNoBaseline(input: DecisionInput): SyncPlanItem {
	const { local, remote, path } = input;

	if (local === 'L+' && remote === 'R0') {
		return plan(path, 'upload');
	}

	if (local === 'L0' && remote === 'R+') {
		return plan(path, 'download');
	}

	if (local === 'L+' && remote === 'R+') {
		if (fingerprintsMatch(input)) {
			return plan(path, 'adopt');
		}
		return planConflict(path, 'both');
	}

	return plan(path, 'skip');
}

/**
 * Mode 3 — baseline exists. The baseline reveals which side diverged;
 * asymmetric changes propagate, edit/delete asymmetries become conflicts so
 * no data is silently lost.
 *
 * | Local | Remote | Action                                            |
 * |-------|--------|---------------------------------------------------|
 * | L=    | R=     | skip                                              |
 * | LΔ    | R=     | upload                                            |
 * | L=    | RΔ     | download                                          |
 * | LΔ    | RΔ     | adopt (same fingerprint) / conflict(both)         |
 * | L0    | R=     | delete-remote                                     |
 * | L=    | R0     | delete-local                                      |
 * | L0    | R0     | forget                                            |
 * | LΔ    | R0     | conflict(local-only) — local edited, remote gone  |
 * | L0    | RΔ     | conflict(remote-only) — remote edited, local gone |
 */
function decideWithBaseline(input: DecisionInput): SyncPlanItem {
	const { local, remote, path } = input;

	if (local === 'L=' && remote === 'R=') {
		return plan(path, 'skip');
	}

	if (local === 'LΔ' && remote === 'R=') {
		return plan(path, 'upload');
	}

	if (local === 'L=' && remote === 'RΔ') {
		return plan(path, 'download');
	}

	if (local === 'LΔ' && remote === 'RΔ') {
		if (fingerprintsMatch(input)) {
			return plan(path, 'adopt');
		}
		return planConflict(path, 'both');
	}

	if (local === 'L0' && remote === 'R=') {
		return plan(path, 'delete-remote');
	}

	if (local === 'L=' && remote === 'R0') {
		return plan(path, 'delete-local');
	}

	if (local === 'L0' && remote === 'R0') {
		return plan(path, 'forget');
	}

	if (local === 'LΔ' && remote === 'R0') {
		return planConflict(path, 'local-only');
	}

	if (local === 'L0' && remote === 'RΔ') {
		return planConflict(path, 'remote-only');
	}

	return plan(path, 'skip');
}

function fingerprintsMatch(input: DecisionInput): boolean {
	return (
		input.localFingerprint !== undefined &&
		input.remoteFingerprint !== undefined &&
		input.localFingerprint === input.remoteFingerprint
	);
}

function plan(path: string, action: SyncAction): SyncPlanItem {
	return { path, action };
}

function planConflict(path: string, mode: ConflictMode): SyncPlanItem {
	return { path, action: 'conflict', conflictMode: mode };
}
