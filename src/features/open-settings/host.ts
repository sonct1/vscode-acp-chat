import * as vscode from "vscode";

export const OPEN_SETTINGS_COMMAND = "vscode-acp-chat.openSettings";
export const ACP_CHAT_EXTENSION_SETTINGS_FILTER = "@ext:fiyqkrc.vscode-acp-chat";

export function registerOpenSettingsHostFeature(options: {
  context: vscode.ExtensionContext;
}): vscode.Disposable {
  const disposable = vscode.commands.registerCommand(
    OPEN_SETTINGS_COMMAND,
    () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        ACP_CHAT_EXTENSION_SETTINGS_FILTER
      )
  );

  options.context.subscriptions.push(disposable);
  return disposable;
}
