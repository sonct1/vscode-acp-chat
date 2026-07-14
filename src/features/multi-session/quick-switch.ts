import * as vscode from "vscode";
import { MultiSessionHostController } from "./host";
import type { MultiSessionListItem } from "./contracts";

export async function showMultiSessionQuickSwitch(
  sessions: MultiSessionHostController
): Promise<void> {
  const state = sessions.getManagerStateSnapshot();
  if (state.sessions.length === 0) {
    vscode.window.showInformationMessage("No open ACP sessions.");
    return;
  }

  const items = [...state.sessions].sort(compareSessions).map((session) => ({
    label: `${statusGlyph(session)} ${session.title}`,
    description: [
      session.localSessionId === state.activeLocalSessionId ? "Active" : "",
      session.pendingPermissionCount > 0 ? "Needs permission" : formatStatus(session.status),
      session.unreadCount > 0 ? `${session.unreadCount} unread` : "",
      session.agentName,
    ]
      .filter(Boolean)
      .join(" · "),
    detail: session.acpSessionId,
    session,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: "Switch ACP Session",
    placeHolder: "Select a session to open in the chat view",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!selected) return;
  sessions.activateSession(selected.session.localSessionId, { focusChat: true });
}

function compareSessions(
  a: MultiSessionListItem,
  b: MultiSessionListItem
): number {
  const rank = (session: MultiSessionListItem) =>
    session.pendingPermissionCount > 0
      ? 0
      : isRunningStatus(session.status)
        ? 1
        : session.status === "draft"
          ? 2
          : 3;
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
}

function statusGlyph(session: MultiSessionListItem): string {
  if (session.pendingPermissionCount > 0) return "!";
  if (isRunningStatus(session.status)) return "●";
  if (session.status === "draft") return "◌";
  return "○";
}

function isRunningStatus(status: string): boolean {
  return (
    status === "running" ||
    status === "starting" ||
    status === "loading_history" ||
    status === "cancelling"
  );
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
