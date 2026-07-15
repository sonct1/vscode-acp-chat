/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as vscode from "vscode";
import { MultiSessionManagerViewProvider } from "../../features/multi-session/manager-view";
import type { MultiSessionManagerStateMessage } from "../../features/multi-session/contracts";

class DisposableStore implements vscode.Disposable {
  disposed = false;
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose?.();
  }
}

class FakeWebview {
  html = "";
  options: vscode.WebviewOptions = {};
  readonly posts: unknown[] = [];
  private messageListeners: Array<(message: unknown) => void> = [];
  cspSource = "vscode-resource:";

  asWebviewUri(uri: vscode.Uri): vscode.Uri {
    return uri;
  }

  postMessage(message: unknown): Thenable<boolean> {
    this.posts.push(message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable {
    this.messageListeners.push(listener);
    return new DisposableStore(() => {
      this.messageListeners = this.messageListeners.filter(
        (candidate) => candidate !== listener
      );
    });
  }

  fireMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }
}

class FakeWebviewView {
  readonly webview = new FakeWebview();
  visible = true;
  private visibilityListeners: Array<() => void> = [];
  private disposeListeners: Array<() => void> = [];

  onDidChangeVisibility(listener: () => void): vscode.Disposable {
    this.visibilityListeners.push(listener);
    return new DisposableStore(() => {
      this.visibilityListeners = this.visibilityListeners.filter(
        (candidate) => candidate !== listener
      );
    });
  }

  onDidDispose(listener: () => void): vscode.Disposable {
    this.disposeListeners.push(listener);
    return new DisposableStore(() => {
      this.disposeListeners = this.disposeListeners.filter(
        (candidate) => candidate !== listener
      );
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of [...this.visibilityListeners]) listener();
  }

  dispose(): void {
    for (const listener of [...this.disposeListeners]) listener();
  }
}

class FakeSessions {
  readonly handled: unknown[] = [];
  private listeners: Array<(state: MultiSessionManagerStateMessage) => void> =
    [];
  snapshotRevision = 0;
  disposed = false;

  get subscriberCount(): number {
    return this.listeners.length;
  }

  onDidChangeManagerState(
    listener: (state: MultiSessionManagerStateMessage) => void
  ): vscode.Disposable {
    this.listeners.push(listener);
    return new DisposableStore(() => {
      this.listeners = this.listeners.filter(
        (candidate) => candidate !== listener
      );
    });
  }

  async handleMessage(message: unknown): Promise<boolean> {
    this.handled.push(message);
    return true;
  }

  getManagerStateSnapshot(): MultiSessionManagerStateMessage {
    this.snapshotRevision += 1;
    return makeState(this.snapshotRevision);
  }

  fireState(revision: number): void {
    for (const listener of [...this.listeners]) listener(makeState(revision));
  }

  dispose(): void {
    this.disposed = true;
  }
}

function makeState(revision: number): MultiSessionManagerStateMessage {
  return {
    type: "feature.multi-session.managerState",
    revision,
    sessions: [],
    aggregate: { open: 0, running: 0, awaitingPermission: 0 },
    agents: [],
    selectedAgentId: "test-agent",
  };
}

suite("multi-session manager view provider", () => {
  test("resolve configures webview html and routes action messages", async () => {
    const sessions = new FakeSessions();
    const provider = new MultiSessionManagerViewProvider(
      vscode.Uri.file("/extension"),
      sessions as any
    );
    const view = new FakeWebviewView();

    provider.resolveWebviewView(view as any);

    assert.strictEqual(view.webview.options.enableScripts, true);
    assert.ok(view.webview.html.includes("session-manager-webview.js"));
    assert.ok(view.webview.html.includes("codicon.css"));
    view.webview.fireMessage({ type: "feature.multi-session.new" });
    await Promise.resolve();
    assert.deepStrictEqual(sessions.handled, [
      { type: "feature.multi-session.new" },
    ]);
    provider.dispose();
  });

  test("manager ready and resync post full state without delegating to host", () => {
    const sessions = new FakeSessions();
    const provider = new MultiSessionManagerViewProvider(
      vscode.Uri.file("/extension"),
      sessions as any
    );
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view as any);
    view.webview.posts.length = 0;

    view.webview.fireMessage({ type: "feature.multi-session.managerReady" });
    view.webview.fireMessage({ type: "feature.multi-session.managerResync" });

    assert.strictEqual(view.webview.posts.length, 2);
    assert.deepStrictEqual(
      view.webview.posts.map((message: any) => message.revision),
      [2, 3]
    );
    assert.deepStrictEqual(sessions.handled, []);
    provider.dispose();
  });

  test("state posts are gated while hidden and resync when visible again", () => {
    const sessions = new FakeSessions();
    const provider = new MultiSessionManagerViewProvider(
      vscode.Uri.file("/extension"),
      sessions as any
    );
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view as any);
    view.webview.posts.length = 0;

    assert.strictEqual(sessions.subscriberCount, 1);
    view.setVisible(false);
    assert.strictEqual(sessions.subscriberCount, 0);
    sessions.fireState(10);
    assert.strictEqual(view.webview.posts.length, 0);

    view.setVisible(true);
    assert.strictEqual(sessions.subscriberCount, 1);
    assert.strictEqual(view.webview.posts.length, 1);
    assert.strictEqual((view.webview.posts[0] as any).revision, 2);
    provider.dispose();
  });

  test("toggle focuses hidden view and hides sidebar when visible", async () => {
    const sessions = new FakeSessions();
    const provider = new MultiSessionManagerViewProvider(
      vscode.Uri.file("/extension"),
      sessions as any
    );
    const view = new FakeWebviewView();
    const commands: string[] = [];
    const commandDisposable = vscode.commands.registerCommand(
      "workbench.action.toggleSidebarVisibility",
      () => commands.push("workbench.action.toggleSidebarVisibility")
    );
    const focusDisposable = vscode.commands.registerCommand(
      `${MultiSessionManagerViewProvider.viewType}.focus`,
      () => commands.push(`${MultiSessionManagerViewProvider.viewType}.focus`)
    );

    try {
      await provider.toggle();
      provider.resolveWebviewView(view as any);
      await provider.toggle();

      assert.deepStrictEqual(commands, [
        `${MultiSessionManagerViewProvider.viewType}.focus`,
        "workbench.action.toggleSidebarVisibility",
      ]);
    } finally {
      commandDisposable.dispose();
      focusDisposable.dispose();
      provider.dispose();
    }
  });

  test("serializes rapid toggles without dropping the second request", async () => {
    const sessions = new FakeSessions();
    const provider = new MultiSessionManagerViewProvider(
      vscode.Uri.file("/extension"),
      sessions as any
    );
    const view = new FakeWebviewView();
    const commands: string[] = [];
    let resolveFocus: (() => void) | undefined;
    const commandDisposable = vscode.commands.registerCommand(
      "workbench.action.toggleSidebarVisibility",
      () => commands.push("workbench.action.toggleSidebarVisibility")
    );
    const focusDisposable = vscode.commands.registerCommand(
      `${MultiSessionManagerViewProvider.viewType}.focus`,
      () =>
        new Promise<void>((resolve) => {
          commands.push(`${MultiSessionManagerViewProvider.viewType}.focus`);
          resolveFocus = () => {
            provider.resolveWebviewView(view as any);
            resolve();
          };
        })
    );

    try {
      const firstToggle = provider.toggle();
      const secondToggle = provider.toggle();
      await Promise.resolve();
      assert.deepStrictEqual(commands, [
        `${MultiSessionManagerViewProvider.viewType}.focus`,
      ]);

      resolveFocus?.();
      await Promise.all([firstToggle, secondToggle]);
      assert.deepStrictEqual(commands, [
        `${MultiSessionManagerViewProvider.viewType}.focus`,
        "workbench.action.toggleSidebarVisibility",
      ]);
    } finally {
      commandDisposable.dispose();
      focusDisposable.dispose();
      provider.dispose();
    }
  });

  test("resolve replaces subscriptions and dispose does not dispose host", () => {
    const sessions = new FakeSessions();
    const provider = new MultiSessionManagerViewProvider(
      vscode.Uri.file("/extension"),
      sessions as any
    );
    const first = new FakeWebviewView();
    const second = new FakeWebviewView();
    provider.resolveWebviewView(first as any);
    provider.resolveWebviewView(second as any);
    first.webview.posts.length = 0;
    second.webview.posts.length = 0;

    sessions.fireState(20);

    assert.strictEqual(first.webview.posts.length, 0);
    assert.strictEqual(second.webview.posts.length, 1);
    provider.dispose();
    sessions.fireState(21);
    assert.strictEqual(second.webview.posts.length, 1);
    assert.strictEqual(sessions.disposed, false);
  });
});
