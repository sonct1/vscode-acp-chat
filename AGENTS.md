# Repository Development Rules

## Custom feature organization

All new product-specific or custom functionality must be organized under:

```text
src/features/<feature-name>/
```

Do not place substantial custom feature logic directly in upstream/core files such as:

- `src/extension.ts`
- `src/views/chat.ts`
- `src/acp/client.ts`
- `src/views/webview/main.ts`
- `src/views/webview/component/message-list.ts`

Core files may contain only the smallest stable integration point needed to register or dispatch a feature.

### Feature structure

Use only the files required by the feature:

```text
src/features/
├── <feature-name>/
│   ├── host.ts
│   ├── webview.ts
│   ├── types.ts
│   └── index.ts
├── register-host.ts
└── register-webview.ts
```

File responsibilities:

- `host.ts`: VS Code Extension Host logic. It may import `vscode`, access the workspace, filesystem, commands, APIs, ACP client, and extension state.
- `webview.ts`: browser/webview UI and DOM logic. It must not import or call the `vscode` Node module directly; communicate through `WebviewContext` and `postMessage`.
- `types.ts`: feature-specific message contracts, domain types, and data shared between host and webview.
- `index.ts`: optional public exports for the feature. Do not combine host and browser entry points in a way that causes cross-environment imports.
- `register-host.ts`: the single registry for Extension Host features.
- `register-webview.ts`: the single registry for webview features.

A feature that does not need both environments should omit unnecessary files. For example, a command-only feature may contain only `host.ts`.

### Integration rules

- Register Extension Host functionality through `src/features/register-host.ts`.
- Register webview functionality through `src/features/register-webview.ts`.
- Route feature messages through a shared feature dispatcher/router instead of adding large feature implementations to `ChatViewProvider` switch statements.
- Keep integrations in upstream/core files limited to imports, registration calls, or generic dispatch calls.
- Prefer adding new files over modifying upstream files.
- Do not copy core implementations into a feature. Depend on stable interfaces or extract a generic interface when necessary.
- Keep dependencies one-way: core integration points may call feature registries; one feature must not reach into another feature's private files.
- Shared generic code used by multiple features belongs in `src/features/shared/` only when actual reuse exists.

### Naming

- Use kebab-case for feature directories, for example `session-export` and `prompt-library`.
- Prefix webview messages with `feature.<feature-name>.`, for example `feature.session-export.export`.
- Prefix custom commands and configuration keys with a dedicated product namespace instead of reusing unrelated upstream identifiers.

### Tests

Place feature tests under:

```text
src/test/features/<feature-name>.test.ts
```

Prefer testing feature modules directly. Modify existing upstream tests only when the feature intentionally changes existing upstream behavior.

### Scope exception

Generic bug fixes, protocol compatibility changes, and refactors intended for contribution back to upstream may modify core modules directly. Keep those changes in commits separate from product-specific feature work.

# Agent Instructions

Default coding flow:

- Use `rg`, read exact code files, edit minimally.
- Run the smallest relevant verification.
- Do not read broad docs unless the task touches product scope, feature scope, architecture, API contract, operations, or implementation plan.

Build and local installation after code changes:

- After changing extension or webview code, always build, package, and install the new extension version into VS Code before reporting completion.
- Run the relevant quality checks first, then build the production bundle with `npm run package`.
- Create a VSIX with `npx vsce package --out <temporary-or-versioned-path>.vsix`.
- Install it with `code --install-extension <path>.vsix --force`.
- Do not commit generated VSIX files. Remove temporary VSIX files after successful installation when safe, or place them in a git-ignored path.
- Report the exact build, packaging, and installation commands and their outcomes. If `code` or VSIX packaging is unavailable, report the blocker explicitly instead of claiming the installed extension is current.
- Tell the user to run `Developer: Reload Window` when reloading is required for the newly installed extension to take effect.

Docs routing:

- Service overview/local setup: `README.md`
- Product scope: `docs/product/README.md`
- Feature catalog: `docs/features/README.md`
- Service architecture: `docs/architecture/README.md`
- ADRs: `docs/architecture/adr/README.md`
- Technical designs: `docs/design/README.md`
- Service interface contracts (REST APIs, events, payloads, errors): `docs/contracts/README.md`
- Engineering standards: `docs/engineering/README.md`
- Operations/runbooks: `docs/operations/README.md`
- Implementation plans: `docs/plans/README.md`

Documentation index rules:

- Treat every `README.md` under `docs/` as the index, routing guide, conventions, and scope rules for the directory it is in.
- Before creating documentation, read the nearest parent `README.md` and place content in the document type and filename it defines.
- Do not replace a docs `README.md` with project analysis, feature details, architecture content, contracts, or operational procedures.
- Change a docs `README.md` only to keep its directory index accurate: add, remove, or update links and short descriptions of documents located in that directory while preserving its existing guide/convention/rule content.
- Put substantive content in dedicated non-index files such as `service-prd.md`, `business-flows.md`, `feature-catalog.md`, `system-overview.md`, `integration-contracts.md`, `testing.md`, or `troubleshooting.md`.
- When adding, moving, renaming, or deleting a document, update only the relevant directory index and any directly affected routing links.

Feature management:

- Use `docs/features/README.md` to discover registered durable feature docs.
- Use `docs/features/FEAT-NNNN-<slug>/` only when a feature spans product/design/API/implementation concerns.
- Use Beads for active task graph, dependencies, status, and execution units.
- Do not use feature docs or `docs/plans/` as backlog.
- Do not create feature docs or beads for tiny one-shot fixes.
