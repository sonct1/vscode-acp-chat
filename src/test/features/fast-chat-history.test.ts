import * as assert from "assert";
import * as vscode from "vscode";
import {
  deleteRemoteHistoryCatalogSession,
  readRemoteHistoryCatalog,
  writeRemoteHistoryCatalogPage,
} from "../../features/fast-chat-history/cache";

class TestMemento implements vscode.Memento {
  private readonly state = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.state.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.state.has(key) ? this.state.get(key) : defaultValue) as
      T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.state.delete(key);
    else this.state.set(key, value);
  }
}

suite("fast chat history cache", () => {
  test("persists remote metadata by agent and cwd without transcript content", async () => {
    const state = new TestMemento();
    await writeRemoteHistoryCatalogPage(
      state,
      "pi",
      "/workspace",
      [
        {
          agentId: "pi",
          sessionId: "session-1",
          title: "Session one",
          cwd: "/workspace",
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "agent",
        },
      ],
      false
    );

    assert.deepStrictEqual(
      readRemoteHistoryCatalog(state, "pi", "/workspace"),
      [
        {
          agentId: "pi",
          sessionId: "session-1",
          title: "Session one",
          cwd: "/workspace",
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "remote-cache",
        },
      ]
    );
    assert.deepStrictEqual(
      readRemoteHistoryCatalog(state, "opencode", "/workspace"),
      []
    );
  });

  test("deletes one persisted session without removing the rest of the scope", async () => {
    const state = new TestMemento();
    const sessions = ["session-1", "session-2"].map((sessionId) => ({
      agentId: "pi",
      sessionId,
      title: sessionId,
      cwd: "/workspace",
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "agent" as const,
    }));
    await writeRemoteHistoryCatalogPage(
      state,
      "pi",
      "/workspace",
      sessions,
      false
    );

    await deleteRemoteHistoryCatalogSession(state, sessions[0]);

    assert.deepStrictEqual(
      readRemoteHistoryCatalog(state, "pi", "/workspace").map(
        (session) => session.sessionId
      ),
      ["session-2"]
    );
  });

  test("appends cursor pages and keeps newest metadata for duplicate ids", async () => {
    const state = new TestMemento();
    await writeRemoteHistoryCatalogPage(
      state,
      "pi",
      "/workspace",
      [
        {
          agentId: "pi",
          sessionId: "session-1",
          title: "Old title",
          cwd: "/workspace",
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "agent",
        },
      ],
      false
    );
    await writeRemoteHistoryCatalogPage(
      state,
      "pi",
      "/workspace",
      [
        {
          agentId: "pi",
          sessionId: "session-1",
          title: "New title",
          cwd: "/workspace",
          updatedAt: "2026-01-03T00:00:00.000Z",
          source: "agent",
        },
        {
          agentId: "pi",
          sessionId: "session-2",
          title: "Second",
          cwd: "/workspace",
          updatedAt: "2026-01-02T00:00:00.000Z",
          source: "agent",
        },
      ],
      true
    );

    const sessions = readRemoteHistoryCatalog(state, "pi", "/workspace");
    assert.deepStrictEqual(
      sessions.map((session) => [session.sessionId, session.title]),
      [
        ["session-1", "New title"],
        ["session-2", "Second"],
      ]
    );
  });
});
