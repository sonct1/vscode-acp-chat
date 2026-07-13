# Implementation Plan: Searchable Model Picker

## Overview

Model selection in the ACP Chat webview currently uses a custom dropdown that renders every model option but has no search input or keyboard filtering. Users with many ACP models must scroll manually and cannot search by display name. This plan adds optional search behavior to the reusable dropdown widget and enables it only for the model picker, preserving existing mode/config dropdown behavior.

## Current Extension Analysis

Relevant flow:

- `src/views/chat.ts` renders the initial `#model-dropdown` DOM: `.dropdown-trigger`, `.selected-label`, and `.dropdown-popover`.
- `src/views/webview/component/session-toolbar.ts` owns model metadata rendering. `updateModelDropdown()` converts `models.availableModels` into `DropdownOption[]`, including Starred and All Models groups.
- `src/views/webview/widget/dropdown.ts` owns dropdown behavior. It renders headers, dividers, selectable items, and optional star icons. It does not render a search field, track a query, or filter options.
- `src/views/webview/types.ts` defines `DropdownOption` with `id`, `name`, grouping type, and star flags. There is no explicit searchable text field.
- `media/main.css` contains dropdown/popover styling. It has no search input/no-results styling.
- `src/test/webview.test.ts` already covers model dropdown rendering and starring, but not searching/filtering.

Root cause: the model picker is a static custom dropdown, not a searchable picker. It can display model names but cannot filter by model name or model id.

## Architecture Decisions

- Add search as an optional capability in `Dropdown`, not a separate model-only DOM implementation. This avoids duplicating dropdown behavior and keeps the model picker integration small.
- Enable search only for `modelDropdown` in `SessionToolbarComponent`. Mode and generic config dropdowns remain unchanged unless explicitly opted in later.
- Search should match both `DropdownOption.name` and `DropdownOption.id`, so users can find models by friendly name (`Claude Sonnet`) or provider id (`anthropic/claude-sonnet-4`).
- Preserve model starring. Starred/All Models grouping should still render; filtering should hide empty groups and show a no-results state when nothing matches.
- Keep the first implementation simple: case-insensitive substring matching, no fuzzy ranking dependency.

## Task List

### Phase 1: Dropdown Search Foundation

#### Task 1: Extend dropdown types and constructor options

**Description:** Add a typed optional config for dropdown behavior and optional searchable text metadata for items.

**Acceptance criteria:**

- [ ] `Dropdown` can be constructed with no config and behaves exactly as today.
- [ ] `Dropdown` can be constructed with `{ searchable: true }` or equivalent typed option.
- [ ] `DropdownOption` supports optional search metadata without forcing callers to provide it.

**Verification:**

- [ ] Typecheck succeeds: `npm run check-types`.
- [ ] Existing model/mode/config dropdown tests still pass.

**Dependencies:** None

**Files likely touched:**

- `src/views/webview/widget/dropdown.ts`
- `src/views/webview/types.ts`

**Estimated scope:** Small: 2 files

#### Task 2: Render and manage the search UI inside `Dropdown`

**Description:** When searchable mode is enabled, render a search input at the top of the popover, track the query, filter item options, and preserve headers/dividers only when they have matching visible items.

**Acceptance criteria:**

- [ ] Search input appears only for searchable dropdowns.
- [ ] Typing filters options case-insensitively by `name`, `id`, and optional search text.
- [ ] Headers/dividers do not appear as orphaned rows when all items in a group are filtered out.
- [ ] A clear no-results row appears when no item matches.
- [ ] Selecting an item still posts the same `onChange` callback and closes the popover.
- [ ] Star icon clicks still call `onStarToggle` without selecting the item.

**Verification:**

- [ ] Add/adjust JSDOM tests for filtering and no-results state.
- [ ] Run targeted test suite if supported: `npm test -- --grep "model selection"`.
- [ ] Typecheck succeeds: `npm run check-types`.

**Dependencies:** Task 1

**Files likely touched:**

- `src/views/webview/widget/dropdown.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Medium: 2 files

### Checkpoint: Dropdown Foundation

- [ ] Mode dropdown still renders and selects normally.
- [ ] Generic config dropdown still renders and selects normally.
- [ ] Model dropdown still renders current selected model and starred groups.
- [ ] No test regressions in existing webview dropdown tests.

### Phase 2: Model Picker Integration

#### Task 3: Enable search for the model dropdown

**Description:** Configure only `modelDropdown` as searchable and pass enough model metadata for robust matching.

**Acceptance criteria:**

- [ ] Opening the model picker shows a search field.
- [ ] Searching by model display name filters correctly.
- [ ] Searching by model id/provider path filters correctly.
- [ ] Mode dropdown and generic config dropdowns do not show a search field.
- [ ] Starred model grouping remains correct before and after a search query.

**Verification:**

- [ ] Add tests under `src/test/webview.test.ts` for model-name search and id search.
- [ ] Manual check in extension webview with an agent that returns multiple models.

**Dependencies:** Task 2

**Files likely touched:**

- `src/views/webview/component/session-toolbar.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Small: 2 files

#### Task 4: Add production styling for searchable popovers

**Description:** Style the search input and no-results row using existing VS Code theme tokens and the current dropdown visual language.

**Acceptance criteria:**

- [ ] Search input fits within the existing popover width and dark/light VS Code themes.
- [ ] Input uses VS Code theme variables for background, foreground, border, and placeholder.
- [ ] Popover remains scrollable for large model lists.
- [ ] No layout regression in the input panel options bar.

**Verification:**

- [ ] Manual UI check at narrow and normal sidebar widths.
- [ ] Visual check with long model names.

**Dependencies:** Task 2

**Files likely touched:**

- `media/main.css`

**Estimated scope:** Small: 1 file

### Checkpoint: Searchable Model Picker

- [ ] User can open model picker, type part of a model name, and select the filtered result.
- [ ] User can type part of a model id/provider id and select the filtered result.
- [ ] Star/unstar still works while the dropdown contains search UI.
- [ ] Existing non-search dropdowns are unchanged.

### Phase 3: Verification and Packaging

#### Task 5: Add regression coverage and run quality gates

**Description:** Finalize tests around model picker search and run the project checks required for webview changes.

**Acceptance criteria:**

- [ ] Tests cover display-name search, model-id search, no-results state, and non-search dropdown behavior.
- [ ] TypeScript check passes.
- [ ] Relevant tests pass.
- [ ] Production package build passes.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm run compile-tests`
- [ ] `npm test -- --grep "model selection"` if supported, otherwise `npm test`
- [ ] `npm run package`

**Dependencies:** Tasks 1-4

**Files likely touched:**

- `src/test/webview.test.ts`

**Estimated scope:** Small: 1 file

#### Task 6: Package and install updated extension locally

**Description:** Follow repository rule for extension/webview code changes: create a VSIX and install it into VS Code before reporting completion.

**Acceptance criteria:**

- [ ] VSIX package is created in a temporary or git-ignored path.
- [ ] VSIX is installed with `--force`.
- [ ] Temporary VSIX is removed when safe.
- [ ] User is told to run `Developer: Reload Window`.

**Verification:**

- [ ] `npx vsce package --out .tmp/vscode-acp-chat-searchable-model-picker.vsix`
- [ ] `code --install-extension .tmp/vscode-acp-chat-searchable-model-picker.vsix --force`
- [ ] Remove temporary VSIX after successful install if `.tmp/` is not needed.

**Dependencies:** Task 5

**Files likely touched:** None, unless `.gitignore` needs a temporary output path entry.

**Estimated scope:** Small: commands only

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Search changes break non-model dropdowns | Medium | Keep search opt-in and add regression tests confirming mode/config dropdowns do not render search input. |
| Group filtering leaves orphaned headers/dividers | Medium | Filter render output as grouped sections, not individual DOM rows only. Add tests for starred groups with active search. |
| Star toggle uses stale `isStarred` after re-render | Low | Re-render options from latest metadata and preserve existing callback payload contract. |
| Search input steals click/keyboard events unexpectedly | Low | Stop propagation only where needed and keep existing item click behavior unchanged. |
| Popover becomes too tall or clipped | Low | Reuse existing `max-height`, keep search sticky or fixed at top, and manually check narrow sidebar widths. |

## Open Questions

- Should search remain plain substring matching, or should a later follow-up add fuzzy ranking? Recommendation: start with substring matching to avoid new dependencies.
- Should the search query clear every time the dropdown opens? Recommendation: clear on open for predictable model selection.

## Definition of Done

- Model picker supports searching by display name and model id.
- Existing select, star/unstar, mode dropdown, and config dropdown behavior is unchanged.
- Tests and quality gates pass.
- Production bundle is built, VSIX is packaged, and the extension is installed locally per repository rules.
