import * as assert from "assert";
import * as vscode from "vscode";
import { validateAgent } from "../acp/agent-validator";
import {
  AGENTS,
  clearAgentsCacheForTest,
  getAgent,
  getBuiltinAgentConfigsForTest,
  getFirstAvailableAgent,
} from "../acp/agents";

async function updateConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("vscode-acp-chat")
    .update(key, value, vscode.ConfigurationTarget.Global);
  clearAgentsCacheForTest();
}

suite("agents", () => {
  suite("AGENTS", () => {
    test("should have at least one agent defined", () => {
      assert.ok(AGENTS.length > 0);
    });

    test("should have unique ids for all agents", () => {
      const ids = AGENTS.map((a) => a.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, ids.length);
    });

    test("should have required properties for each agent", () => {
      for (const agent of AGENTS) {
        assert.ok(agent.id, "agent.id should be defined");
        assert.ok(agent.name, "agent.name should be defined");
        assert.ok(agent.command, "agent.command should be defined");
        assert.ok(Array.isArray(agent.args), "agent.args should be an array");
      }
    });

    test("should include opencode agent", () => {
      const opencode = AGENTS.find((a) => a.id === "opencode");
      assert.ok(opencode, "opencode agent should exist");
      assert.strictEqual(opencode?.command, "opencode");
    });

    test("should include claude-code agent", () => {
      const claude = AGENTS.find((a) => a.id === "claude-code");
      assert.ok(claude, "claude-code agent should exist");
      assert.strictEqual(claude?.command, "npx");
    });

    test("should not include bundled Antigravity agent by default", () => {
      const antigravity = AGENTS.find((a) => a.id === "antigravity");
      assert.strictEqual(antigravity, undefined);
    });

    test("should include bundled Pi agent", () => {
      const pi = AGENTS.find((a) => a.id === "pi");
      assert.ok(pi, "pi agent should exist");
      assert.notStrictEqual(pi?.command, "pi-acp");
      assert.strictEqual(pi?.availabilityCommand, "pi");
      assert.strictEqual(pi?.env?.ELECTRON_RUN_AS_NODE, "1");
      assert.strictEqual(pi?.env?.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE, "full");
      assert.strictEqual(pi?.liveToolOutputProfile, "bundled-pi");
      assert.ok(
        pi?.args.some((arg) =>
          arg.replace(/\\/g, "/").endsWith("pi-acp/index.mjs")
        ),
        "pi args should include bundled adapter entrypoint"
      );
    });
  });

  suite("custom agent overrides", () => {
    let originalCustomAgents: unknown;

    setup(() => {
      originalCustomAgents = vscode.workspace
        .getConfiguration("vscode-acp-chat")
        .get("customAgents");
    });

    teardown(async () => {
      await updateConfig("customAgents", originalCustomAgents);
    });

    test("custom Pi id does not inherit bundled live-output marker", async () => {
      await updateConfig("customAgents", [
        {
          id: "pi",
          name: "Custom Pi",
          command: "custom-pi-acp",
          args: [],
        },
      ]);

      const pi = getAgent("pi");
      assert.strictEqual(pi?.name, "Custom Pi");
      assert.strictEqual(pi?.liveToolOutputProfile, undefined);
    });
  });

  suite("Antigravity built-in", () => {
    let originalEnabled: boolean | undefined;
    let originalCustomAgents: unknown;

    setup(() => {
      const config = vscode.workspace.getConfiguration("vscode-acp-chat");
      originalEnabled = config.get<boolean>("antigravity.enabled");
      originalCustomAgents = config.get("customAgents");
    });

    teardown(async () => {
      await updateConfig("antigravity.enabled", originalEnabled);
      await updateConfig("customAgents", originalCustomAgents);
    });

    test("should include exact bundled launch config when enabled", async () => {
      await updateConfig("antigravity.enabled", true);
      await updateConfig("customAgents", []);

      const antigravity = getBuiltinAgentConfigsForTest().find(
        (a) => a.id === "antigravity"
      );
      assert.ok(antigravity, "antigravity agent should exist when enabled");
      assert.strictEqual(antigravity.name, "Antigravity (Experimental)");
      assert.strictEqual(antigravity.command, process.execPath);
      assert.deepStrictEqual(antigravity.env, { ELECTRON_RUN_AS_NODE: "1" });
      assert.strictEqual(antigravity.availabilityCommand, "agy");
      assert.strictEqual(antigravity.args[0], "--no-warnings");
      assert.ok(
        antigravity.args[1]
          ?.replace(/\\/g, "/")
          .endsWith("antigravity-acp/index.mjs"),
        "antigravity args should include bundled adapter entrypoint"
      );
      assert.ok(
        ![antigravity.command, ...antigravity.args].some((part) =>
          part.toLowerCase().includes("bun")
        ),
        "antigravity launch config should not use Bun"
      );
      assert.ok(
        !antigravity.args.some((arg) =>
          arg.includes("--dangerously-skip-permissions")
        ),
        "antigravity launch config should not include dangerous permission flags"
      );
    });

    test("should allow custom antigravity override when built-in is enabled", async () => {
      const custom = {
        id: "antigravity",
        name: "Custom Antigravity",
        command: "custom-agy-acp",
        args: ["--stdio"],
        availabilityCommand: "custom-agy-acp",
      };
      await updateConfig("antigravity.enabled", true);
      await updateConfig("customAgents", [custom]);

      const agent = getAgent("antigravity");
      assert.ok(agent, "custom antigravity agent should be returned");
      assert.strictEqual(agent.name, custom.name);
      assert.strictEqual(agent.command, custom.command);
      assert.deepStrictEqual(agent.args, custom.args);
    });

    test("should allow custom-only antigravity when built-in is disabled", async () => {
      const custom = {
        id: "antigravity",
        name: "External Antigravity ACP",
        command: "agy-acp",
        args: [],
      };
      await updateConfig("antigravity.enabled", false);
      await updateConfig("customAgents", [custom]);

      const agent = getAgent("antigravity");
      assert.ok(agent, "custom-only antigravity agent should be returned");
      assert.strictEqual(agent.name, custom.name);
      assert.strictEqual(agent.command, custom.command);
    });
  });

  suite("validation", () => {
    test("should accept string availabilityCommand", () => {
      const result = validateAgent({
        id: "custom",
        name: "Custom",
        command: "node",
        args: [],
        availabilityCommand: "pi",
      });

      assert.strictEqual(result.valid, true);
    });

    test("should reject non-string availabilityCommand", () => {
      const result = validateAgent({
        id: "custom",
        name: "Custom",
        command: "node",
        args: [],
        availabilityCommand: 123 as unknown as string,
      });

      assert.strictEqual(result.valid, false);
    });
  });

  suite("getAgent", () => {
    test("should return agent by id", () => {
      const agent = getAgent("opencode");
      assert.ok(agent, "agent should be defined");
      assert.strictEqual(agent?.id, "opencode");
      assert.strictEqual(agent?.name, "OpenCode");
    });

    test("should return undefined for unknown id", () => {
      const agent = getAgent("nonexistent-agent");
      assert.strictEqual(agent, undefined);
    });
  });

  suite("getFirstAvailableAgent", () => {
    test("should return an agent with required properties", () => {
      const agent = getFirstAvailableAgent();
      assert.ok(agent, "agent should be defined");
      assert.ok(agent.id, "agent.id should be defined");
      assert.ok(agent.name, "agent.name should be defined");
      assert.ok(agent.command, "agent.command should be defined");
      assert.ok(Array.isArray(agent.args), "agent.args should be an array");
    });

    test("should return an agent from AGENTS", () => {
      const agent = getFirstAvailableAgent();
      const agentIds = AGENTS.map((a) => a.id);
      assert.ok(
        agentIds.includes(agent.id),
        `agent.id ${agent.id} should be in AGENTS`
      );
    });
  });
});
