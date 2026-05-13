# Contributing to S3 Sync

This repo is a minimal AWS S3 sync plugin for Obsidian.

## Local development

```bash
npm install
npm run dev
```

Useful commands:

| Command | Description |
| :--- | :--- |
| `npm run dev` | Development build |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm test` | Full Jest suite |
| `npm run test:coverage` | Jest with coverage |
| `npm run test:watch` | Jest watch mode |

## Manual testing in Obsidian

1. Build the plugin with `npm run build`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<VaultPath>/.obsidian/plugins/s3-sync/
```

3. Reload Obsidian and enable the plugin.

## Project scope

Please keep changes aligned with the current design:

- AWS S3 only
- sync only
- no backup subsystem
- no encryption subsystem
- small, maintainable settings surface

## Code expectations

1. Keep TypeScript strict.
2. Update tests when behavior changes.
3. Update docs when scope or UX changes.
4. Prefer Obsidian/Vault APIs over Node-only runtime assumptions.

## Before opening a PR

```bash
npm run lint
npm run build
npm test
```
