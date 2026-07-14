# pi-acp upstream provenance

- Repository: https://github.com/svkozak/pi-acp.git
- Imported version: v0.0.31
- Imported commit: 9e857dcc05a057404eb1537e5f31e5aef88a5863
- Import date: 2026-07-14
- License: MIT, preserved in `LICENSE`.

## Local patches

- Built by the VS Code extension's root `esbuild.js` into `dist/pi-acp/index.mjs`.
- No vendored `node_modules` or generated upstream `dist/` files are committed.
- The adapter is launched by the extension with VS Code/Electron in Node mode and still requires the `pi` CLI on `PATH`.

## Sync procedure

1. Fetch the desired upstream tag/commit from `https://github.com/svkozak/pi-acp.git`.
2. Replace this directory's source and metadata files, preserving this `UPSTREAM.md`.
3. Update the imported version/commit/date above and record any local patches.
4. Run the extension verification pipeline, including VSIX content check for `dist/pi-acp/index.mjs`.
