import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentConfig } from "../../acp/agents";
import { getWorkspaceRoot } from "../../utils/workspace";
import {
  createSwarmRuntimeConfig,
  DEFAULT_SWARM_CONFIG_DIRECTORY,
  DEFAULT_SWARM_MAX_WORKERS,
  DEFAULT_SWARM_TEST_LOCK_PATTERNS,
  DEFAULT_SWARM_WORKFLOW,
  writeSwarmRuntimeConfig,
} from "./adapter/config-loader";
import { SWARM_AGENT_ID, type SwarmRuntimeAgentConfig } from "./types";

export function getBundledSwarmAcpEntrypoint(): string {
  return path.join(__dirname, "swarm-acp", "index.mjs");
}

export function isSwarmAgentEnabled(): boolean {
  const config = vscode.workspace.getConfiguration("vscode-acp-chat");
  return config.get<boolean>("swarmAgent.enabled", false);
}

export interface CreateSwarmAgentConfigOptions {
  getAvailableAgents?: () => AgentConfig[];
}

export function createSwarmAgentConfig(
  options: CreateSwarmAgentConfigOptions = {}
): AgentConfig {
  const runtimeConfigPath = getSwarmRuntimeConfigPath(getWorkspaceRoot());

  return {
    id: SWARM_AGENT_ID,
    name: "Swarm (Experimental)",
    command: process.execPath,
    args: [getBundledSwarmAcpEntrypoint()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      VSCODE_ACP_CHAT_SWARM_CONFIG_PATH: runtimeConfigPath,
    },
    liveToolOutputProfile: "bundled-swarm",
    prepare: async () => {
      await materializeSwarmRuntimeConfig({
        runtimeConfigPath,
        agents: options.getAvailableAgents?.() ?? [],
      });
    },
  };
}

export async function materializeSwarmRuntimeConfig(options: {
  runtimeConfigPath?: string;
  agents: AgentConfig[];
  workspaceRoot?: string;
}): Promise<string> {
  const workspaceRoot = options.workspaceRoot ?? getWorkspaceRoot();
  const config = vscode.workspace.getConfiguration("vscode-acp-chat");
  const configDirectorySetting = config.get<string>(
    "swarmAgent.configDirectory",
    DEFAULT_SWARM_CONFIG_DIRECTORY
  );
  const configDirectory = path.isAbsolute(configDirectorySetting)
    ? configDirectorySetting
    : path.join(workspaceRoot, configDirectorySetting);
  const runtimeConfigPath =
    options.runtimeConfigPath ?? getSwarmRuntimeConfigPath(workspaceRoot);

  const runtimeConfig = await createSwarmRuntimeConfig({
    workspaceRoot,
    configDirectory,
    defaultWorkflow: config.get<string>(
      "swarmAgent.defaultWorkflow",
      DEFAULT_SWARM_WORKFLOW
    ),
    maxWorkers: config.get<number>(
      "swarmAgent.maxWorkers",
      DEFAULT_SWARM_MAX_WORKERS
    ),
    requireApprovalBeforeWrites: config.get<boolean>(
      "swarmAgent.requireApprovalBeforeWrites",
      true
    ),
    testLockPatterns: config.get<string[]>(
      "swarmAgent.testLockPatterns",
      DEFAULT_SWARM_TEST_LOCK_PATTERNS
    ),
    agents: options.agents
      .filter((agent) => agent.id !== SWARM_AGENT_ID)
      .map(toRuntimeAgentConfig),
  });

  await writeSwarmRuntimeConfig(runtimeConfigPath, runtimeConfig);
  return runtimeConfigPath;
}

function toRuntimeAgentConfig(agent: AgentConfig): SwarmRuntimeAgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: [...agent.args],
    env: agent.env ? { ...agent.env } : undefined,
    availabilityCommand: agent.availabilityCommand,
  };
}

function getSwarmRuntimeConfigPath(workspaceRoot: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    os.tmpdir(),
    "vscode-acp-chat",
    "swarm-runtime",
    `${hash}.json`
  );
}
