import * as path from "path";
import type { DiffManager } from "./diff-manager";

export interface StructuredDiffRecordOptions {
  cwd: string;
  diffManager: DiffManager;
  onDidRecord?: (path: string, oldText: string | null, newText: string) => void;
}

interface StructuredDiffItem {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStructuredDiffItem(item: unknown): StructuredDiffItem | undefined {
  if (!isRecord(item) || item.type !== "diff") return undefined;
  if (typeof item.path !== "string" || item.path.trim().length === 0) {
    return undefined;
  }
  if (typeof item.newText !== "string") return undefined;
  if (typeof item.oldText !== "string" && item.oldText !== null) {
    return undefined;
  }

  return {
    type: "diff",
    path: item.path,
    oldText: item.oldText,
    newText: item.newText,
  };
}

function normalizeDiffPath(diffPath: string, cwd: string): string {
  const trimmed = diffPath.trim();
  return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed));
}

export function recordStructuredDiffsFromContent(
  content: unknown,
  options: StructuredDiffRecordOptions
): number {
  if (!Array.isArray(content)) return 0;

  let recorded = 0;
  for (const item of content) {
    const diff = parseStructuredDiffItem(item);
    if (!diff) continue;

    const normalizedPath = normalizeDiffPath(diff.path, options.cwd);
    const didRecord = options.diffManager.recordChange(
      normalizedPath,
      diff.oldText,
      diff.newText
    );
    if (!didRecord) continue;

    recorded += 1;
    options.onDidRecord?.(normalizedPath, diff.oldText, diff.newText);
  }

  return recorded;
}
