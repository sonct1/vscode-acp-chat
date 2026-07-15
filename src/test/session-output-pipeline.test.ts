import * as assert from "assert";
import { SessionOutputPipeline } from "../acp/session-output-pipeline";

suite("SessionOutputPipeline", () => {
  test("clears cached context usage on Pi unavailable metadata", async () => {
    let cleared = false;
    const contextUsage: unknown[] = [];
    const pipeline = new SessionOutputPipeline({
      client: {
        clearLastUsageUpdate: () => {
          cleared = true;
        },
      } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      emit: () => {},
      onContextUsageChanged: (usage) => contextUsage.push(usage),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          piAcp: {
            contextUsage: {
              state: "unavailable",
              size: 1050000,
              reason: "post_compaction",
            },
          },
        },
      },
    } as any);

    assert.strictEqual(cleared, true);
    assert.deepStrictEqual(contextUsage, [null]);
    pipeline.dispose();
  });

  test("ignores non-Pi unavailable-like metadata for context usage", async () => {
    let cleared = false;
    const contextUsage: unknown[] = [];
    const pipeline = new SessionOutputPipeline({
      client: {
        clearLastUsageUpdate: () => {
          cleared = true;
        },
      } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      emit: () => {},
      onContextUsageChanged: (usage) => contextUsage.push(usage),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "session_info_update",
        _meta: { other: { contextUsage: { state: "unavailable" } } },
      },
    } as any);

    assert.strictEqual(cleared, false);
    assert.deepStrictEqual(contextUsage, []);
    pipeline.dispose();
  });

  test("calls structured diff callback with final content before emitting completion", async () => {
    const callbackContents: unknown[] = [];
    const events: string[] = [];
    const emitted: Array<{ type: string; content?: unknown }> = [];
    const pipeline = new SessionOutputPipeline({
      client: {} as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => "before\n",
      } as any,
      onStructuredDiffContent: async (content) => {
        callbackContents.push(content);
        await Promise.resolve();
        events.push("callback");
      },
      emit: (message) => {
        events.push("emit");
        emitted.push({ type: message.type, content: message.content });
      },
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "write-1",
        title: "Write file",
        kind: "write",
        status: "completed",
        rawInput: {
          path: "/tmp/session-output-pipeline-test.txt",
          content: "after\n",
        },
      },
    } as any);

    assert.deepStrictEqual(events, ["callback", "emit"]);
    assert.strictEqual(callbackContents.length, 1);
    assert.deepStrictEqual(callbackContents[0], [
      {
        type: "diff",
        path: "/tmp/session-output-pipeline-test.txt",
        oldText: "before\n",
        newText: "after\n",
      },
    ]);
    assert.deepStrictEqual(emitted, [
      {
        type: "toolCallComplete",
        content: callbackContents[0],
      },
    ]);

    pipeline.dispose();
  });

  test("calls structured diff callback with undefined content for no-diff completions", async () => {
    const callbackContents: unknown[] = [];
    const pipeline = new SessionOutputPipeline({
      client: {} as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      onStructuredDiffContent: (content) => {
        callbackContents.push(content);
      },
      emit: () => {},
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        title: "Read file",
        kind: "read",
        status: "completed",
      },
    } as any);

    assert.deepStrictEqual(callbackContents, [undefined]);
    pipeline.dispose();
  });

  test("does not call structured diff callback for failed completions", async () => {
    const callbackContents: unknown[] = [];
    const pipeline = new SessionOutputPipeline({
      client: {} as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      onStructuredDiffContent: (content) => {
        callbackContents.push(content);
      },
      emit: () => {},
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "failed-edit",
        title: "Edit file",
        kind: "edit",
        status: "failed",
        content: [
          {
            type: "diff",
            path: "/tmp/failed.ts",
            oldText: "before",
            newText: "after",
          },
        ],
      },
    } as any);

    assert.deepStrictEqual(callbackContents, []);
    pipeline.dispose();
  });
});
