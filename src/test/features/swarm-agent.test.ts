import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  clearAgentsCacheForTest,
  getAgent,
  getBuiltinAgentConfigsForTest,
} from "../../acp/agents";
import {
  createSwarmRuntimeConfig,
  loadSwarmRuntimeConfigFile,
} from "../../features/swarm-agent/adapter/config-loader";
import {
  normalizeSwarmState,
  SwarmStateMachine,
} from "../../features/swarm-agent/adapter/state-machine";
import {
  SwarmConfigValidationError,
  validateSwarmRuntimeConfig,
} from "../../features/swarm-agent/types";

async function updateConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("vscode-acp-chat")
    .update(key, value, vscode.ConfigurationTarget.Global);
  clearAgentsCacheForTest();
}

suite("features/swarm-agent", () => {
  suite("agent catalog", () => {
    let originalEnabled: boolean | undefined;
    let originalCustomAgents: unknown;

    setup(() => {
      const config = vscode.workspace.getConfiguration("vscode-acp-chat");
      originalEnabled = config.get<boolean>("swarmAgent.enabled");
      originalCustomAgents = config.get("customAgents");
    });

    teardown(async () => {
      await updateConfig("swarmAgent.enabled", originalEnabled);
      await updateConfig("customAgents", originalCustomAgents);
    });

    test("only includes bundled Swarm when enabled", async () => {
      await updateConfig("swarmAgent.enabled", false);
      assert.strictEqual(
        getBuiltinAgentConfigsForTest().some((agent) => agent.id === "swarm"),
        false
      );

      await updateConfig("swarmAgent.enabled", true);
      const swarm = getBuiltinAgentConfigsForTest().find(
        (agent) => agent.id === "swarm"
      );
      assert.ok(swarm, "swarm agent should exist when enabled");
      assert.strictEqual(swarm.command, process.execPath);
      assert.strictEqual(swarm.env?.ELECTRON_RUN_AS_NODE, "1");
      assert.ok(swarm.env?.VSCODE_ACP_CHAT_SWARM_CONFIG_PATH);
      assert.strictEqual(swarm.liveToolOutputProfile, "bundled-swarm");
      assert.ok(
        swarm.args.some((arg) =>
          arg.replace(/\\/g, "/").endsWith("swarm-acp/index.mjs")
        )
      );
    });

    test("allows custom swarm override when built-in is enabled", async () => {
      const custom = {
        id: "swarm",
        name: "Custom Swarm",
        command: "custom-swarm-acp",
        args: ["--stdio"],
      };
      await updateConfig("swarmAgent.enabled", true);
      await updateConfig("customAgents", [custom]);

      const agent = getAgent("swarm");
      assert.strictEqual(agent?.name, custom.name);
      assert.strictEqual(agent?.command, custom.command);
      assert.strictEqual(agent?.liveToolOutputProfile, undefined);
    });
  });

  suite("config schema", () => {
    test("validates arbitrary role ids and detects missing roles/dependency cycles", () => {
      const base = {
        version: 1,
        workspaceRoot: process.cwd(),
        defaultWorkflow: "feature-dev",
        maxWorkers: 2,
        requireApprovalBeforeWrites: true,
        testLockPatterns: ["npm test"],
        agents: [{ id: "pi", name: "Pi", command: "pi", args: ["acp"] }],
        roles: {
          "security-reviewer": {
            agentId: "pi",
            capabilities: { read: true, write: false },
          },
        },
        workflows: {
          "feature-dev": {
            steps: [
              {
                id: "scan",
                role: "security-reviewer",
                prompt: "scan",
              },
            ],
          },
        },
        locks: { test_runner: { patterns: ["npm test"] }, named: [] },
      };

      assert.doesNotThrow(() => validateSwarmRuntimeConfig(base));

      assert.throws(
        () =>
          validateSwarmRuntimeConfig({
            ...base,
            workflows: {
              "feature-dev": {
                steps: [{ id: "scan", role: "missing", prompt: "scan" }],
              },
            },
          }),
        SwarmConfigValidationError
      );

      assert.throws(
        () =>
          validateSwarmRuntimeConfig({
            ...base,
            workflows: {
              "feature-dev": {
                steps: [
                  { id: "a", role: "security-reviewer", prompt: "a", dependsOn: ["b"] },
                  { id: "b", role: "security-reviewer", prompt: "b", dependsOn: ["a"] },
                ],
              },
            },
          }),
        SwarmConfigValidationError
      );
    });

    test("normalizes DONE and IDLE as separate states", () => {
      assert.strictEqual(normalizeSwarmState("Done"), "DONE");
      assert.strictEqual(normalizeSwarmState("Idle"), "IDLE");
      const machine = new SwarmStateMachine();
      assert.strictEqual(machine.transition("STARTING"), "STARTING");
      assert.strictEqual(machine.transition("IDLE"), "IDLE");
      assert.strictEqual(machine.transition("RUNNING"), "RUNNING");
      assert.strictEqual(machine.transition("DONE"), "DONE");
    });
  });

  suite("runtime config materialization", () => {
    test("loads roles and workflows from workspace config files", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"));
      await fs.mkdir(path.join(dir, "roles"));
      await fs.mkdir(path.join(dir, "workflows"));
      await fs.writeFile(
        path.join(dir, "swarm.config.json"),
        JSON.stringify({ defaultWorkflow: "review-only", locks: { named: ["database"] } })
      );
      await fs.writeFile(
        path.join(dir, "roles", "peer.json"),
        JSON.stringify({ agentId: "pi", capabilities: { read: true, write: false } })
      );
      await fs.writeFile(
        path.join(dir, "workflows", "review-only.json"),
        JSON.stringify({
          steps: [{ id: "review", role: "peer", prompt: "review" }],
        })
      );

      const runtime = await createSwarmRuntimeConfig({
        workspaceRoot: dir,
        configDirectory: dir,
        defaultWorkflow: "default",
        maxWorkers: 4,
        requireApprovalBeforeWrites: true,
        testLockPatterns: ["npm test"],
        agents: [{ id: "pi", name: "Pi", command: "pi", args: [] }],
      });

      assert.strictEqual(runtime.defaultWorkflow, "review-only");
      assert.ok(runtime.roles.peer);
      assert.ok(runtime.workflows["review-only"]);
      assert.deepStrictEqual(runtime.locks.named, ["database"]);

      const file = path.join(dir, "runtime.json");
      await fs.writeFile(file, JSON.stringify(runtime));
      const loaded = await loadSwarmRuntimeConfigFile(file);
      assert.strictEqual(loaded.workflows["review-only"].steps[0].role, "peer");
    });
  });
});
