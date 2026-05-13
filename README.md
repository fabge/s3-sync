# S3 Sync

Minimal AWS S3 sync plugin for Obsidian.

This rebuild intentionally keeps the plugin small:

- **AWS S3 only** — no R2, RustFS, WebDAV, Dropbox, OneDrive, or other providers
- **Sync only** — no snapshot backup system
- **No encryption layer** — plaintext objects in S3
- **Conflict-safe** — conflicting edits produce `LOCAL_` and `REMOTE_` files instead of silently overwriting data
- **Protect-modify guard** — sync aborts when too many files would change at once

## What it does

The plugin performs bi-directional vault sync against a single AWS S3 bucket. It keeps a local IndexedDB journal so it can compare:

1. your current local vault state
2. the current remote S3 state
3. the last successful sync baseline

That lets it detect uploads, downloads, deletions, and conflicts without a separate remote manifest.

## What it does not do

- No remote-provider abstraction
- No backup snapshots
- No encrypted payload mode
- No remote-prefix UX beyond the internal empty-prefix default
- No compatibility promise with older bucket layouts from previous forks

## Settings

The settings surface is intentionally small:

- AWS region
- Bucket
- Access key ID
- Secret access key
- Test connection
- Enable sync
- Auto-sync + interval
- Sync on startup
- Protect-modify percentage
- Exclude patterns
- Debug logging

The plugin always excludes its own folder from sync:

```text
.obsidian/plugins/s3-sync/
```

## Conflict behavior

When both local and remote changed in incompatible ways, the plugin keeps both copies:

- local version → `LOCAL_<filename>`
- remote version → `REMOTE_<filename>`

You resolve the conflict manually, keep the final file you want, and sync again.

## Bucket layout

Files are stored directly in the configured bucket/prefix as normal S3 objects. Custom metadata is used for sync bookkeeping such as:

- content fingerprint
- client mtime
- device ID
- payload format (`plaintext-v1`)

## Commands

- **Sync now**
- **Pause sync**
- **Resume sync**
- **Open settings**

## Development

```bash
npm install
npm run lint
npm run build
npm test
```

## Credits

This plugin is derived from [obsidian-s3-sync-and-backup](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup)
by Ceilão Labs, with the encryption and backup features removed and the storage
layer narrowed to AWS S3. See `LICENSE-ceilaolabs` for the original copyright.
