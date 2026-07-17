# VS Code-style Permission Dialog Implementation Plan

## Purpose

Improve the ACP permission prompt so it is wider, readable for long commands and paths, and visually consistent with current VS Code widget and action patterns without changing ACP permission semantics.

The current fallback modal in the screenshot is narrow, uses every choice as a full-width primary blue button, repeats labels such as `Always Allow: Always Allow for Session`, and exposes horizontal overflow for long option text. The embedded permission prompt inside a matching tool block is already closer to the desired compact VS Code style and should remain available.

## Current State

### Runtime flow

- ACP receives `session/requestPermission` in `src/acp/client.ts`.
- Legacy single-session handling queues the request in `src/views/chat.ts`, posts `permissionRequest`, and cancels it after 60 seconds when unanswered.
- Multi-session handling keeps an independent permission queue in `src/features/multi-session/host.ts`, persists pending permission render messages, and restores them when the owning session is activated.
- `src/views/webview/main.ts` routes `permissionRequest` to `PermissionDialog`.
- `src/views/webview/widget/permission-dialog.ts` renders:
  - an embedded prompt when the matching tool block exists;
  - otherwise a modal overlay appended to the webview body.
- `media/main.css` owns both modal and embedded permission styles.

### Root causes visible in the screenshot

1. `.permission-dialog` is capped at `max-width: 400px`, so it remains cramped even when the webview has substantially more horizontal space.
2. `.permission-options` is a vertical flex column and every `.permission-option-btn` uses the primary `--vscode-button-*` colors, so all choices look equally dominant.
3. Modal option text is composed as `${kind label}: ${agent option name}`. This duplicates text such as `Allow Once: Allow Once` and produces excessively long rows for command-scoped permission names.
4. Long command, URL, path, and option strings have no dedicated wrapping or truncation contract. The dialog lacks defensive `min-width: 0`, `overflow-wrap`, and `overflow-x` rules at the content/action level.
5. The custom modal does not currently declare `role="dialog"`, `aria-modal`, labelled/described relationships, initial focus, Escape handling, or focus restoration.
6. Permission and confirm dialogs duplicate most overlay, shell, header, body, and button styling.

## Target UX

The permission surface should read as a VS Code editor widget rather than a stack of web-page buttons:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 🔒 Permission required                                               │
├──────────────────────────────────────────────────────────────────────┤
│ Tool call                                                            │
│ Execute · curl -fsSL https://raw.githubusercontent.com/...            │
│                                                                      │
│ The agent wants to run this command.                                 │
│                                                                      │
│                                      [Reject] [Allow once]            │
│                                      [Always allow ▼]                 │
└──────────────────────────────────────────────────────────────────────┘
```

Principles:

- Use the available webview width, but remain responsive in a narrow Secondary Sidebar.
- Show tool/action context first; keep action labels short and unambiguous.
- Use one clear primary action. Secondary and persistent-scope choices must not all look like primary blue actions.
- Preserve every ACP `optionId`; presentation may group or restyle choices but must not synthesize unsupported permission outcomes.
- Wrap human-readable text and safely handle long unbroken commands, URLs, and paths without horizontal page/dialog scrolling.
- Keep modal interaction accessible and keyboard-operable.
- Keep the existing embedded-in-tool-block path, with the same action hierarchy and text formatting as the modal where practical.

## Architecture Decisions

- Treat this as a focused product UI feature under `src/features/permission-ui/` rather than adding more substantial logic to `src/views/webview/main.ts` or the existing core widget.
- The feature owns webview presentation and typed permission view models. ACP queue ownership, 60-second timeout, and legacy/multi-session resolution remain in their current host implementations.
- Register the webview feature through `src/features/register-webview.ts`. Keep the core integration to a small dispatch/registration point.
- Normalize duplicated labels in the webview presentation layer only. The ACP option `name`, `kind`, and `optionId` remain unchanged in the transport.
- Reuse VS Code theme tokens, especially `editorWidget.*`, `widget.*`, `button.*`, `button.secondary*`, `focusBorder`, `list.hoverBackground`, and existing `--acp-flat-*` fallbacks.
- Share a small generic modal shell with the existing confirm dialog only if extraction remains small and does not force permission-specific behavior into a generic abstraction. Permission-specific content and action mapping stay inside the feature.
- Do not move the permission decision to a native `QuickPick`: this prompt requires tool context, security copy, primary/secondary action hierarchy, and compatibility with the existing embedded tool-block surface.

## Implementation Phases

### Phase 1 — Typed permission presentation contract

#### Task 1: Add permission UI types and normalization helpers

**Description:** Define a typed permission request/view model and convert ACP option metadata into concise presentation labels.

**Acceptance criteria:**

- [ ] The webview uses explicit types for permission tool context and permission options.
- [ ] Known kinds map to stable action labels: `Allow once`, `Always allow`, `Reject`, and `Always reject`.
- [ ] Repeated names such as `Allow Once: Allow Once` are collapsed to one label.
- [ ] Agent-provided detail that adds real scope, such as `Allow for Session` or `Commands starting with ...`, is retained as secondary text rather than concatenated into the main button label.
- [ ] Unknown permission kinds still render safely using the agent-provided name and remain selectable by their original `optionId`.
- [ ] Empty option arrays produce one safe cancel/reject presentation without mutating the input array.

**Likely files:**

- `src/features/permission-ui/types.ts`
- `src/features/permission-ui/webview.ts`
- `src/views/webview/types.ts` only for the smallest compatible message typing improvement if required

**Verification:**

- Unit tests for known kinds, duplicate-label removal, long command scope, unknown kinds, and empty options.

### Phase 2 — Responsive VS Code-style modal

#### Task 2: Build the new modal structure

**Description:** Replace the current fallback modal DOM with a wider responsive editor-widget layout.

**Acceptance criteria:**

- [ ] Dialog width follows the available viewport with a target comfortable width around 560–640 px and a safe narrow-sidebar fallback.
- [ ] The dialog never exceeds the webview viewport and uses `box-sizing: border-box`.
- [ ] Tool kind, title, and optional description are visually separated from actions.
- [ ] Long text uses wrapping/breaking rules and no modal/body/action element creates horizontal scrolling.
- [ ] Vertical scrolling remains inside the dialog body when content exceeds viewport height.
- [ ] Background, foreground, border, shadow, radius, and focus state follow VS Code theme variables.

**Likely files:**

- `src/features/permission-ui/webview.ts`
- `src/features/permission-ui/styles.ts`
- `src/features/register-webview.ts`
- `src/views/webview/main.ts` for minimal registration/dispatch cleanup

**Recommended responsive CSS direction:**

```css
width: min(640px, calc(100vw - 32px));
max-height: min(720px, calc(100vh - 32px));
min-width: 0;
box-sizing: border-box;
overflow-x: hidden;
```

Use `overflow-wrap: anywhere` for command/path/detail text and `min-width: 0` on flex/grid children.

#### Task 3: Apply VS Code action hierarchy

**Description:** Stop rendering all permission choices as identical primary buttons.

**Acceptance criteria:**

- [ ] `Allow once`, when present, is the primary action using `--vscode-button-background`.
- [ ] Reject/cancel is a secondary action using `--vscode-button-secondary*` tokens.
- [ ] Persistent choices (`Always allow`, `Always reject`, command/session scoped choices) are visually secondary and grouped separately from the immediate decision.
- [ ] If the agent supplies multiple allow/reject variants, every original option remains reachable.
- [ ] Security meaning is not conveyed by color alone; text and codicons remain explicit.
- [ ] Buttons have concise primary labels, with long scope text shown below or beside the label and allowed to wrap.

**Recommended layout:**

- Immediate actions in a bottom action row: `Reject` + `Allow once`.
- Persistent/special scopes in a compact list or separate `More choices` section above the action row.
- At very narrow widths, the action row wraps or stacks without overflowing.

### Phase 3 — Embedded prompt consistency

#### Task 4: Align embedded permission UI with the modal

**Description:** Keep permission prompts embedded in matching tool blocks, but reuse the same option normalization and visual hierarchy.

**Acceptance criteria:**

- [ ] Embedded and modal prompts use the same concise labels and secondary scope text.
- [ ] The embedded prompt remains compact and does not turn into a large modal-like card.
- [ ] Long command/path text wraps inside the tool block.
- [ ] All actions remain keyboard focusable and theme-aware.
- [ ] Resolving the prompt removes only the relevant embedded permission UI.

**Likely files:**

- `src/features/permission-ui/webview.ts`
- `src/features/permission-ui/styles.ts`

### Phase 4 — Accessibility and lifecycle hardening

#### Task 5: Add modal semantics and keyboard behavior

**Description:** Make the permission dialog behave like a blocking VS Code modal inside the webview.

**Acceptance criteria:**

- [ ] Dialog has `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and `aria-describedby` where content exists.
- [ ] Initial focus goes to the safest immediate action: reject/cancel by default, not an irreversible persistent allow.
- [ ] `Escape` resolves the permission as cancelled/rejected when a reject/cancel path exists.
- [ ] `Tab` and `Shift+Tab` remain inside the active modal.
- [ ] Focus returns to the previously focused webview element after resolution.
- [ ] Backdrop behavior is explicit and tested; recommendation: backdrop click does not silently approve and should cancel only if it maps to the same safe cancellation outcome as Escape.
- [ ] Replayed or duplicate pending permission messages do not create duplicate active dialogs for the same request ID.
- [ ] Timed-out or externally resolved requests can remove stale UI when the host sends or exposes a dismissal signal; if no signal exists, add the smallest typed host-to-webview dismissal message.

**Likely files:**

- `src/features/permission-ui/webview.ts`
- `src/features/permission-ui/types.ts`
- Legacy/multi-session host files only if an explicit dismissal message is needed

### Phase 5 — Shared modal styling cleanup

#### Task 6: Remove duplicated permission/confirm shell styling

**Description:** Consolidate common dialog shell behavior after the permission UI is stable.

**Acceptance criteria:**

- [ ] Permission and confirm dialogs share only genuinely generic overlay/shell/header/body/action primitives.
- [ ] Confirm dialog behavior remains unchanged except for intentional accessibility improvements covered by tests.
- [ ] Permission-specific option grouping and security semantics are not pushed into the generic modal helper.
- [ ] Old `.permission-dialog*` rules and dead widget code are removed only after all imports and tests migrate.

**Likely files:**

- `src/views/webview/widget/confirm-dialog.ts`
- optional `src/views/webview/widget/modal-dialog.ts`
- `media/main.css`
- `src/features/permission-ui/`

### Phase 6 — Tests, documentation, packaging, and local install

#### Task 7: Add regression coverage

**Required tests:**

- [ ] Overlay rendering when no matching tool block exists.
- [ ] Embedded rendering when a matching tool block exists.
- [ ] Concise label normalization with the exact screenshot-style options.
- [ ] Correct `permissionResponse` payload preserves `requestId` and selected `optionId`.
- [ ] Reject/Escape returns `cancelled` and never selects an allow option.
- [ ] Initial focus, focus trap, and focus restoration.
- [ ] Duplicate request IDs do not create duplicate UI.
- [ ] Long unbroken command/URL/path receives wrapping classes and action text is split into label/detail.
- [ ] Empty and unknown option lists remain safe.
- [ ] Multi-session pending permission replay still renders and resolves through the existing owner-aware host path.

**Likely files:**

- `src/test/features/permission-ui.test.ts`
- `src/test/features/multi-session.test.ts`
- `src/test/permission.test.ts` only for host/protocol behavior that changes

#### Task 8: Update layout and feature documentation

**Acceptance criteria:**

- [ ] `docs/architecture/acp-chat-layout.md` maps the permission feature files, modal/embedded behavior, responsive layout, and message flow.
- [ ] `docs/features/feature-catalog.md` describes the improved permission action hierarchy and keyboard behavior.
- [ ] This plan receives completion notes when implementation finishes.

#### Task 9: Run required quality gates and install the extension

**Verification order:**

```bash
npm run check-types
npm run lint
npm run compile-tests
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-permission-ui.vsix
code --install-extension .tmp/vscode-acp-chat-permission-ui.vsix --force
```

- Remove the temporary VSIX after successful installation when safe.
- Do not commit generated VSIX files.
- Tell the user to run `Developer: Reload Window` after installation.

## Expected Files

Primary implementation:

- `src/features/permission-ui/types.ts`
- `src/features/permission-ui/webview.ts`
- `src/features/permission-ui/styles.ts`
- optional `src/features/permission-ui/index.ts`
- `src/features/register-webview.ts`

Small integration or cleanup:

- `src/views/webview/main.ts`
- `src/views/webview/types.ts`
- `src/views/webview/widget/permission-dialog.ts` removed or reduced after migration
- `src/views/webview/widget/confirm-dialog.ts`
- optional `src/views/webview/widget/modal-dialog.ts`
- `media/main.css`

Tests/docs:

- `src/test/features/permission-ui.test.ts`
- `src/test/features/multi-session.test.ts`
- `docs/architecture/acp-chat-layout.md`
- `docs/features/feature-catalog.md`
- `docs/plans/README.md`

## Risks and Mitigations

| Risk                                                                                  | Impact | Mitigation                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restyling accidentally changes ACP outcome semantics                                  | High   | Preserve `optionId` and host queue logic; presentation maps labels only. Add payload assertions for every option kind.                                         |
| Multiple or agent-specific option variants do not fit the preferred two-button layout | Medium | Keep immediate actions in the footer and render remaining original options in a secondary choices list. Never drop an option.                                  |
| Dialog becomes wider than a narrow Secondary Sidebar                                  | Medium | Use viewport-based `min()` width, `min-width: 0`, wrapped actions, and narrow-width tests/manual checks.                                                       |
| Long command strings still cause horizontal scrolling                                 | Medium | Apply wrapping at tool context, detail, and action text layers; explicitly hide x-overflow only on the dialog/body after validating content remains reachable. |
| Permission timeout leaves stale modal visible                                         | Medium | Add an explicit request dismissal path if current host flow cannot notify the webview; test timeout/external-resolution cleanup.                               |
| Focus trap conflicts with composer/autocomplete key handling                          | Medium | Attach keyboard handling only while the modal is active, stop handled events, restore focus on cleanup, and add JSDOM coverage.                                |
| Refactoring confirm dialog broadens scope                                             | Low    | Complete permission behavior first; extract only small stable modal primitives and retain confirm regression tests.                                            |
| Styling looks correct in dark theme only                                              | Low    | Use VS Code tokens and manually verify dark, light, high-contrast, normal width, and narrow width.                                                             |

## Definition of Done

- Permission modal is visibly wider and uses available webview space without exceeding the viewport.
- Long commands, URLs, paths, and option descriptions wrap without horizontal scrolling.
- The dialog uses VS Code editor-widget colors, borders, shadow, focus ring, primary button, and secondary button tokens.
- Only the immediate allow action is primary; reject and persistent permission scopes have clear secondary hierarchy.
- Duplicate labels are removed while all ACP options and original `optionId` values remain available.
- Embedded and modal permission prompts are visually and behaviorally consistent.
- Keyboard, ARIA, focus, timeout/dismissal, replay, and duplicate-request behavior are covered.
- Architecture and feature documentation are updated.
- Typecheck, lint, tests, production package, VSIX creation, and local forced installation succeed.
