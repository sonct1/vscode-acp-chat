import * as assert from "assert";
import * as vscode from "vscode";
import {
  activeSessionBindingKey,
  readActiveSessionBinding,
  writeActiveSessionBinding,
} from "../../features/multi-session/active-session-persistence";

class TestMemento implements vscode.Memento {
  private readonly state = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.state.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.state.has(key) ? this.state.get(key) : defaultValue) as
      | T
      | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.state.delete(key);
    else this.state.set(key, value);
  }
}

suite("multi-session active session persistence", () => {
  test("workspace key normalization preserves filesystem root identities", () => {
    assert.strictEqual(activeSessionBindingKey("/"), activeSessionBindingKey("/"));
    assert.strictEqual(
      activeSessionBindingKey("C:\\"),
      activeSessionBindingKey("C:/")
    );
    assert.strictEqual(
      activeSessionBindingKey("\\\\server\\share\\repo\\"),
      activeSessionBindingKey("//server/share/repo")
    );
  });

  test("stored cwd remains the original filesystem path", async () => {
    const state = new TestMemento();
    const paths = ["/", "C:\\", "\\\\server\\share\\repo"];

    for (const cwd of paths) {
      await writeActiveSessionBinding(state, cwd, {
        agentId: "test-agent",
        sessionId: `session-${paths.indexOf(cwd)}`,
        cwd,
      });
      assert.strictEqual(readActiveSessionBinding(state, cwd)?.cwd, cwd);
    }
  });
});
