import * as vscode from "vscode";
import {
  getAgentsWithStatus,
  type AgentWithStatus,
} from "../../acp/agents";

export const SELECT_AGENT_COMMAND = "vscode-acp-chat.selectAgent" as const;

export interface AgentSelectionTarget {
  getSelectedAgentId(): string;
  selectAgentAndStartNewChat(agentId: string): Promise<void>;
}

export interface AgentSelectionQuickPickItem extends vscode.QuickPickItem {
  id: string;
}

export function buildAgentSelectionItems(
  agents: AgentWithStatus[],
  selectedAgentId: string
): AgentSelectionQuickPickItem[] {
  return agents
    .filter((agent) => agent.available)
    .map((agent) => ({
      label: agent.id === selectedAgentId ? `$(check) ${agent.name}` : agent.name,
      description: agent.id,
      id: agent.id,
    }));
}

export class AgentSelectionHostController {
  constructor(
    private readonly options: {
      getTarget: () => AgentSelectionTarget | undefined;
      getAgents?: () => AgentWithStatus[];
      showQuickPick?: (
        items: AgentSelectionQuickPickItem[],
        options: vscode.QuickPickOptions
      ) => Thenable<AgentSelectionQuickPickItem | undefined>;
    }
  ) {}

  async selectAgent(): Promise<void> {
    const target = this.options.getTarget();
    if (!target) return;

    const agents = this.options.getAgents?.() ?? getAgentsWithStatus();
    const items = buildAgentSelectionItems(agents, target.getSelectedAgentId());
    const showQuickPick = this.options.showQuickPick ?? vscode.window.showQuickPick;
    const selected = await showQuickPick(items, {
      matchOnDescription: true,
      placeHolder: "Select an ACP agent to start a new session",
      title: "VSCode ACP: Select Agent",
    });

    if (!selected) return;
    await target.selectAgentAndStartNewChat(selected.id);
  }
}

export function registerAgentSelectionHostFeature(options: {
  context: vscode.ExtensionContext;
  getTarget: () => AgentSelectionTarget | undefined;
}): AgentSelectionHostController {
  const controller = new AgentSelectionHostController({
    getTarget: options.getTarget,
  });

  options.context.subscriptions.push(
    vscode.commands.registerCommand(SELECT_AGENT_COMMAND, () =>
      controller.selectAgent()
    )
  );

  return controller;
}
