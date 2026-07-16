import * as crypto from "crypto";
import * as vscode from "vscode";

export interface PersistedActiveSessionBinding {
  agentId: string;
  sessionId: string;
  cwd: string;
  title?: string;
}

const KEY_PREFIX = "vscode-acp-chat.multiSession.activeSession.v1";

export function activeSessionBindingKey(workspaceRoot: string): string {
  const normalizedRoot = normalizeWorkspaceKey(workspaceRoot);
  const digest = crypto
    .createHash("sha256")
    .update(normalizedRoot)
    .digest("hex")
    .slice(0, 32);
  return `${KEY_PREFIX}.${digest}`;
}

export function hasActiveSessionBindingRecord(
  globalState: vscode.Memento,
  workspaceRoot: string
): boolean {
  return globalState.get<unknown>(activeSessionBindingKey(workspaceRoot)) !== undefined;
}

export function readActiveSessionBinding(
  globalState: vscode.Memento,
  workspaceRoot: string
): PersistedActiveSessionBinding | undefined {
  const record = globalState.get<unknown>(activeSessionBindingKey(workspaceRoot));
  return isPersistedActiveSessionBinding(record) ? record : undefined;
}

export function writeActiveSessionBinding(
  globalState: vscode.Memento,
  workspaceRoot: string,
  binding: PersistedActiveSessionBinding
): Thenable<void> {
  return globalState.update(activeSessionBindingKey(workspaceRoot), {
    agentId: binding.agentId,
    sessionId: binding.sessionId,
    cwd: binding.cwd,
    ...(binding.title?.trim() ? { title: binding.title.trim() } : {}),
  });
}

export function clearActiveSessionBinding(
  globalState: vscode.Memento,
  workspaceRoot: string
): Thenable<void> {
  return globalState.update(activeSessionBindingKey(workspaceRoot), undefined);
}

function normalizeWorkspaceKey(workspaceRoot: string): string {
  const value = workspaceRoot.trim();
  if (!value) return value;

  if (value.startsWith("\\\\")) {
    const unc = value.replace(/\\/g, "/");
    return `//${unc.slice(2).replace(/\/+$/, "")}`;
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function isPersistedActiveSessionBinding(
  value: unknown
): value is PersistedActiveSessionBinding {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.agentId === "string" &&
    record.agentId.trim().length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.trim().length > 0 &&
    typeof record.cwd === "string" &&
    record.cwd.trim().length > 0 &&
    (record.title === undefined || typeof record.title === "string")
  );
}
