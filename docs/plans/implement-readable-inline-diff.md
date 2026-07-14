# Readable Inline Diff Implementation Plan

## Purpose

Improve the readability, usability, and performance characteristics of inline edit/write diffs shown inside the ACP Chat webview.

The current inline diff is useful but hard to review for non-trivial edits because it lacks line numbers, hunk headers, word-level emphasis, large-diff handling, and a clear path to open the full VS Code diff editor.

This plan keeps the inline view lightweight and makes the VS Code native diff editor the review target for detailed inspection.

## Current State

### Inline diff rendering

Inline tool diffs are rendered by a custom webview renderer:

- Diff algorithm: `src/utils/diff.ts`
  - `computeLineDiff(oldText, newText)`
  - line-by-line LCS implementation
  - returns `add`, `remove`, and `context` lines
  - already tracks `oldLineNumber` and `newLineNumber`
- HTML renderer: `src/views/webview/widget/diff-render.ts`
  - `renderDiff(path, oldText, newText)`
  - shows three context lines around changes
  - groups adjacent changed lines
  - uses `...` separators for skipped content
- Tool output integration: `src/views/webview/tool-render.ts`
  - renders `ToolCallContentItem` entries with `type: "diff"`
- Host enrichment:
  - single-session path: `src/views/chat.ts`
  - multi-session/session pipeline path: `src/acp/session-output-pipeline.ts`
- Styling: `media/main.css`

Current inline output roughly looks like:

```diff
filename.ts
 context line
-old whole line
+new whole line
 context line
...
```

### Full diff review

Full diff review already uses VS Code native diff editor:

- `vscode.diff`
- old content exposed through the `acp-old-content:` `TextDocumentContentProvider`
- single-session implementation in `src/views/chat.ts`
- multi-session implementation in `src/features/multi-session/host.ts`

This path is more readable and should remain the detailed review experience.

## Problems

1. Font is too small for code review in the sidebar.
2. Add/remove colors use terminal green/red variables instead of VS Code diff editor theme variables.
3. Context lines are muted with `opacity: 0.8`, reducing readability.
4. Inline diff does not render old/new line numbers even though the data exists.
5. Inline diff computes hunk metadata but does not render hunk headers such as `@@ -42,7 +42,9 @@`.
6. The diff header shows only the filename, so files with identical names are ambiguous.
7. Header click opens the file, not the full diff; there is no obvious inline `Open Diff` action.
8. Replacement changes are rendered as whole-line removals/additions only; small word changes are hard to spot.
9. Large files can trigger expensive LCS work because the algorithm allocates an O(n*m) DP matrix.
10. Diff enrichment logic is duplicated between `src/views/chat.ts` and `src/acp/session-output-pipeline.ts`.

## Target UX

Inline diff should be compact but reviewable:

```text
src/views/example.ts                         +8 -3   [Open Diff]
@@ -24,8 +24,10 @@
 24  24 │ export function render() {
 25  25 │   const value = getValue();
 26     │ - return oldRender(value);
     26 │ + return newRender(value, options);
 27  27 │ }
```

Principles:

- Inline diff is for quick review.
- VS Code native diff is for detailed review.
- Large diffs should not degrade chat performance.
- The renderer should remain theme-aware and accessible.

## Implementation Phases

### Phase 1 — CSS readability baseline

Scope:

- Update `media/main.css` for existing inline diff classes.
- Do not change the diff algorithm or HTML structure yet.

Changes:

- Use editor font size and line height:
  - `var(--vscode-editor-font-size, 12px)`
  - `var(--vscode-editor-line-height, 18px)`
- Use VS Code diff theme variables:
  - `--vscode-diffEditor-insertedLineBackground`
  - `--vscode-diffEditor-removedLineBackground`
  - `--vscode-diffEditor-insertedTextBackground`
  - `--vscode-diffEditor-removedTextBackground`
- Keep code text color as `--vscode-editor-foreground`.
- Remove reduced opacity from context lines.
- Keep muted color for gutter/prefix metadata only.

Expected result:

- Existing inline diff becomes easier to read without behavior changes.

Verification:

- Existing webview tests pass.
- Manual visual check with dark and light VS Code themes if possible.

### Phase 2 — Line numbers and hunk headers

Scope:

- Update `src/views/webview/widget/diff-render.ts`.
- Add tests in `src/test/webview.test.ts` for line number and hunk header output.
- Update `media/main.css` for gutter layout.

Changes:

- Render two line-number columns:
  - old line number
  - new line number
- Render prefix column:
  - `+`, `-`, or blank
- Render code column.
- Use CSS grid for `.diff-line`.
- Render hunk headers from existing `DiffHunk` metadata:

```diff
@@ -oldStart,oldLines +newStart,newLines @@
```

- Preserve current context-window behavior.
- Preserve `...` separator only when hunks are non-adjacent.

Expected result:

- Inline diffs become location-aware and closer to GitHub/VS Code readability.

Verification:

- Unit tests for:
  - additions show only new line number
  - removals show only old line number
  - context shows both line numbers
  - hunk header is rendered
  - existing escaping behavior remains safe

### Phase 3 — Inline `Open Diff` action

Scope:

- Add an explicit `Open Diff` button to inline diff headers.
- Wire webview click handling to send `reviewDiff` instead of only `openFile`.

Changes:

- Extend `renderDiff()` header with an action button when `path` is available.
- Update `src/views/webview/component/message-list.ts` event handling:
  - clicking file/path area can continue opening the file, or the entire header can open full diff
  - clicking the explicit action sends `{ type: "reviewDiff", path }`
- Reuse existing host handlers:
  - single-session `reviewDiff`
  - multi-session `reviewDiff`

Expected result:

- User can jump from inline diff to native VS Code diff editor directly.

Verification:

- Webview test confirms clicking the action posts `reviewDiff` with path.
- Existing file open behavior remains covered or is intentionally updated.

### Phase 4 — Header metadata and path clarity

Scope:

- Improve inline diff header content.

Changes:

- Prefer relative path over basename where available.
- If only absolute path is available in the webview, render a stable readable suffix rather than only the basename.
- Show stats in header:
  - `+N`
  - `-M`
- Extract a shared helper for diff stats to avoid repeated `filter()` calls.

Expected result:

- Users can distinguish files with the same name.
- Users can estimate diff size before reading.

Verification:

- Tests for header path and stats rendering.

### Phase 5 — Large diff guard

Scope:

- Prevent expensive inline diff rendering for large changes.

Changes:

- Add configurable internal thresholds, for example:
  - `MAX_INLINE_DIFF_CELLS = 500_000`
  - `MAX_INLINE_RENDER_LINES = 400`
- Before computing full inline LCS, estimate `oldLineCount * newLineCount`.
- If over threshold:
  - render a compact large-diff card
  - include path, approximate line counts, and `Open Diff`
  - do not run full inline LCS
- Keep the native `vscode.diff` path available.

Expected result:

- Large file rewrites do not freeze or heavily slow the chat webview.

Verification:

- Tests for large input producing a large-diff card.
- Tests confirming normal small diffs still render detailed output.

### Phase 6 — Word-level highlight

Scope:

- Add intra-line highlighting for paired remove/add lines.

Options:

1. Add a small dependency such as `diff` / `jsdiff` and use word-level diffing.
2. Implement a bounded local word-LCS for paired lines.

Recommended approach:

- Start with a small bounded implementation or a dependency if bundle impact is acceptable.
- Only run word-level diff when:
  - a remove line can be paired with an add line
  - both lines are under a length threshold, for example 500 characters
  - the change block is small enough

Changes:

- Render changed words with:
  - `.diff-word-remove`
  - `.diff-word-add`
- Use VS Code inserted/removed text background variables.

Expected result:

- Small edits such as number, identifier, or string changes are easy to spot.

Verification:

- Tests for word-highlight HTML escaping.
- Tests for fallback behavior when lines are too long or cannot be paired.

### Phase 7 — Diff enrichment cleanup

Scope:

- Reduce duplicate host-side logic.

Changes:

- Extract shared file mutation diff enrichment into a common module, for example:

```text
src/acp/tool-diff-enricher.ts
```

Responsibilities:

- detect file mutation tool
- extract path
- extract full new content from write/edit payloads
- reconstruct edit output from `old_string` and `new_string`
- safely skip misleading diffs when full new content cannot be reconstructed

Consumers:

- `src/views/chat.ts`
- `src/acp/session-output-pipeline.ts`

Expected result:

- Single-session and multi-session behavior stay consistent.
- Future diff fixes are made in one place.

Verification:

- Existing chat/session-output tests pass.
- Add focused tests for edit reconstruction helper.

## Files Expected to Change

Likely files:

- `media/main.css`
- `src/utils/diff.ts`
- `src/views/webview/widget/diff-render.ts`
- `src/views/webview/component/message-list.ts`
- `src/views/webview/types.ts`
- `src/views/webview/tool-render.ts`
- `src/test/webview.test.ts`

Possible later refactor files:

- `src/acp/tool-diff-enricher.ts`
- `src/views/chat.ts`
- `src/acp/session-output-pipeline.ts`

## Risks and Mitigations

### Risk: Webview rendering regressions

Mitigation:

- Keep changes incremental.
- Add tests for exact HTML fragments and click messages.

### Risk: Theme contrast issues

Mitigation:

- Prefer VS Code theme variables.
- Provide fallback colors only when variables are unavailable.

### Risk: Large diff performance

Mitigation:

- Add pre-LCS size guard before allocating the DP matrix.
- Prefer native VS Code diff for large changes.

### Risk: Word-level diff complexity

Mitigation:

- Defer to a later phase.
- Keep thresholds conservative.
- Avoid word-level diff for long lines and large blocks.

### Risk: Multi-session behavior drift

Mitigation:

- Reuse existing `reviewDiff` host paths.
- Later extract duplicate diff enrichment logic.

## Verification Plan

For implementation phases that touch extension/webview code, follow project rules:

1. `npm run check-types`
2. relevant webview/unit tests, or `npm test` when practical
3. `npm run package`
4. `npx vsce package --out <temporary-or-versioned-path>.vsix`
5. `code --install-extension <path>.vsix --force`

After installation, reload VS Code with `Developer: Reload Window` to activate the new extension bundle.

## Recommended Initial Slice

Start with phases 1–3:

1. CSS readability baseline.
2. Line numbers and hunk headers.
3. Inline `Open Diff` button.

This delivers the highest readability improvement without changing the core diff algorithm or adding dependencies.

Large-diff guard and word-level highlight can follow after the UI structure is stable.
