import type { AgentConfig } from "../../acp/agents";

export function createGrokBuildAgentConfig(): AgentConfig {
  return {
    id: "grok-build",
    name: "Grok Build",
    command: "grok",
    args: ["--no-auto-update", "agent", "stdio"],
  };
}
