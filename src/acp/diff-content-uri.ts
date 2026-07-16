import * as vscode from "vscode";

export const OLD_CONTENT_SCHEME = "acp-old-content";

export function createOldContentUri(
  filePath: string,
  params: Record<string, string> = {}
): vscode.Uri {
  const query = new URLSearchParams({ filePath, ...params }).toString();
  return vscode.Uri.from({
    scheme: OLD_CONTENT_SCHEME,
    path: "/original",
    query,
  });
}

export function oldContentUriToFsPath(uri: vscode.Uri): string {
  const filePath = new URLSearchParams(uri.query).get("filePath");
  return filePath ?? uri.fsPath;
}
