import * as vscode from "vscode";
import { showHistoryQuickPick } from "./features/fast-chat-history/host";
import { ACPClient } from "./acp/client";
import { ChatViewProvider } from "./views/chat";
import { getAgentsWithStatus } from "./acp/agents";
import { registerExtensionHostFeatures } from "./features/register-host";
import { MultiSessionManagerViewProvider } from "./features/multi-session/manager-view";

/** VSCode ACP extension client instance. */
let acpClient: ACPClient | undefined;
/** Chat view provider instance. */
let chatProvider: ChatViewProvider | undefined;
/** Status bar item showing connection state. */
let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Activates the VSCode ACP extension.
 * Sets up the chat view, status bar, commands, and configuration watchers.
 */
export function activate(context: vscode.ExtensionContext) {
  // Open Developer Tools for webview debugging
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp-chat.openDevTools", () => {
      vscode.commands.executeCommand(
        "workbench.action.webview.openDeveloperTools"
      );
    })
  );

  // Initialize ACP client and chat view provider
  acpClient = new ACPClient();
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    acpClient,
    context.globalState
  );
  context.subscriptions.push(chatProvider);

  // Create and show status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "vscode-acp-chat.startChat";
  statusBarItem.tooltip = "VSCode ACP - Click to open chat";
  updateStatusBar("disconnected");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Update status bar on connection state changes in legacy mode.
  acpClient.setOnStateChange((state) => {
    if (!chatProvider?.isMultiSessionEnabled()) {
      updateStatusBar(state);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp-chat.updateMultiSessionStatus",
      (summary?: string) => {
        if (!chatProvider?.isMultiSessionEnabled() || !statusBarItem) return;
        statusBarItem.text = "$(comment-discussion) ACP";
        statusBarItem.tooltip = summary || "ACP multi-session chat";
        statusBarItem.backgroundColor = summary?.includes("waiting")
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
      }
    )
  );

  // Watch for configuration changes to reload MCP servers or refresh agents.
  // Each isolated runtime reads MCP configuration when it connects; the
  // singleton reload below is only needed by legacy mode.
  const mcpConfigWatcher = vscode.workspace.onDidChangeConfiguration(
    async (e) => {
      if (
        e.affectsConfiguration("mcp") &&
        !chatProvider?.isMultiSessionEnabled()
      ) {
        try {
          await acpClient?.reloadMcpServers();
        } catch (error) {
          console.error("[Extension] Failed to reload MCP servers:", error);
        }
      }

      if (
        e.affectsConfiguration("vscode-acp-chat.passMcpServers") &&
        !chatProvider?.isMultiSessionEnabled()
      ) {
        await acpClient?.reloadMcpServers();
      }

      if (
        e.affectsConfiguration("vscode-acp-chat.customAgents") ||
        e.affectsConfiguration("vscode-acp-chat.pi.historyLoadMode") ||
        e.affectsConfiguration("vscode-acp-chat.antigravity.enabled")
      ) {
        getAgentsWithStatus(true); // Force refresh agents cache and re-validate
      }
    }
  );
  context.subscriptions.push(mcpConfigWatcher);

  // Register webview view providers for the chat and session manager surfaces
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );
  const managerViewProvider = chatProvider.getMultiSessionManagerViewProvider();
  void vscode.commands
    .executeCommand(
      "setContext",
      "vscode-acp-chat.multiSessionUnavailable",
      !managerViewProvider
    )
    .then(undefined, (error) => {
      console.debug(
        "[Extension] Failed to update multi-session availability context:",
        error
      );
    });
  if (managerViewProvider) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        MultiSessionManagerViewProvider.viewType,
        managerViewProvider
      )
    );
  }

  registerExtensionHostFeatures({
    context,
    getChatTarget: () => chatProvider,
  });

  // Open chat view and connect to ACP server
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp-chat.startChat", async () => {
      await vscode.commands.executeCommand("vscode-acp-chat.chatView.focus");

      try {
        await chatProvider?.startChat();
        vscode.window.showInformationMessage("VSCode ACP connected");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
      }
    })
  );

  // Create a new chat session
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp-chat.newChat", () => {
      chatProvider?.newChat();
    })
  );

  // Clear current chat messages
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp-chat.clearChat", () => {
      chatProvider?.clearChat();
    })
  );

  // Load a previous chat session from history
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp-chat.loadHistory", async () => {
      if (!chatProvider) return;

      try {
        await showHistoryQuickPick(chatProvider, "load");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to load history: ${message}`);
      }
    })
  );

  // Delete a chat session from history
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp-chat.deleteHistorySession",
      async () => {
        if (!chatProvider) return;

        try {
          await showHistoryQuickPick(chatProvider, "delete");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `Failed to delete session: ${message}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp-chat.manageSessions",
      async () => {
        await chatProvider?.manageSessions();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp-chat.switchSession",
      async () => {
        await chatProvider?.switchSession();
      }
    )
  );

  context.subscriptions.push({
    dispose: () => {
      acpClient?.dispose();
    },
  });
}

/**
 * Updates the status bar item to reflect the current connection state.
 * @param state - The connection state: disconnected, connecting, connected, or error.
 */
function updateStatusBar(
  state: "disconnected" | "connecting" | "connected" | "error"
): void {
  if (!statusBarItem) return;

  const icons: Record<string, string> = {
    disconnected: "$(debug-disconnect)",
    connecting: "$(sync~spin)",
    connected: "$(check)",
    error: "$(error)",
  };

  const labels: Record<string, string> = {
    disconnected: "ACP: Disconnected",
    connecting: "ACP: Connecting...",
    connected: "ACP: Connected",
    error: "ACP: Error",
  };

  statusBarItem.text = `${icons[state] || icons.disconnected} ACP`;
  statusBarItem.tooltip = labels[state] || labels.disconnected;

  if (state === "error") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (state === "connecting") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }
}

/**
 * Cleans up resources when the extension is deactivated.
 */
export function deactivate() {
  acpClient?.dispose();
}
