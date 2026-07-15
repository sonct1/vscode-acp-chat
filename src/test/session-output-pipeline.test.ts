/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import { SessionOutputPipeline } from "../acp/session-output-pipeline";

suite("SessionOutputPipeline", () => {
  test("emits bundled Pi live progress as replacement revisions before completion", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-1",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-1",
        status: "in_progress",
        rawOutput: "one",
      },
    } as any);
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-1",
        status: "completed",
        rawOutput: "one\ntwo",
      },
    } as any);

    const progress = emitted.find(
      (message) => message.type === "toolCallProgress"
    );
    const complete = emitted.find(
      (message) => message.type === "toolCallComplete"
    );
    assert.strictEqual((progress?.presentation as any)?.format, "terminal");
    assert.strictEqual((progress?.presentation as any)?.text, "one");
    assert.ok(Number(progress?.revision) < Number(complete?.revision));
    pipeline.dispose();
  });

  test("coalesces rapid Pi progress snapshots and emits the latest trailing snapshot", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-rapid",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    for (const rawOutput of ["one", "two", "three"]) {
      await pipeline.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "bash-rapid",
          status: "in_progress",
          rawOutput,
        },
      } as any);
    }

    assert.deepStrictEqual(
      emitted
        .filter((message) => message.type === "toolCallProgress")
        .map((message) => (message.presentation as { text: string }).text),
      ["one"]
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.deepStrictEqual(
      emitted
        .filter((message) => message.type === "toolCallProgress")
        .map((message) => (message.presentation as { text: string }).text),
      ["one", "three"]
    );
    pipeline.dispose();
  });

  test("completion cancels pending progress before async enrichment", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    let releaseStructuredDiff: (() => void) | undefined;
    const structuredDiffWait = new Promise<void>((resolve) => {
      releaseStructuredDiff = resolve;
    });
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      onStructuredDiffContent: () => structuredDiffWait,
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-complete",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    for (const rawOutput of ["one", "two"]) {
      await pipeline.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "bash-complete",
          status: "in_progress",
          rawOutput,
        },
      } as any);
    }

    const completion = pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-complete",
        status: "completed",
        rawOutput: "final",
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.deepStrictEqual(
      emitted
        .filter((message) => message.type === "toolCallProgress")
        .map((message) => (message.presentation as { text: string }).text),
      ["one"]
    );
    releaseStructuredDiff?.();
    await completion;
    assert.strictEqual(
      emitted.filter((message) => message.type === "toolCallComplete").length,
      1
    );
    pipeline.dispose();
  });

  test("emits explicit clear as an empty replacement presentation", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-clear",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-clear",
        status: "in_progress",
        rawOutput: "one",
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-clear",
        status: "in_progress",
        rawOutput: null,
      },
    } as any);

    const progress = emitted.filter(
      (message) => message.type === "toolCallProgress"
    );
    assert.strictEqual(
      (progress.at(-1)?.presentation as { text: string }).text,
      ""
    );
    pipeline.dispose();
  });

  test("clearing one output field preserves another displayable field", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-independent-clear",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-independent-clear",
        status: "in_progress",
        content: [],
        rawOutput: "new snapshot",
      },
    } as any);

    const progress = emitted.find(
      (message) => message.type === "toolCallProgress"
    );
    assert.strictEqual(
      (progress?.presentation as { text: string }).text,
      "new snapshot"
    );
    pipeline.dispose();
  });

  test("completion falls back to latest presentation for empty final output", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-final-fallback",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-final-fallback",
        status: "in_progress",
        rawOutput: "latest live",
      },
    } as any);
    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-final-fallback",
        status: "completed",
        content: [],
        rawOutput: null,
      },
    } as any);

    const complete = emitted.find(
      (message) => message.type === "toolCallComplete"
    );
    assert.strictEqual(
      (complete?.presentation as { text: string }).text,
      "latest live"
    );
    pipeline.dispose();
  });

  test("reset cancels trailing progress timers", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "pi" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      liveToolOutputProfile: "bundled-pi",
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "bash-reset",
        title: "bash",
        kind: "other",
        status: "in_progress",
      },
    } as any);
    for (const rawOutput of ["one", "two"]) {
      await pipeline.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "bash-reset",
          status: "in_progress",
          rawOutput,
        },
      } as any);
    }
    pipeline.reset();
    await new Promise((resolve) => setTimeout(resolve, 220));

    assert.deepStrictEqual(
      emitted
        .filter((message) => message.type === "toolCallProgress")
        .map((message) => (message.presentation as { text: string }).text),
      ["one"]
    );
    pipeline.dispose();
  });

  test("does not emit generic live progress without rollout flag", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pipeline = new SessionOutputPipeline({
      client: { getAgentId: () => "other" } as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      emit: (message) => emitted.push(message),
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
        rawOutput: "live",
      },
    } as any);

    assert.strictEqual(
      emitted.some((message) => message.type === "toolCallProgress"),
      false
    );
    pipeline.dispose();
  });

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

  test("history mode skips workspace reconstruction and structured diff callback", async () => {
    let structuredDiffCalls = 0;
    let emitted: Record<string, unknown> | undefined;
    const pipeline = new SessionOutputPipeline({
      client: {} as any,
      fileHandler: {
        clearLastFileContents: () => {},
        getLastFileContent: () => undefined,
      } as any,
      state: {
        userMessageBuffer: "",
        userMessageImages: [],
        toolCalls: new Map(),
        isLoadingHistory: true,
      },
      onStructuredDiffContent: () => {
        structuredDiffCalls += 1;
      },
      emit: (message) => {
        emitted = message;
      },
    });

    await pipeline.handleSessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        title: "Edit file",
        kind: "edit",
        status: "completed",
        rawInput: {
          path: "/tmp/session-output-pipeline-test.txt",
          old_string: "before",
          new_string: "after",
        },
      },
    } as any);

    assert.strictEqual(structuredDiffCalls, 0);
    assert.strictEqual(emitted?.type, "toolCallComplete");
    assert.strictEqual(emitted?.content, undefined);
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
