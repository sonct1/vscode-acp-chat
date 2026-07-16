import type {
  MultiSessionListItem,
  MultiSessionManagerStateMessage,
} from "./contracts";
import { compareSessionsByCreatedAt } from "./session-order";

export interface MultiSessionQuickSwitchItem {
  label: string;
  detail: string;
  session: MultiSessionListItem;
}

export function buildMultiSessionQuickSwitchItems(
  state: Pick<
    MultiSessionManagerStateMessage,
    "sessions" | "activeLocalSessionId"
  >
): MultiSessionQuickSwitchItem[] {
  return [...state.sessions]
    .sort(compareSessionsByCreatedAt)
    .map((session) => ({
      label: `${statusGlyph(session)} ${session.title}`,
      detail: [
        session.localSessionId === state.activeLocalSessionId ? "Active" : "",
        session.pendingElicitationCount > 0
          ? "Needs input"
          : session.pendingPermissionCount > 0
            ? "Needs permission"
            : formatStatus(session.status),
        session.agentName,
        session.acpSessionId,
      ]
        .filter(Boolean)
        .join(" · "),
      session,
    }));
}

function statusGlyph(session: MultiSessionListItem): string {
  if (session.pendingElicitationCount > 0) return "?";
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
