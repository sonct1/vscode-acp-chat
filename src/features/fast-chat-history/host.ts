import * as vscode from "vscode";
import type {
  HistoryCatalogScope,
  HistorySessionPage,
  HistorySessionRef,
} from "../../acp/session-manager";

interface ChatHistoryProvider {
  getSupportsLoadSession(): boolean;
  getSupportsDeleteSession(): boolean;
  getHistoryScope(): HistoryCatalogScope;
  getCachedHistorySessions(): HistorySessionRef[];
  getLocalHistorySessions(): Promise<HistorySessionRef[]>;
  listSessionPage(cursor?: string | null): Promise<HistorySessionPage>;
  loadHistorySession(ref: HistorySessionRef): Promise<void>;
  deleteHistorySession(ref: HistorySessionRef): Promise<void>;
  deleteCachedHistorySession(ref: HistorySessionRef): Promise<void>;
}

interface HistoryQuickPickItem extends vscode.QuickPickItem {
  ref?: HistorySessionRef;
  loadMore?: boolean;
  warning?: boolean;
}

function keyOf(ref: HistorySessionRef): string {
  return `${ref.agentId}\u0000${ref.sessionId}`;
}

function toItem(
  session: HistorySessionRef,
  supportsDelete: boolean
): HistoryQuickPickItem {
  return {
    label: session.title,
    description: session.sessionId,
    detail: `${vscode.workspace.asRelativePath(session.cwd)} · ${new Date(
      session.updatedAt
    ).toLocaleString()}`,
    ref: session,
    buttons: supportsDelete
      ? [
          {
            iconPath: new vscode.ThemeIcon("trash"),
            tooltip: "Delete this session",
          },
        ]
      : [],
  };
}

function sameScope(
  left: HistoryCatalogScope,
  right: HistoryCatalogScope
): boolean {
  return left.agentId === right.agentId && left.cwd === right.cwd;
}

function sessionInScope(
  scope: HistoryCatalogScope,
  session: HistorySessionRef
): boolean {
  return scope.agentId === session.agentId && scope.cwd === session.cwd;
}

export async function showHistoryQuickPick(
  provider: ChatHistoryProvider,
  mode: "load" | "delete"
): Promise<void> {
  if (mode === "load" && !provider.getSupportsLoadSession()) {
    vscode.window.showInformationMessage(
      "The current agent does not support loading history sessions."
    );
    return;
  }
  if (mode === "delete" && !provider.getSupportsDeleteSession()) {
    vscode.window.showInformationMessage(
      "The current agent does not support deleting history sessions."
    );
    return;
  }

  const scope = provider.getHistoryScope();
  const supportsDelete = provider.getSupportsDeleteSession();
  const quickPick = vscode.window.createQuickPick<HistoryQuickPickItem>();
  quickPick.placeholder =
    mode === "load"
      ? "Select a conversation to load"
      : "Select a conversation to delete";
  quickPick.title =
    mode === "load"
      ? "VSCode ACP: Load History"
      : "VSCode ACP: Delete History Session";
  quickPick.busy = true;

  let disposed = false;
  let nextCursor: string | null = null;
  let loadingMore = false;
  let warningMessage: string | undefined;
  const deletedKeys = new Set<string>();
  const byKey = new Map<string, HistoryQuickPickItem>();

  const refreshItems = (
    sessions: HistorySessionRef[],
    append: boolean
  ): void => {
    const selectedKeys = new Set(
      quickPick.selectedItems.flatMap((item) =>
        item.ref ? [keyOf(item.ref)] : []
      )
    );
    if (!append) byKey.clear();
    for (const session of sessions) {
      if (!sessionInScope(scope, session)) continue;
      const key = keyOf(session);
      if (deletedKeys.has(key)) continue;
      const existing = byKey.get(key);
      if (existing?.ref?.source === "agent" && session.source !== "agent") {
        continue;
      }
      if (
        existing?.ref?.source === "remote-cache" &&
        session.source === "local-fallback"
      ) {
        continue;
      }
      byKey.set(key, toItem(session, supportsDelete));
    }
    const items = [...byKey.values()].sort(
      (a, b) =>
        new Date(b.ref?.updatedAt ?? 0).getTime() -
        new Date(a.ref?.updatedAt ?? 0).getTime()
    );
    if (nextCursor) {
      items.push({
        label: "$(more) Load more…",
        alwaysShow: true,
        loadMore: true,
      });
    }
    if (warningMessage) {
      items.push({
        label: `$(warning) ${warningMessage}`,
        alwaysShow: true,
        warning: true,
      });
    }
    quickPick.items = items;
    quickPick.selectedItems = items.filter(
      (item) => item.ref && selectedKeys.has(keyOf(item.ref))
    );
  };

  const cached = provider
    .getCachedHistorySessions()
    .filter((session) => sessionInScope(scope, session));
  if (cached.length > 0) refreshItems(cached, false);
  quickPick.show();
  void provider
    .getLocalHistorySessions()
    .then((sessions) => {
      if (
        disposed ||
        !sameScope(scope, provider.getHistoryScope()) ||
        sessions.length === 0
      ) {
        return;
      }
      refreshItems(sessions, true);
    })
    .catch((error) => {
      console.debug("[FastHistory] Failed to read local history cache:", error);
    });

  const loadPage = async (cursor?: string | null): Promise<void> => {
    if (
      loadingMore ||
      disposed ||
      !sameScope(scope, provider.getHistoryScope())
    ) {
      return;
    }
    loadingMore = true;
    quickPick.busy = true;
    try {
      const page = await provider.listSessionPage(cursor);
      if (disposed || !sameScope(scope, provider.getHistoryScope())) {
        return;
      }
      warningMessage = page.authoritative
        ? undefined
        : "Showing cached sessions; remote refresh was unavailable.";
      nextCursor = page.nextCursor;
      refreshItems(page.sessions, Boolean(cursor) || !page.authoritative);
      if (byKey.size === 0 && !nextCursor) {
        quickPick.dispose();
        vscode.window.showInformationMessage(
          mode === "load"
            ? "No history sessions available for the current agent."
            : "No history sessions available to delete."
        );
      }
    } catch (error) {
      if (!disposed) {
        const message = error instanceof Error ? error.message : String(error);
        warningMessage = `Refresh failed: ${message}`;
        refreshItems([], true);
      }
    } finally {
      loadingMore = false;
      if (!disposed) quickPick.busy = false;
    }
  };

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected || selected.warning) return;
    try {
      if (selected.loadMore) {
        await loadPage(nextCursor);
        return;
      }
      if (!selected.ref) return;
      if (mode === "load") {
        await provider.loadHistorySession(selected.ref);
        quickPick.dispose();
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Delete session "${selected.label}"?`,
        { modal: true },
        "Delete"
      );
      if (confirmed !== "Delete") return;
      const deletedRef = selected.ref;
      await provider.deleteHistorySession(deletedRef);
      const deletedKey = keyOf(deletedRef);
      deletedKeys.add(deletedKey);
      byKey.delete(deletedKey);
      refreshItems([], true);
      quickPick.dispose();
      let cacheCleanupFailed = false;
      try {
        await provider.deleteCachedHistorySession(deletedRef);
      } catch (error) {
        cacheCleanupFailed = true;
        console.warn(
          "[FastHistory] Failed to remove cached history metadata:",
          error
        );
      }
      vscode.window.showInformationMessage(
        cacheCleanupFailed
          ? `Session "${selected.label}" deleted; cached metadata will be reconciled on the next refresh.`
          : `Session "${selected.label}" deleted.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `${mode === "load" ? "Failed to load" : "Failed to delete"} session: ${message}`
      );
    }
  });

  quickPick.onDidTriggerItemButton(async (event) => {
    const item = event.item;
    if (!item.ref) return;
    try {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete session "${item.label}"?`,
        { modal: true },
        "Delete"
      );
      if (confirmed !== "Delete" || disposed) return;
      const deletedRef = item.ref;
      await provider.deleteHistorySession(deletedRef);
      const deletedKey = keyOf(deletedRef);
      deletedKeys.add(deletedKey);
      byKey.delete(deletedKey);
      refreshItems([], true);
      let cacheCleanupFailed = false;
      try {
        await provider.deleteCachedHistorySession(deletedRef);
      } catch (error) {
        cacheCleanupFailed = true;
        console.warn(
          "[FastHistory] Failed to remove cached history metadata:",
          error
        );
      }
      if (cacheCleanupFailed) {
        vscode.window.showWarningMessage(
          `Session "${item.label}" was deleted, but cached metadata could not be updated.`
        );
      }
      if (byKey.size === 0 && !nextCursor) {
        quickPick.dispose();
        vscode.window.showInformationMessage(
          "No more history sessions available."
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to delete session: ${message}`);
    }
  });

  quickPick.onDidHide(() => {
    disposed = true;
    quickPick.dispose();
  });

  void loadPage(null);
}
