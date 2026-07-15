import * as vscode from "vscode";
import { MultiSessionHostController } from "./host";
import type { MultiSessionHostMessage } from "./contracts";

export class MultiSessionManagerViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewType = "vscode-acp-chat.sessionManagerView";

  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private managerStateSubscription: vscode.Disposable | undefined;
  private toggleQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: MultiSessionHostController
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeViewListeners();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);

    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: MultiSessionHostMessage) => {
        if (
          message.type === "feature.multi-session.managerReady" ||
          message.type === "feature.multi-session.managerResync"
        ) {
          this.postState();
          return;
        }
        this.sessions.handleMessage(message).then(undefined, (error) => {
          console.error(
            "[MultiSessionManager] Message handling failed:",
            error
          );
        });
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.subscribeToManagerState(view);
          this.postState();
        } else {
          this.unsubscribeFromManagerState();
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.disposeView();
      })
    );

    if (view.visible) {
      this.subscribeToManagerState(view);
      this.postState();
    }
  }

  reveal(): Thenable<void> {
    return vscode.commands.executeCommand(
      `${MultiSessionManagerViewProvider.viewType}.focus`
    );
  }

  toggle(): Thenable<void> {
    const toggle = this.toggleQueue.then(
      () => this.performToggle(),
      () => this.performToggle()
    );
    this.toggleQueue = toggle.catch(() => {});
    return toggle;
  }

  dispose(): void {
    this.disposeView();
  }

  private async performToggle(): Promise<void> {
    const command = this.view?.visible
      ? "workbench.action.toggleSidebarVisibility"
      : `${MultiSessionManagerViewProvider.viewType}.focus`;
    await vscode.commands.executeCommand(command);
  }

  private subscribeToManagerState(view: vscode.WebviewView): void {
    if (this.managerStateSubscription || !view.visible) return;
    this.managerStateSubscription = this.sessions.onDidChangeManagerState(
      (state) => {
        if (this.view !== view || !view.visible) return;
        void view.webview.postMessage(state);
      }
    );
  }

  private unsubscribeFromManagerState(): void {
    this.managerStateSubscription?.dispose();
    this.managerStateSubscription = undefined;
  }

  private postState(): void {
    const view = this.view;
    if (!view?.visible) return;
    void view.webview.postMessage(this.sessions.getManagerStateSnapshot());
  }

  private disposeView(): void {
    this.disposeViewListeners();
    this.view = undefined;
  }

  private disposeViewListeners(): void {
    this.unsubscribeFromManagerState();
    while (this.viewDisposables.length) this.viewDisposables.pop()?.dispose();
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
