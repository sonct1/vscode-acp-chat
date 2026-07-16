import * as assert from "assert";
import type { AgentContext, CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { SwarmCapabilityProxy } from "../../features/swarm-agent/adapter/capability-proxy";
import { SwarmEvidenceStore } from "../../features/swarm-agent/adapter/evidence-store";
import { SwarmLockManager } from "../../features/swarm-agent/adapter/lock-manager";
import { renderStepPrompt } from "../../features/swarm-agent/adapter/prompt-renderer";
import { parseSwarmRootRouteDecision } from "../../features/swarm-agent/adapter/route-parser";
import { SwarmWorkflowEngine } from "../../features/swarm-agent/adapter/workflow-engine";
import { validateSwarmRuntimeConfig } from "../../features/swarm-agent/types";
import type {
  SwarmRuntimeConfig,
  SwarmWorkflowConfig,
} from "../../features/swarm-agent/types";

suite("features/swarm-agent adapter", () => {
  test("workflow engine executes serial and parallel DAG steps without fixed role names", async () => {
    const workflow: SwarmWorkflowConfig = {
      id: "custom-flow",
      steps: [
        { id: "a", role: "alpha", prompt: "a", dependsOn: [], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 },
        { id: "b", role: "beta", prompt: "b", dependsOn: ["a"], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 },
        { id: "c", role: "gamma", prompt: "c", dependsOn: ["a"], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 },
      ],
    };
    const engine = new SwarmWorkflowEngine(runtimeConfig(workflow));
    const started: string[] = [];

    const result = await engine.execute(workflow, async (step) => {
      started.push(step.id);
      return { state: "DONE", output: step.id };
    });

    assert.strictEqual(result.state, "DONE");
    assert.strictEqual(started[0], "a");
    assert.deepStrictEqual(new Set(started.slice(1)), new Set(["b", "c"]));
  });

  test("workflow engine retries failed steps when configured", async () => {
    const workflow: SwarmWorkflowConfig = {
      id: "retry-flow",
      steps: [
        {
          id: "flaky",
          role: "builder",
          prompt: "build",
          dependsOn: [],
          requiresLocks: [],
          produces: [],
          onFailure: "retry",
          retryLimit: 1,
        },
      ],
    };
    const engine = new SwarmWorkflowEngine(runtimeConfig(workflow));
    let attempts = 0;

    const result = await engine.execute(workflow, async () => {
      attempts += 1;
      return attempts === 1
        ? { state: "FAILED", output: "no" }
        : { state: "DONE", output: "ok" };
    });

    assert.strictEqual(result.state, "DONE");
    assert.strictEqual(attempts, 2);
  });

  test("capability proxy denies writes for arbitrary read-only role and forwards allowed writes", async () => {
    const evidence = new SwarmEvidenceStore();
    const requests: Array<{ method: string; params: unknown }> = [];
    const upstream = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      },
    } as unknown as AgentContext;

    const readOnly = new SwarmCapabilityProxy(
      upstream,
      {
        read: true,
        write: false,
        terminal: false,
        allowFileDelete: false,
        testLock: true,
        allowedTerminalCommands: [],
        requireApprovalBeforeWrite: false,
        requireApprovalBeforeTerminal: false,
      },
      context(),
      { evidence }
    );

    await assert.rejects(() =>
      readOnly.writeTextFile({ sessionId: "worker", path: "/tmp/a", content: "x" })
    );
    await assert.rejects(() =>
      readOnly.terminalOutput({ sessionId: "worker", terminalId: "term-1" })
    );
    assert.strictEqual(evidence.getViolations()[0].capability, "write");
    assert.strictEqual(evidence.getViolations()[1].capability, "terminal");

    const writeCapable = new SwarmCapabilityProxy(
      upstream,
      {
        read: true,
        write: true,
        terminal: false,
        allowFileDelete: false,
        testLock: true,
        allowedTerminalCommands: [],
        requireApprovalBeforeWrite: false,
        requireApprovalBeforeTerminal: false,
      },
      context(),
      { evidence }
    );
    await writeCapable.writeTextFile({ sessionId: "worker", path: "/tmp/a", content: "x" });
    assert.strictEqual(requests[0].method, "fs/write_text_file");
    assert.strictEqual((requests[0].params as { sessionId: string }).sessionId, "root");
  });

  test("lock manager serializes named locks", async () => {
    const lockManager = new SwarmLockManager();
    const events: string[] = [];

    await Promise.all([
      lockManager.withLocks(["test_runner"], "a", async () => {
        events.push("a-start");
        await delay(30);
        events.push("a-end");
      }),
      lockManager.withLocks(["test_runner"], "b", async () => {
        events.push("b-start");
        events.push("b-end");
      }),
    ]);

    assert.deepStrictEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
  });

  test("capability proxy requires terminal command prefixes for restricted roles", async () => {
    const evidence = new SwarmEvidenceStore();
    const upstream = {
      request: async (_method: string, _params: CreateTerminalRequest) => ({ terminalId: "t1" }),
    } as unknown as AgentContext;
    const proxy = new SwarmCapabilityProxy(
      upstream,
      {
        read: true,
        write: false,
        terminal: "restricted",
        allowFileDelete: false,
        testLock: true,
        allowedTerminalCommands: ["npm test"],
        requireApprovalBeforeWrite: false,
        requireApprovalBeforeTerminal: false,
      },
      context(),
      { evidence }
    );

    await proxy.createTerminal({ sessionId: "worker", command: "npm", args: ["test"] });
    await assert.rejects(() =>
      proxy.createTerminal({
        sessionId: "worker",
        command: "sh",
        args: ["-c", "echo npm test && rm -rf /tmp/nope"],
      })
    );
    assert.strictEqual(evidence.getViolations()[0].capability, "terminal");
  });

  test("capability proxy acquires test lock for configured terminal command patterns", async () => {
    const evidence = new SwarmEvidenceStore();
    const lockManager = new SwarmLockManager(undefined, evidence);
    const upstream = {
      request: async (_method: string, _params: CreateTerminalRequest) => ({ terminalId: "t1" }),
    } as unknown as AgentContext;
    const proxy = new SwarmCapabilityProxy(
      upstream,
      {
        read: true,
        write: false,
        terminal: true,
        allowFileDelete: false,
        testLock: true,
        allowedTerminalCommands: [],
        requireApprovalBeforeWrite: false,
        requireApprovalBeforeTerminal: false,
      },
      context(),
      { lockManager, evidence, testLockPatterns: ["npm test"] }
    );

    const terminal = await proxy.createTerminal({ sessionId: "worker", command: "npm", args: ["test"] });
    await proxy.terminalOutput({ sessionId: "worker", terminalId: terminal.terminalId });
    await assert.rejects(() =>
      proxy.terminalOutput({ sessionId: "worker", terminalId: "other-terminal" })
    );
    assert.deepStrictEqual(
      evidence.getLockEvents().map((event) => event.event),
      ["acquire", "release"]
    );
    assert.strictEqual(evidence.getViolations()[0].capability, "terminal");
  });

  test("root route parser accepts only strict direct/workflow decisions", () => {
    const config = runtimeConfig({ id: "default", steps: [{ id: "s", role: "r", prompt: "", dependsOn: [], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 }] });
    config.workflows.other = { id: "other", steps: [{ id: "s", role: "r", prompt: "", dependsOn: [], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 }] };

    assert.deepStrictEqual(parseSwarmRootRouteDecision('{"version":1,"action":"direct"}', config), { version: 1, action: "direct" });
    assert.deepStrictEqual(parseSwarmRootRouteDecision('```json\n{"version":1,"action":"workflow","workflowId":"other"}\n```', config), { version: 1, action: "workflow", workflowId: "other" });
    assert.throws(() => parseSwarmRootRouteDecision('{"version":1,"action":"workflow","workflowId":"missing"}', config));
    assert.throws(() => parseSwarmRootRouteDecision('{"version":1,"action":"direct","workflowId":"default"}', config));
    assert.throws(() => parseSwarmRootRouteDecision('prefix {"version":1,"action":"direct"}', config));
    assert.throws(() => parseSwarmRootRouteDecision(`${"x".repeat(8193)}`, config));
  });

  test("root route parser rejects inherited prototype workflow ids", () => {
    const config = runtimeConfig({ id: "default", steps: [{ id: "s", role: "r", prompt: "", dependsOn: [], requiresLocks: [], produces: [], onFailure: "stop", retryLimit: 0 }] });
    assert.throws(() => parseSwarmRootRouteDecision('{"version":1,"action":"workflow","workflowId":"__proto__"}', config));
    assert.throws(() => parseSwarmRootRouteDecision('{"version":1,"action":"workflow","workflowId":"constructor"}', config));
    assert.throws(() => parseSwarmRootRouteDecision('{"version":1,"action":"workflow","workflowId":"toString"}', config));
  });

  test("runtime config rejects reserved workflow and role ids", () => {
    for (const reservedId of ["__proto__", "constructor", "prototype", "toString"]) {
      const input = {
        version: 1,
        workspaceRoot: process.cwd(),
        rootRole: reservedId,
        defaultWorkflow: reservedId,
        maxWorkers: 1,
        requireApprovalBeforeWrites: false,
        testLockPatterns: [],
        agents: [{ id: "pi", name: "Pi", command: "pi", args: [] }],
        roles: Object.assign(Object.create(null), {
          [reservedId]: { id: reservedId, agentId: "pi", capabilities: { read: true } },
        }),
        workflows: Object.assign(Object.create(null), {
          [reservedId]: {
            id: reservedId,
            steps: [{ id: "s", role: reservedId, prompt: "" }],
          },
        }),
        locks: { test_runner: { patterns: [] }, named: [] },
      };

      assert.throws(() => validateSwarmRuntimeConfig(input), /reserved registry id/);
    }
  });

  test("evidence finalization payload preserves all steps and important trailing evidence", () => {
    const evidence = new SwarmEvidenceStore();
    for (const stepId of ["one", "two", "three", "final"]) {
      evidence.startStep(stepId, "worker", 1);
      evidence.finishStep({
        stepId,
        roleId: "worker",
        state: "DONE",
        output: `${stepId}-start-${"x".repeat(25_000)}-${stepId}-end`,
      });
    }
    evidence.addViolation({
      stepId: "final",
      roleId: "worker",
      capability: "write",
      message: "denied write",
    });

    const monitorSummary = evidence.summarize("DONE");
    const finalization = evidence.finalizationEvidence("DONE");
    assert.ok(!monitorSummary.includes("final-end"));
    for (const stepId of ["one", "two", "three", "final"]) {
      assert.ok(finalization.includes(`${stepId}-start`));
      assert.ok(finalization.includes(`${stepId}-end`));
    }
    assert.ok(finalization.includes("denied write"));
    assert.ok(finalization.length <= 80_000);
  });

  test("prompt renderer injects dependency outputs without root answer prefill", () => {
    const evidence = new SwarmEvidenceStore();
    evidence.startStep("research", "peer", 1);
    evidence.finishStep({
      stepId: "research",
      roleId: "peer",
      state: "DONE",
      output: "Observed risk A",
    });

    const prompt = renderStepPrompt({
      workflow: { id: "flow", steps: [] },
      step: {
        id: "build",
        role: "builder",
        prompt: "Implement using evidence only.",
        dependsOn: ["research"],
        requiresLocks: [],
        produces: ["diff"],
        onFailure: "stop",
        retryLimit: 0,
      },
      role: {
        id: "builder",
        agentId: "pi",
        prompt: "Be autonomous.",
        capabilities: {
          read: true,
          write: true,
          terminal: true,
          allowFileDelete: false,
          testLock: true,
          allowedTerminalCommands: [],
          requireApprovalBeforeWrite: false,
          requireApprovalBeforeTerminal: false,
        },
      },
      originalPrompt: "User task",
      evidence,
    });

    assert.ok(prompt.includes("Observed risk A"));
    assert.ok(prompt.includes("Do not assume the root orchestrator's prompt contains the answer"));
    assert.ok(!prompt.includes("I think the answer is"));
  });
});

function runtimeConfig(workflow: SwarmWorkflowConfig): SwarmRuntimeConfig {
  return {
    version: 1,
    workspaceRoot: process.cwd(),
    rootRole: "root",
    defaultWorkflow: workflow.id,
    maxWorkers: 3,
    requireApprovalBeforeWrites: true,
    testLockPatterns: ["npm test"],
    agents: [{ id: "pi", name: "Pi", command: "pi", args: [] }],
    roles: {
      root: {
        id: "root",
        agentId: "pi",
        capabilities: {
          read: true,
          write: false,
          terminal: false,
          allowFileDelete: false,
          testLock: true,
          allowedTerminalCommands: [],
          requireApprovalBeforeWrite: false,
          requireApprovalBeforeTerminal: false,
        },
      },
    },
    workflows: { [workflow.id]: workflow },
    locks: { test_runner: { patterns: ["npm test"] }, named: [] },
  };
}

function context() {
  return {
    workflowId: "flow",
    stepId: "step",
    roleId: "role",
    workerSessionId: "worker",
    rootSessionId: "root",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
