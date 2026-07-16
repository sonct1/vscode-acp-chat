import * as assert from "assert";
import type { AgentContext, PromptResponse } from "@agentclientprotocol/sdk";
import { SwarmRootOrchestrator } from "../../features/swarm-agent/adapter/root-orchestrator";
import type { SwarmRuntimeConfig, SwarmWorkerState } from "../../features/swarm-agent/types";

type RootPhase = "route" | "direct" | "finalizeWorkflow";

class StubRootRuntime {
  readonly prompts: Array<{ phase: RootPhase; prompt: string }> = [];
  cancelled = false;
  disposed = false;

  constructor(private readonly outputs: Array<string | Error | { output: string; stopReason?: PromptResponse["stopReason"] }>) {}

  async prompt(phase: RootPhase, prompt: string): Promise<{ output: string; stopReason?: PromptResponse["stopReason"] }> {
    this.prompts.push({ phase, prompt });
    const next = this.outputs.shift() ?? "";
    if (next instanceof Error) throw next;
    if (typeof next === "string") return { output: next };
    return next;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class StubWorkerRuntime {
  disposed = false;
  cancelled = false;

  constructor(
    private readonly onRun: (prompt: string) => Promise<{ state: SwarmWorkerState; output: string }> | { state: SwarmWorkerState; output: string } = () => ({ state: "DONE", output: "worker-output" })
  ) {}

  async run(prompt: string): Promise<{ state: SwarmWorkerState; output: string }> {
    return this.onRun(prompt);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

suite("features/swarm-agent root orchestrator", () => {
  test("DIRECT creates no workflow worker and hidden route JSON is not forwarded", async () => {
    const root = new StubRootRuntime([
      '{"version":1,"action":"direct"}',
      "direct answer",
    ]);
    const workers: StubWorkerRuntime[] = [];
    const client = recordingClient();
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => {
        const worker = new StubWorkerRuntime();
        workers.push(worker);
        return worker;
      },
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });

    const response = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }, client);

    assert.strictEqual(response.stopReason, "end_turn");
    assert.strictEqual(workers.length, 0);
    assert.deepStrictEqual(client.chunks, []);
    assert.deepStrictEqual(root.prompts.map((item) => item.phase), ["route", "direct"]);
  });

  test("workflow selected by Root can differ from defaultWorkflow", async () => {
    const root = new StubRootRuntime([
      '{"version":1,"action":"workflow","workflowId":"other"}',
      "final answer",
    ]);
    const workerPrompts: string[] = [];
    const config = runtimeConfig();
    const orchestrator = new SwarmRootOrchestrator({
      config,
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => new StubWorkerRuntime((prompt) => {
        workerPrompts.push(prompt);
        return { state: "DONE", output: "other done" };
      }),
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });

    const response = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "run workflow" }] }, recordingClient());

    assert.strictEqual(response.stopReason, "end_turn");
    assert.strictEqual(config.defaultWorkflow, "default");
    assert.strictEqual(workerPrompts.length, 1);
    assert.ok(workerPrompts[0].includes("Other step prompt"));
  });

  test("malformed route twice starts no worker and disposes stale root runtime", async () => {
    const root = new StubRootRuntime(["not json", "still not json"]);
    let workers = 0;
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => {
        workers += 1;
        return new StubWorkerRuntime();
      },
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });

    await assert.rejects(() => orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "bad route" }] }, recordingClient()));

    assert.strictEqual(workers, 0);
    assert.strictEqual(root.disposed, true);
    assert.deepStrictEqual(root.prompts.map((item) => item.phase), ["route", "route"]);
  });

  test("direct prompt error disposes active root and next prompt gets fresh root", async () => {
    const firstRoot = new StubRootRuntime(['{"version":1,"action":"direct"}', new Error("direct failed")]);
    const secondRoot = new StubRootRuntime(['{"version":1,"action":"direct"}', "fresh answer"]);
    const roots = [firstRoot, secondRoot];
    let rootIndex = 0;
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => roots[rootIndex++],
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });

    await assert.rejects(() => orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "fail" }] }, recordingClient()), /direct failed/);
    const next = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "next" }] }, recordingClient());

    assert.strictEqual(firstRoot.cancelled, true);
    assert.strictEqual(firstRoot.disposed, true);
    assert.strictEqual(next.stopReason, "end_turn");
    assert.deepStrictEqual(secondRoot.prompts.map((item) => item.phase), ["route", "direct"]);
  });

  test("Root session/runtime is reused across two normal prompts", async () => {
    const roots = [
      new StubRootRuntime(['{"version":1,"action":"direct"}', "one", '{"version":1,"action":"direct"}', "two"]),
    ];
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => roots[0],
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });
    const client = recordingClient();

    await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "first" }] }, client);
    await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "second" }] }, client);

    assert.strictEqual(roots.length, 1);
    assert.deepStrictEqual(roots[0].prompts.map((item) => item.phase), ["route", "direct", "route", "direct"]);
  });

  test("cancellation during route repair returns cancelled instead of invalid route", async () => {
    const root = new StubRootRuntime(["not json", { output: "", stopReason: "cancelled" }]);
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => new StubWorkerRuntime(),
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });

    const response = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "repair cancel" }] }, recordingClient());

    assert.strictEqual(response.stopReason, "cancelled");
    assert.strictEqual(root.disposed, true);
    assert.deepStrictEqual(root.prompts.map((item) => item.phase), ["route", "route"]);
  });

  test("cancellation during routing does not send repair and causes fresh runtime next prompt", async () => {
    const firstRoot = new StubRootRuntime([{ output: "", stopReason: "cancelled" }]);
    const secondRoot = new StubRootRuntime(['{"version":1,"action":"direct"}', "after cancel"]);
    const roots = [firstRoot, secondRoot];
    let rootIndex = 0;
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => roots[rootIndex++],
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });
    const client = recordingClient();

    const cancelled = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "cancel" }] }, client);
    const next = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "next" }] }, client);

    assert.strictEqual(cancelled.stopReason, "cancelled");
    assert.strictEqual(next.stopReason, "end_turn");
    assert.strictEqual(firstRoot.disposed, true);
    assert.deepStrictEqual(firstRoot.prompts.map((item) => item.phase), ["route"]);
    assert.deepStrictEqual(secondRoot.prompts.map((item) => item.phase), ["route", "direct"]);
  });

  test("workflow lock waiter becomes cancelled no-op and never constructs worker after cancellation", async () => {
    const root = new StubRootRuntime(['{"version":1,"action":"workflow","workflowId":"locked"}']);
    let constructed = 0;
    let releaseFirst: (() => void) | undefined;
    const config = runtimeConfig();
    config.workflows.locked = {
      id: "locked",
      maxWorkers: 2,
      steps: [
        { id: "first", role: "worker", prompt: "First", dependsOn: [], requiresLocks: ["shared"], produces: [], onFailure: "stop", retryLimit: 0 },
        { id: "second", role: "worker", prompt: "Second", dependsOn: [], requiresLocks: ["shared"], produces: [], onFailure: "stop", retryLimit: 0 },
      ],
    };
    const orchestrator = new SwarmRootOrchestrator({
      config,
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => {
        constructed += 1;
        return new StubWorkerRuntime(async (prompt) => {
          if (prompt.includes("First")) {
            await new Promise<void>((resolve) => { releaseFirst = resolve; });
          }
          return { state: "DONE", output: "done" };
        });
      },
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });
    const promptPromise = orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "locked" }] }, recordingClient());
    await waitUntil(() => releaseFirst !== undefined);

    await orchestrator.cancel({ sessionId: session.sessionId });
    releaseFirst?.();
    const response = await promptPromise;

    assert.strictEqual(response.stopReason, "cancelled");
    assert.strictEqual(constructed, 1);
  });

  test("workflow finalization cancelled stopReason disposes root and emits no fallback summary", async () => {
    const root = new StubRootRuntime([
      '{"version":1,"action":"workflow","workflowId":"default"}',
      { output: "partial", stopReason: "cancelled" },
    ]);
    const client = recordingClient();
    const orchestrator = new SwarmRootOrchestrator({
      config: runtimeConfig(),
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => new StubWorkerRuntime(),
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });

    const response = await orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "workflow" }] }, client);

    assert.strictEqual(response.stopReason, "cancelled");
    assert.strictEqual(root.disposed, true);
    assert.ok(!client.chunks.some((chunk) => chunk.includes("Workflow state")));
  });

  test("closing a session invalidates an active workflow before later workers start", async () => {
    const root = new StubRootRuntime(['{"version":1,"action":"workflow","workflowId":"locked"}']);
    let constructed = 0;
    let releaseFirst: (() => void) | undefined;
    const config = runtimeConfig();
    config.workflows.locked = {
      id: "locked",
      maxWorkers: 2,
      steps: [
        { id: "first", role: "worker", prompt: "First", dependsOn: [], requiresLocks: ["shared"], produces: [], onFailure: "stop", retryLimit: 0 },
        { id: "second", role: "worker", prompt: "Second", dependsOn: [], requiresLocks: ["shared"], produces: [], onFailure: "stop", retryLimit: 0 },
      ],
    };
    const orchestrator = new SwarmRootOrchestrator({
      config,
      rootRuntimeFactory: () => root,
      workerRuntimeFactory: () => {
        constructed += 1;
        return new StubWorkerRuntime(async (prompt) => {
          if (prompt.includes("First")) {
            await new Promise<void>((resolve) => { releaseFirst = resolve; });
          }
          return { state: "DONE", output: "done" };
        });
      },
    });
    const session = await orchestrator.newSession({ cwd: process.cwd(), mcpServers: [] });
    const promptPromise = orchestrator.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "close" }] }, recordingClient());
    await waitUntil(() => releaseFirst !== undefined);

    const closePromise = orchestrator.closeSession({ sessionId: session.sessionId });
    releaseFirst?.();
    await closePromise;
    const response = await promptPromise;

    assert.strictEqual(response.stopReason, "cancelled");
    assert.strictEqual(constructed, 1);
    assert.strictEqual(root.disposed, true);
  });
});

function recordingClient(): AgentContext & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    notify: async (_method: string, params: { update?: { content?: { text?: string } } }) => {
      const text = params.update?.content?.text;
      if (text) chunks.push(text);
    },
    request: async () => ({}),
  } as unknown as AgentContext & { chunks: string[] };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

function runtimeConfig(): SwarmRuntimeConfig {
  const capabilities = {
    read: true,
    write: false,
    terminal: false,
    allowFileDelete: false,
    testLock: true,
    allowedTerminalCommands: [],
    requireApprovalBeforeWrite: false,
    requireApprovalBeforeTerminal: false,
  };
  return {
    version: 1,
    workspaceRoot: process.cwd(),
    rootRole: "root",
    defaultWorkflow: "default",
    maxWorkers: 3,
    requireApprovalBeforeWrites: true,
    testLockPatterns: ["npm test"],
    agents: [{ id: "pi", name: "Pi", command: "pi", args: [] }],
    roles: {
      root: {
        id: "root",
        agentId: "pi",
        prompt: "Root custom instructions.",
        capabilities,
      },
      worker: {
        id: "worker",
        agentId: "pi",
        capabilities,
      },
    },
    workflows: {
      default: {
        id: "default",
        steps: [{ id: "default-step", role: "worker", prompt: "Default step prompt", dependsOn: [], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 }],
      },
      other: {
        id: "other",
        steps: [{ id: "other-step", role: "worker", prompt: "Other step prompt", dependsOn: [], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 }],
      },
    },
    locks: { test_runner: { patterns: ["npm test"] }, named: [] },
  };
}
