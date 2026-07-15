import * as assert from "assert";
import {
  boundedTextPresentation,
  normalizeGenericToolOutput,
  tailTextUtf8,
} from "../acp/tool-output-presentation";
import { bundledPiLiveToolOutputProfile } from "../features/pi-agent/live-tool-output";
import { bundledSwarmLiveToolOutputProfile } from "../features/swarm-agent/live-tool-output";

suite("Live tool output presentation", () => {
  test("normalizes safe generic textual shapes", () => {
    assert.deepStrictEqual(
      normalizeGenericToolOutput(
        [{ type: "content", content: { type: "text", text: "from content" } }],
        "raw"
      ),
      { format: "text", text: "from content", truncated: false }
    );
    assert.deepStrictEqual(normalizeGenericToolOutput(undefined, "raw"), {
      format: "text",
      text: "raw",
      truncated: false,
    });
    assert.deepStrictEqual(
      normalizeGenericToolOutput(undefined, {
        formatted_output: "fmt",
        output: "out",
      }),
      { format: "text", text: "fmt", truncated: false }
    );
    assert.strictEqual(
      normalizeGenericToolOutput(undefined, { nested: true }),
      undefined
    );
  });

  test("bounds text without splitting unicode", () => {
    const presentation = boundedTextPresentation(`${"a".repeat(40)}😀b`, 40);
    assert.strictEqual(presentation?.truncated, true);
    assert.strictEqual(presentation?.text.endsWith("b"), true);
    assert.strictEqual(presentation?.text.includes("�"), false);
  });

  test("keeps tiny UTF-8 limits within the requested byte budget", () => {
    const bounded = tailTextUtf8("abcdef", 4);
    assert.strictEqual(
      new TextEncoder().encode(bounded.text).byteLength <= 4,
      true
    );
    assert.strictEqual(bounded.truncated, true);
  });

  test("projects bundled Pi bash as terminal and delegate as bounded subagent", () => {
    assert.deepStrictEqual(
      bundledPiLiveToolOutputProfile.project({
        agentId: "pi",
        toolCallId: "bash-1",
        title: "bash",
        rawOutput: "one\ntwo",
      }),
      { format: "terminal", text: "one\ntwo", truncated: false }
    );

    const subagent = bundledPiLiveToolOutputProfile.project({
      agentId: "pi",
      toolCallId: "delegate-1",
      title: "delegate_explore",
      rawOutput: {
        details: {
          agent: "explore",
          status: "running",
          outputPreview: "preview",
          currentTool: "grep",
          toolHistory: [{ name: "read", summary: "src/file.ts" }],
          cwd: "/secret/not-forwarded",
        },
      },
    });

    assert.strictEqual(subagent?.format, "subagent");
    assert.strictEqual(subagent?.text, "preview");
    if (subagent?.format === "subagent") {
      assert.deepStrictEqual(subagent.subagent.toolHistory, [
        {
          name: "read",
          summary: "src/file.ts",
          startMs: undefined,
          endMs: undefined,
        },
      ]);
      assert.strictEqual("cwd" in subagent.subagent, false);
    }
  });

  test("projects explicit Pi output clear as an empty replacement snapshot", () => {
    assert.deepStrictEqual(
      bundledPiLiveToolOutputProfile.project({
        agentId: "pi",
        toolCallId: "bash-clear",
        title: "bash",
        rawOutput: undefined,
        outputCleared: true,
      }),
      { format: "terminal", text: "", truncated: false }
    );
  });

  test("does not apply Pi profile to non-allowlisted Pi tools", () => {
    assert.strictEqual(
      bundledPiLiveToolOutputProfile.project({
        agentId: "pi",
        toolCallId: "other-1",
        title: "custom_tool",
        rawOutput: "text",
      }),
      undefined
    );
  });

  test("projects bundled Swarm step and lock updates as bounded subagent output", () => {
    const step = bundledSwarmLiveToolOutputProfile.project({
      agentId: "swarm",
      toolCallId: "swarm-step-1",
      title: "swarm_step",
      rawOutput: {
        kind: "swarm_step",
        workflowId: "feature-dev",
        stepId: "review",
        roleId: "security-reviewer",
        state: "RUNNING",
        elapsedMs: 42,
        preview: "Reviewing diff",
        secret: "not forwarded",
      },
    });

    assert.strictEqual(step?.format, "subagent");
    assert.ok(step?.text.includes("Swarm step"));
    assert.ok(step?.text.includes("Reviewing diff"));
    if (step?.format === "subagent") {
      assert.strictEqual(step.subagent.agent, "security-reviewer");
      assert.strictEqual(step.subagent.status, "RUNNING");
      assert.strictEqual(step.subagent.elapsedMs, 42);
      assert.strictEqual("secret" in step.subagent, false);
    }

    const lock = bundledSwarmLiveToolOutputProfile.project({
      agentId: "swarm",
      toolCallId: "swarm-lock-1",
      title: "swarm_lock",
      rawOutput: {
        kind: "swarm_lock",
        stepId: "tests",
        lockId: "test_runner",
        event: "wait",
      },
    });
    assert.strictEqual(lock?.format, "subagent");
    assert.ok(lock?.text.includes("Swarm lock"));
    assert.ok(lock?.text.includes("test_runner"));
  });
});
