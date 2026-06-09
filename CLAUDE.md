# CLAUDE.md

Project guidance for LLMs and other automated contributors.

## Project shape

- This repo is inspired by `ceilaolabs/obsidian-s3-sync-and-backup`, but is intentionally stripped down.
- Keep that inspiration in mind, but do not pull in scope, features, or abstractions unless they are clearly needed here.
- This project prefers a smaller surface area over feature parity.

## Core rules

- Keep it **KISS**.
- Keep it minimal.
- No fluff in code, docs, comments, or change scope.
- Prefer deleting code over adding code.
- Prefer straightforward code over clever code.
- Prefer explicit behavior over abstraction for its own sake.

## Legacy and compatibility

- Do **not** carry technical baggage just to preserve hypothetical compatibility.
- Prefer breaking changes over migrations, shims, fallback paths, or legacy branches when they keep the codebase simpler.
- Do not add compatibility layers unless there is a current, real user need.
- Do not keep dead code, unused APIs, or future-facing scaffolding around "just in case".

## Technical debt

- Actively remove technical debt when touching nearby code.
- Do not introduce new abstractions unless they reduce real complexity right now.
- Do not add indirection for imagined future reuse.
- Tests and docs should describe the current system, not historical migrations we no longer support.

## Upstream comparison rule

When borrowing ideas from the reference repo:

- port only what fits this repo's smaller scope,
- simplify aggressively,
- drop anything that adds operational or conceptual weight,
- avoid bringing over backup/encryption/provider-matrix style complexity unless explicitly wanted.

## Upstream release review

- Reference repo: `ceilaolabs/obsidian-s3-sync-and-backup` — the original ("OG") project this one is a stripped-down reinterpretation of.
- Future contributors should check that repo's latest GitHub releases and release notes before larger changes.
- Evaluate whether any newer upstream safety or correctness fixes should be adopted here.
- Also evaluate older upstream release-note items that were not implemented yet, but only if they still fit this repo's stripped-down scope.
- Last reviewed: upstream **4.1.2** (2026-06-09). All in-scope safety/correctness fixes through 4.1.x were already adopted here (weak-ETag handling, journal reset, destructive-deletion safeguard, stale-journal clearing; our `deviceId` already uses `crypto.randomUUID`). Newer upstream items are out of scope (RustFS provider, encryption, backups, store-compliance renames, their dependency bumps). Nothing to adopt.

### Upstream-derived changes already adopted here

- vault-local `deviceId` instead of keeping it in synced settings,
- weak ETag normalization,
- destination fingerprint / stale-journal protection,
- blocking destructive sync plans on an unseen destination,
- explicit **Reset sync journal** action,
- README additions around permissions, data access, mobile caveats, and operational guidance.

### Upstream-derived changes intentionally not adopted

- encryption,
- backup features,
- provider-matrix or broader compatibility complexity,
- migration baggage or legacy compatibility code kept only for old installs.
