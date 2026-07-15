/**
 * Renders a unified diff view as an HTML string.
 *
 * Used both by the main webview controller (inline tool diffs) and by the
 * tool-render module for the detail view.  Extracted into its own widget
 * so that neither `main.ts` nor `tool-render.ts` needs to contain the
 * diffing / hunk-grouping logic.
 */

import { computeLineDiff } from "../../../utils/diff";
import { escapeHtml } from "../html-utils";
import { getFileIconHtml } from "../file-icon";

/**
 * A contiguous group of diff lines that belong to the same hunk.
 * The renderer groups sorted diff lines into hunks, then renders each hunk
 * with optional separators between non-adjacent hunks.
 */
interface DiffHunk {
  /** First index into the sorted `showLineIndexes` array. */
  startIdx: number;
  /** Last index (inclusive) into the sorted `showLineIndexes` array. */
  endIdx: number;
  /** Estimated old-file line number at the start of the hunk. */
  oldStart: number;
  /** Number of lines from the old file (context + removed). */
  oldLines: number;
  /** Estimated new-file line number at the start of the hunk. */
  newStart: number;
  /** Number of lines from the new file (context + added). */
  newLines: number;
  /** Whether this hunk contains at least one non-context line. */
  hasChanges: boolean;
}

/**
 * Render a unified diff for the given file as an HTML string.
 *
 * @param path     File path shown in the diff header (omit to hide header).
 * @param oldText  Original file content (`null` / `undefined` → treated as empty).
 * @param newText  Modified file content (`null` / `undefined` → treated as empty).
 * @returns        HTML string of the diff container.
 */
const MAX_DIFF_INPUT_CHARS = 500_000;
const MAX_DIFF_LINE_PRODUCT = 2_000_000;

export function renderDiff(
  path: string | undefined,
  oldText: string | null | undefined,
  newText: string | null | undefined
): string {
  const oldLength = oldText?.length ?? 0;
  const newLength = newText?.length ?? 0;
  const oldLineCount = oldText ? oldText.split("\n").length : 0;
  const newLineCount = newText ? newText.split("\n").length : 0;
  if (
    oldLength + newLength > MAX_DIFF_INPUT_CHARS ||
    oldLineCount * newLineCount > MAX_DIFF_LINE_PRODUCT
  ) {
    return '<div class="diff-container"><div class="diff-empty">Diff is too large to render inline.</div></div>';
  }

  const diffLines = computeLineDiff(oldText, newText);

  if (diffLines.length === 0) {
    return '<div class="diff-container"><div class="diff-empty">No changes</div></div>';
  }

  const CONTEXT_LINES = 3;
  const showLineIndexes = new Set<number>();

  // Mark lines to show: changes and their context
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== "context") {
      for (
        let k = Math.max(0, i - CONTEXT_LINES);
        k <= Math.min(diffLines.length - 1, i + CONTEXT_LINES);
        k++
      ) {
        showLineIndexes.add(k);
      }
    }
  }

  if (showLineIndexes.size === 0) {
    return '<div class="diff-container"><div class="diff-empty">No changes found</div></div>';
  }

  let html = '<div class="diff-container">';

  if (path) {
    const filename = path.split("/").pop() || path;
    html += `<div class="diff-header" acp-title="${escapeHtml(path)}" data-file-path="${escapeHtml(path)}">
    ${getFileIconHtml(filename, 14)}
    <span class="diff-path">${escapeHtml(filename)}</span>
  </div>`;
  }
  html += '<pre class="diff-content"><div class="diff-content-inner">';

  const sortedIndexes = Array.from(showLineIndexes).sort((a, b) => a - b);

  // Group consecutive change lines into hunks
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let lastOldLine = 0;
  let lastNewLine = 0;

  for (const idx of sortedIndexes) {
    const diffLine = diffLines[idx];
    const isNewHunk =
      !currentHunk ||
      idx > currentHunk.endIdx + 1 ||
      (diffLine.type !== "context" && !currentHunk.hasChanges) ||
      (diffLine.type === "context" && currentHunk.hasChanges);

    if (isNewHunk) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      // Calculate start lines: use line numbers if available, otherwise estimate from previous hunk
      const oldStart = diffLine.oldLineNumber ?? lastOldLine + 1;
      const newStart = diffLine.newLineNumber ?? lastNewLine + 1;
      currentHunk = {
        startIdx: idx,
        endIdx: idx,
        oldStart,
        oldLines:
          diffLine.type === "remove" || diffLine.type === "context" ? 1 : 0,
        newStart,
        newLines:
          diffLine.type === "add" || diffLine.type === "context" ? 1 : 0,
        hasChanges: diffLine.type !== "context",
      } satisfies DiffHunk;
      // Update last line numbers
      if (diffLine.oldLineNumber) lastOldLine = diffLine.oldLineNumber;
      if (diffLine.newLineNumber) lastNewLine = diffLine.newLineNumber;
    } else if (currentHunk) {
      currentHunk.endIdx = idx;
      if (diffLine.type === "remove" || diffLine.type === "context") {
        currentHunk.oldLines++;
      }
      if (diffLine.type === "add" || diffLine.type === "context") {
        currentHunk.newLines++;
      }
      if (diffLine.type !== "context") {
        currentHunk.hasChanges = true;
      }
      // Update last line numbers
      if (diffLine.oldLineNumber) lastOldLine = diffLine.oldLineNumber;
      if (diffLine.newLineNumber) lastNewLine = diffLine.newLineNumber;
    }
  }
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  // Render hunks
  type ChangeBlock = { type: "change"; startIdx: number; endIdx: number };
  type ContextLine = { type: "context"; idx: number };

  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx];

    // Add separator only when there are skipped diff lines between hunks
    if (hunkIdx > 0) {
      const prevEndIdx = hunks[hunkIdx - 1].endIdx;
      if (hunk.startIdx - prevEndIdx > 1) {
        html += '<div class="diff-hunk-separator">...</div>';
      }
    }

    // Group consecutive add/remove lines into change blocks
    const groups: Array<ChangeBlock | ContextLine> = [];
    let currentChange: ChangeBlock | null = null;

    for (let i = hunk.startIdx; i <= hunk.endIdx; i++) {
      if (diffLines[i].type !== "context") {
        if (currentChange) {
          currentChange.endIdx = i;
        } else {
          currentChange = { type: "change", startIdx: i, endIdx: i };
          groups.push(currentChange);
        }
      } else {
        currentChange = null;
        groups.push({ type: "context", idx: i });
      }
    }

    // Render each group
    for (const group of groups) {
      if (group.type === "context") {
        const dl = diffLines[group.idx];
        html += `<div class="diff-line diff-context">`;
        html += `<span class="diff-line-prefix"> </span>`;
        html += `<span class="diff-line-code">${escapeHtml(dl.line)}</span>`;
        html += `</div>`;
      } else {
        html += `<div class="diff-change-block">`;
        for (let i = group.startIdx; i <= group.endIdx; i++) {
          const dl = diffLines[i];
          const prefix = dl.type === "add" ? "+" : "-";
          html += `<div class="diff-line diff-${dl.type}">`;
          html += `<span class="diff-line-prefix">${prefix}</span>`;
          html += `<span class="diff-line-code">${escapeHtml(dl.line)}</span>`;
          html += `</div>`;
        }
        html += `</div>`;
      }
    }
  }

  html += "</div></pre>";
  html += "</div>";

  return html;
}
