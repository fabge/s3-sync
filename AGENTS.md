# Project guidance

This is a deliberately small reinterpretation of `ceilaolabs/obsidian-s3-sync-and-backup`. Keep the surface smaller than the reference project: AWS S3 sync only, with no encryption, backups, provider matrix, migrations, or compatibility scaffolding unless a current requirement demands it.

Prefer deleting code over adding abstractions. Keep behavior explicit, port only upstream safety or correctness fixes that fit the current scope, and remove nearby technical debt when touching code. Tests and documentation should describe the current system rather than its history.

The latest reviewed upstream release is 4.1.2 (2026-06-09). This project already includes the relevant weak-ETag handling, destination fingerprint guard, destructive-deletion safeguard, stale-journal clearing, and explicit journal reset. RustFS support, encryption, backups, store-compliance renames, and broader provider compatibility remain out of scope.
