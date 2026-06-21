export interface DiffLine {
  type: "add" | "remove" | "context";
  line: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

function findLCS(oldLines: string[], newLines: string[]): string[] {
  const n = oldLines.length;
  const m = newLines.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs: string[] = [];
  let i = n,
    j = m;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.push(oldLines[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  lcs.reverse();
  return lcs;
}

/**
 * Compute a line-by-line diff between old and new text.
 * Returns an array of diff lines marked as add/remove/context.
 * Uses LCS (Longest Common Subsequence) for optimal diff computation.
 * Groups consecutive removals before additions for block replacement style.
 */
export function computeLineDiff(
  oldText: string | null | undefined,
  newText: string | null | undefined
): DiffLine[] {
  if (!oldText && !newText) {
    return [];
  }
  if (!oldText) {
    return newText!.split("\n").map((line, idx) => ({
      type: "add" as const,
      line,
      newLineNumber: idx + 1,
    }));
  }
  if (!newText) {
    return oldText!.split("\n").map((line, idx) => ({
      type: "remove" as const,
      line,
      oldLineNumber: idx + 1,
    }));
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const lcs = findLCS(oldLines, newLines);

  const result: DiffLine[] = [];
  let i = 0,
    j = 0,
    k = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  while (i < oldLines.length || j < newLines.length) {
    while (i < oldLines.length && (k >= lcs.length || oldLines[i] !== lcs[k])) {
      result.push({
        type: "remove",
        line: oldLines[i],
        oldLineNumber: oldLineNum++,
      });
      i++;
    }

    while (j < newLines.length && (k >= lcs.length || newLines[j] !== lcs[k])) {
      result.push({
        type: "add",
        line: newLines[j],
        newLineNumber: newLineNum++,
      });
      j++;
    }

    if (k < lcs.length && i < oldLines.length && j < newLines.length) {
      result.push({
        type: "context",
        line: oldLines[i],
        oldLineNumber: oldLineNum++,
        newLineNumber: newLineNum++,
      });
      i++;
      j++;
      k++;
    }
  }

  return result;
}
