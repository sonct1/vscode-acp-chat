# Upstream provenance

- Upstream repository: `https://github.com/joel-jcs/antigravity-acp`
- Imported commit: `cb8421fce4a9f1451ba990a3eac7f0672077da97`
- Upstream license: MIT (`LICENSE` preserved in this directory)
- Import date: 2026-07-15
- Supported `agy`: `>= 1.1.0`
- Tested target: `agy 1.1.2`

No project-owned public fork URL is recorded here. Remote fork publication is pending because repository authentication is unavailable in this environment.

## Local patch categories

1. Node 22 runtime port:
   - Replaced Bun process/stdio/file APIs with Node `child_process`, `stream` Web adapters, and `fs/promises`.
   - Replaced `bun:sqlite` with read-only `node:sqlite` `DatabaseSync` access.
2. Product hardening:
   - Removed downloader/postinstall/installer path and bundled `agy` assumptions.
   - Added dynamic entrypoint preflight for `node:sqlite` availability and bounded validation for `agy >= 1.1.0`.
   - Added timeout/cache for `agy models`.
   - Added actionable error classification for auth, quota/rate-limit, timeout, process exit, DB binding, schema, and missing/tombstoned sessions.
3. Safety policy:
   - Only native modes `default`, `accept-edits`, and `plan` are allowed and emitted as `--mode <value>`.
   - Dangerous permission bypass and prompt-level plan injection are removed.
4. Persistence:
   - Namespaced default state at `~/.vscode-acp-chat/antigravity-acp`, overridable via `AGY_ACP_STATE_DIR`.
   - One atomic session JSON file per session under `sessions/`.
   - Tombstone marker files under `tombstones/`.
   - Legacy `~/.agy-acp/sessions.json` read/migrated but never written.
5. Concurrency:
   - Added bounded interprocess first-turn binding lock under the adapter state directory with per-owner tokens; live-PID locks are not reclaimed, and release only removes the current owner token.
   - First-turn binding now prefers exactly one PID-associated new DB using Linux `/proc/<pid>/fd` or macOS `lsof -p`, then falls back to strict snapshot diff with explicit none/single/ambiguous outcomes.
   - Candidate DBs must open and validate the expected `steps` schema before binding, and session binding is persisted while the lock is still held before the lock is released early.

## Sync commands

```sh
rm -rf /tmp/antigravity-acp-upstream
git clone https://github.com/joel-jcs/antigravity-acp /tmp/antigravity-acp-upstream
cd /tmp/antigravity-acp-upstream
git checkout cb8421fce4a9f1451ba990a3eac7f0672077da97
```

Then compare/update this vendor directory manually, preserving the local patch categories above and keeping all changes under `src/features/antigravity-agent/vendor/antigravity-acp/`.

## Known ACP / ToS limits

- This adapter drives the user-installed `agy` CLI and reads its local SQLite conversation databases; it does not bypass authentication or account limits.
- MCP forwarding is not claimed or implemented.
- Interactive permission prompting is not claimed or implemented; use native `agy` modes only.
- Schema compatibility depends on `agy` local DB layout; incompatible schema errors are surfaced with upgrade guidance.
