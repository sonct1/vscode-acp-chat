import * as vscode from "vscode";

/**
 * Returns the absolute path of the first workspace folder,
 * falling back to the current process working directory.
 */
export function getWorkspaceRoot(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder?.uri.fsPath || process.cwd();
}
