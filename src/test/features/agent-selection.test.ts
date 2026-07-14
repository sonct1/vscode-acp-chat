 
import * as assert from "assert";
import {
  AgentSelectionHostController,
  buildAgentSelectionItems,
  type AgentSelectionQuickPickItem,
} from "../../features/agent-selection/host";
import type { AgentWithStatus } from "../../acp/agents";

const agents: AgentWithStatus[] = [
  {
    id: "test-agent",
    name: "Test Agent",
    command: "test-agent",
    args: [],
    available: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    available: true,
  },
  {
    id: "missing-agent",
    name: "Missing Agent",
    command: "missing-agent",
    args: [],
    available: false,
  },
];

suite("agent-selection feature", () => {
  test("marks only the currently selected available agent with a flat VS Code check label", () => {
    const items = buildAgentSelectionItems(agents, "opencode");

    const selectedItems = items.filter((item) => item.label.startsWith("$(check) "));
    assert.strictEqual(selectedItems.length, 1);
    assert.strictEqual(selectedItems[0].id, "opencode");
    assert.strictEqual(selectedItems[0].label, "$(check) OpenCode");
    assert.strictEqual(
      items.find((item) => item.id === "test-agent")?.label,
      "Test Agent"
    );
    assert.strictEqual(items.some((item) => item.detail), false);
    assert.strictEqual(items.some((item) => item.picked), false);
  });

  test("filters unavailable agents from the picker", () => {
    const items = buildAgentSelectionItems(agents, "missing-agent");

    assert.deepStrictEqual(
      items.map((item) => item.id),
      ["test-agent", "opencode"]
    );
    assert.strictEqual(items.some((item) => item.id === "missing-agent"), false);
  });

  test("choosing an item starts a new chat for that agent", async () => {
    const selectedIds: string[] = [];
    const controller = new AgentSelectionHostController({
      getTarget: () => ({
        getSelectedAgentId: () => "test-agent",
        selectAgentAndStartNewChat: async (agentId) => {
          selectedIds.push(agentId);
        },
      }),
      getAgents: () => agents,
      showQuickPick: async (items, options) => {
        assert.strictEqual(options.matchOnDescription, true);
        assert.strictEqual(
          options.placeHolder,
          "Select an ACP agent to start a new session"
        );
        return items.find((item) => item.id === "opencode") as
          | AgentSelectionQuickPickItem
          | undefined;
      },
    });

    await controller.selectAgent();

    assert.deepStrictEqual(selectedIds, ["opencode"]);
  });

  test("cancelling the picker leaves the target unchanged", async () => {
    let called = false;
    const controller = new AgentSelectionHostController({
      getTarget: () => ({
        getSelectedAgentId: () => "test-agent",
        selectAgentAndStartNewChat: async () => {
          called = true;
        },
      }),
      getAgents: () => agents,
      showQuickPick: async () => undefined,
    });

    await controller.selectAgent();

    assert.strictEqual(called, false);
  });
});
