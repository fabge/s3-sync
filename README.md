# S3 Sync

Minimal AWS S3 sync plugin for Obsidian.

This rebuild intentionally keeps the plugin small:

- **AWS S3 only** — no R2, RustFS, WebDAV, Dropbox, OneDrive, or other providers
- **Sync only** — no snapshot backup system
- **No encryption layer** — plaintext objects in S3
- **Three-way reconciliation** — local vault, remote S3 state, and the last successful sync baseline are compared on every run
- **Conflict-safe** — conflicting edits produce `LOCAL_` and `REMOTE_` files instead of silently overwriting data
- **Protect-modify guard** — sync aborts when too large a share of the already-synced files would change at once
- **No desktop-only runtime dependency** — built around Obsidian APIs, IndexedDB, and web APIs rather than Node/Electron modules

## What it does

The plugin performs bi-directional vault sync against a single AWS S3 bucket. It keeps a local IndexedDB journal so it can compare:

1. your current local vault state
2. the current remote S3 state
3. the last successful sync baseline

That lets it detect uploads, downloads, deletions, and conflicts without a separate remote manifest.

## Quick start

1. Open **Settings → S3 Sync**.
2. Enter your **AWS region**, **bucket**, **access key ID**, and **secret access key**.
3. Click **Test connection**.
4. Enable sync, optional auto-sync, and **Sync on startup** if you want a run when Obsidian opens.
5. Review **Exclude patterns** if you do not want parts of `.obsidian/` to propagate across devices.

## Settings

The settings surface is intentionally small:

| Setting | Description |
| :--- | :--- |
| **Region** | AWS region for the bucket, for example `eu-central-1`. |
| **Bucket** | Name of the S3 bucket that stores the synced vault. |
| **Access key ID** | AWS access key used for S3 requests. |
| **Secret access key** | AWS secret access key used for S3 requests. |
| **Test connection** | Verifies credentials and bucket access with a lightweight S3 request. |
| **Enable sync** | Master switch for bi-directional vault sync. |
| **Auto-sync** | Runs sync on a fixed interval. |
| **Sync interval** | Interval for auto-sync: 1, 2, 5, 10, 15, or 30 minutes. |
| **Sync on startup** | Runs one sync after the vault finishes loading. |
| **Abort if changed files exceed threshold** | Aborts sync when the share of already-synced files that would change exceeds the threshold. The first sync to a destination is exempt; use 100 to disable. |
| **Exclude patterns** | One glob pattern per line for files or folders that should never be synced. |
| **Reset sync journal** | Clears remembered baselines for the current bucket and region so the next sync starts fresh against that destination. |

The plugin always excludes its own folder from sync, including `data.json`:

```text
.obsidian/plugins/s3-sync/
```

Git metadata under any `.git` path is also always excluded.

## Permissions and data access

This plugin is a sync tool, so by design it enumerates vault files and reads or writes the ones that fall inside its sync scope.

### What the plugin reads

| API / storage | Why it is used |
| :--- | :--- |
| `vault.getFiles()` | Enumerates vault files so the planner can discover local state. |
| `vault.read()` / `vault.readBinary()` | Reads file contents before upload and when hashing ambiguous local changes. |
| IndexedDB journal | Loads per-file baselines, conflict records, and sync metadata from earlier successful runs. |

### What the plugin writes

| Destination | What is stored there |
| :--- | :--- |
| **S3 bucket root** | Synced vault files as normal S3 objects, plus content-fingerprint metadata. |
| **Local vault** | Downloaded files, updated files, parent folders created as needed, and `LOCAL_` / `REMOTE_` conflict artifacts. |
| **Local vault trash** | Files deleted remotely are removed through Obsidian's trash flow, respecting the user's deleted-files preference. |
| **IndexedDB** | Per-file sync baselines, unresolved conflict records, and metadata such as the last successful sync time. |
| **`data.json`** | Plugin settings such as AWS credentials, sync toggles, interval, threshold, and exclude patterns. |

### What leaves your device

- **Only traffic to the configured AWS S3 bucket** for connection tests, listings, uploads, downloads, and deletes.
- **Vault file contents** for in-scope files.
- **Object metadata** written by the plugin: content fingerprint.
- **No telemetry, analytics, crash reporting, or update polling.**

### What is not included

- No encryption layer. Objects are stored in S3 as plaintext payloads.
- No access outside the current vault.
- No Node.js shell, filesystem, or Electron APIs.

> **Important:** other files under `.obsidian/` are in scope unless you exclude them yourself. The default patterns exclude `workspace*` and `.trash/**`, but not every config file.

## Conflict behavior

When both local and remote changed in incompatible ways, the plugin keeps both copies:

- local version → `LOCAL_<filename>`
- remote version → `REMOTE_<filename>`

You resolve the conflict manually, keep the final file you want, and sync again.

Deleting both artifact files without recreating the original restores the remote copy on the next sync — dismissing a conflict never deletes anything.

## Multi-device behavior

- Each device keeps its own IndexedDB journal.
- Sync decisions compare **local state**, **remote S3 state**, and the **last successful baseline** remembered on that device.
- If two devices modify the same file independently, the plugin creates `LOCAL_` and `REMOTE_` copies instead of silently picking one side.

## Bucket layout

Files are stored directly at the bucket root as normal S3 objects. The plugin writes content-fingerprint metadata for sync bookkeeping.

## Security and operational notes

- **Plaintext objects in S3:** if you need encryption at rest, configure AWS-side bucket encryption separately. The plugin itself does not encrypt payloads.
- **Scheduled sync requires the app to be active:** mobile operating systems may suspend background work, so iOS and Android users should expect sync to run while Obsidian is open and active.
- **Changing bucket or region is effectively a new destination:** sync is blocked until you explicitly use **Reset sync journal** in Advanced settings, which prevents stale baselines from driving the wrong plan against a different remote.

## Commands

- **Sync now**
- **Open settings**

## FAQ

**Does this work on mobile?**

It is designed to. The plugin avoids Node/Electron APIs and uses Obsidian APIs plus browser features such as IndexedDB and Web Crypto. The main practical caveat is that iOS and Android may suspend background activity when Obsidian is not foregrounded.

**Can I use this alongside Obsidian Sync?**

It is not recommended. Running two sync systems against the same files increases the chance of races and conflicts.

**What files are excluded by default?**

The editable defaults are `**/workspace*` and `.trash/**`. Git metadata under any `.git` path and the plugin's own folder under `.obsidian/plugins/s3-sync/` are always excluded independently of these settings.

## Development

```bash
npm install
npm run lint
npm run build
npm test
```

## BRAT releases

This repo is laid out in a BRAT-friendly way: the release assets BRAT needs are the root-level `manifest.json`, `main.js`, and `styles.css`.

A GitHub Actions workflow at `.github/workflows/release.yml` automates that release flow:

1. bump `manifest.json` to the version you want to ship
2. create and push a matching tag, for example `0.1.1` or `v0.1.1`
3. the workflow will lint, test, build, create a GitHub release, and attach:
   - `manifest.json`
   - `main.js`
   - `styles.css`

The workflow fails if the release tag version does not match `manifest.json`.

## Credits

This plugin is a stripped-down reinterpretation of
[`ceilaolabs/obsidian-s3-sync-and-backup`](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup) —
the original ("OG") project that inspired it. That repo is the full-featured
take (multiple storage providers, encryption, scheduled backups). This one
deliberately keeps a much smaller surface: AWS S3 only, sync only, no
encryption. Several safety and correctness ideas here (weak-ETag normalization,
destination-fingerprint / stale-journal protection, the destructive-plan block,
and the **Reset sync journal** action) are borrowed from it. Credit for the
original concept goes to its authors.
