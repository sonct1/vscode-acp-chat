import * as path from "path";
import type { AgentConfig } from "../../acp/agents";

export function getBundledPiAcpEntrypoint(): string {
  return path.join(__dirname, "pi-acp", "index.mjs");
}

export function createPiAgentConfig(): AgentConfig {
  return {
    id: "pi",
    name: "Pi",
    command: process.execPath,
    args: [getBundledPiAcpEntrypoint()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
    },
    availabilityCommand: "pi",
  };
}
