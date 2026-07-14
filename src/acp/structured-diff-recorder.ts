import * as path from "path";
import * as vscode from "vscode";
import type { DiffManager } from "./diff-manager";

export type StructuredDiffSkipReason = "invalid" | "not-applied";

export interface StructuredDiffRecordOptions {
  cwd: string;
  diffManager: DiffManager;
  readTextFile?: (path: string) => Promise<string | null>;
  onDidRecord?: (path: string, oldText: string | null, newText: string) => void;
  onDidSkip?: (path: string, reason: StructuredDiffSkipReason) => void;
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

function getDiffPathForSkip(item: unknown): string | undefined {
  if (!isRecord(item) || item.type !== "diff") return undefined;
  return typeof item.path === "string" && item.path.trim().length > 0
    ? item.path
    : undefined;
}

function normalizeDiffPath(diffPath: string, cwd: string): string {
  const trimmed = diffPath.trim();
  return path.normalize(
    path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed)
  );
}

async function readWorkspaceTextFile(filePath: string): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      return null;
    }
    throw error;
  }
}

export async function recordStructuredDiffsFromContent(
  content: unknown,
  options: StructuredDiffRecordOptions
): Promise<number> {
  if (!Array.isArray(content)) return 0;

  const readTextFile = options.readTextFile ?? readWorkspaceTextFile;
  let recorded = 0;
  for (const item of content) {
    const diff = parseStructuredDiffItem(item);
    if (!diff) {
      const skipPath = getDiffPathForSkip(item);
      if (skipPath) {
        options.onDidSkip?.(
          normalizeDiffPath(skipPath, options.cwd),
          "invalid"
        );
      }
      continue;
    }

    const normalizedPath = normalizeDiffPath(diff.path, options.cwd);
    let currentText: string | null;
    try {
      currentText = await readTextFile(normalizedPath);
    } catch {
      options.onDidSkip?.(normalizedPath, "not-applied");
      continue;
    }

    if (currentText !== diff.newText) {
      options.onDidSkip?.(normalizedPath, "not-applied");
      continue;
    }

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
