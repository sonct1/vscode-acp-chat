# Vendored Antigravity ACP Adapter

This directory contains a self-contained vendored ACP adapter for Google Antigravity `agy` CLI, ported to the Node 22 runtime used by this product.

## Runtime requirements

- Node.js 22 with `node:sqlite` available.
- `agy >= 1.1.0` (tested target: 1.1.2).
- `agy` must already be installed and authenticated. This adapter does not download, install, or bundle `agy`.

Binary resolution order:

1. `AGY_BIN`
2. `agy` / `agy.exe` on `PATH`

If authentication fails, run interactive `agy` in a terminal and complete login/OAuth.

## State

Default adapter state is namespaced at:

```text
~/.vscode-acp-chat/antigravity-acp
```

Override with `AGY_ACP_STATE_DIR`. Session bindings are stored as one JSON file per session under `sessions/`; tombstones are marker files under `tombstones/`; model cache is `models.json`; first-turn binding locks live under `locks/` in this state directory. Legacy `~/.agy-acp/sessions.json` is read and migrated, but new writes only use the namespaced format.

## Modes

Only native agy modes are supported and always emitted as `--mode <value>`:

- `default`
- `accept-edits`
- `plan`

This adapter intentionally does not support dangerous permission bypass flags, prompt-level plan injection, MCP forwarding, or interactive permission prompts.

## First-turn binding

For a new ACP session, the adapter serializes first-turn native conversation discovery with a state-directory owner-token lock. While the lock is held it starts `agy`, snapshots existing `*.db` files, accepts only a schema-valid new DB, persists the session binding, then releases the lock early. On Linux it first checks `/proc/<pid>/fd`; on macOS it first checks `lsof -p`; otherwise it uses a strict snapshot diff fallback. If no DB or multiple candidate DBs are found, the prompt fails with an actionable `no_db` or `ambiguous_binding` error even if `agy` produced stdout or exited successfully.

## Local verification

```sh
npm run typecheck
npm run test:node
```
