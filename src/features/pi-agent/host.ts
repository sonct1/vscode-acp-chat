import * as path from "path";
import * as vscode from "vscode";
import type { AgentConfig } from "../../acp/agents";
import { parsePiHistoryLoadMode } from "../../acp/pi-history-load-mode";

export function getBundledPiAcpEntrypoint(): string {
  return path.join(__dirname, "pi-acp", "index.mjs");
}

export function createPiAgentConfig(): AgentConfig {
  const config = vscode.workspace.getConfiguration("vscode-acp-chat");
  const historyLoadMode = parsePiHistoryLoadMode(
    config.get("pi.historyLoadMode")
  );

  return {
    id: "pi",
    name: "Pi",
    command: process.execPath,
    args: [getBundledPiAcpEntrypoint()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE: historyLoadMode,
    },
    availabilityCommand: "pi",
    liveToolOutputProfile: "bundled-pi",
  };
}
