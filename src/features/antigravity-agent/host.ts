import * as path from "path";
import * as vscode from "vscode";
import type { AgentConfig } from "../../acp/agents";

export function getBundledAntigravityAcpEntrypoint(): string {
  return path.join(__dirname, "antigravity-acp", "index.mjs");
}

export function isAntigravityAgentEnabled(): boolean {
  const config = vscode.workspace.getConfiguration("vscode-acp-chat");
  return config.get<boolean>("antigravity.enabled", false);
}

export function createAntigravityAgentConfig(): AgentConfig {
  return {
    id: "antigravity",
    name: "Antigravity (Experimental)",
    command: process.execPath,
    args: ["--no-warnings", getBundledAntigravityAcpEntrypoint()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
    },
    availabilityCommand: "agy",
  };
}
