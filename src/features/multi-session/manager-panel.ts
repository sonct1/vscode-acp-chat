import * as vscode from "vscode";
import { MultiSessionHostController } from "./host";
import type { MultiSessionHostMessage } from "./contracts";

export class MultiSessionManagerPanelController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: MultiSessionHostController
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "vscode-acp-chat.sessions",
      "ACP Sessions",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );
    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);

    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: MultiSessionHostMessage) =>
        this.sessions.handleMessage(message).then(undefined, (error) => {
          console.error("[MultiSessionManager] Message handling failed:", error);
        })
      ),
      this.sessions.onDidChangeManagerState((state) => {
        void panel.webview.postMessage(state);
      }),
      panel.onDidDispose(() => this.disposePanel())
    );
  }

  reveal(): void {
    this.open();
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposePanel();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private postState(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage(this.sessions.getManagerStateSnapshot());
  }

  private disposePanel(): void {
    while (this.panelDisposables.length) this.panelDisposables.pop()?.dispose();
    this.panel = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "dist",
        "session-manager-webview.js"
      )
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicon.css")
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <link href="${codiconsUri}" rel="stylesheet">
  <title>ACP Sessions</title>
</head>
<body>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
