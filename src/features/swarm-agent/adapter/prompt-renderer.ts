import type {
  SwarmRoleConfig,
  SwarmWorkflowConfig,
  SwarmWorkflowStepConfig,
} from "../types";
import type { SwarmEvidenceStore } from "./evidence-store";

export interface RenderStepPromptOptions {
  workflow: SwarmWorkflowConfig;
  step: SwarmWorkflowStepConfig;
  role: SwarmRoleConfig;
  originalPrompt: string;
  evidence: SwarmEvidenceStore;
  variables?: Record<string, string>;
}

export function renderStepPrompt(options: RenderStepPromptOptions): string {
  const dependencyOutputs = options.step.dependsOn.map((dependency) => {
    const output = options.evidence.getStepOutput(dependency);
    if (output === undefined) {
      throw new Error(
        `Missing output for dependency "${dependency}" required by step "${options.step.id}"`
      );
    }
    return `### ${dependency}\n${output.trim() || "(no output)"}`;
  });

  const parts = [
    `# Swarm worker step: ${options.step.id}`,
    `Workflow: ${options.workflow.id}`,
    `Role: ${options.role.displayName ?? options.role.id} (${options.role.id})`,
    "",
    "You are a Swarm worker invoked by an ACP root orchestrator. You are not talking directly to a human. Execute only this configured step. Investigate independently and report evidence, risks, and concrete outputs. Do not assume the root orchestrator's prompt contains the answer.",
    "",
  ];

  if (options.role.prompt?.trim()) {
    parts.push("## Role instructions", applyVariables(options.role.prompt, options.variables));
  }

  parts.push("## Original user task", contentBlocksText(options.originalPrompt));
  parts.push("## Step instructions", applyVariables(options.step.prompt, options.variables));

  if (dependencyOutputs.length > 0) {
    parts.push("## Dependency outputs", dependencyOutputs.join("\n\n"));
  }

  if (options.step.produces.length > 0) {
    parts.push("## Expected outputs", options.step.produces.map((item) => `- ${item}`).join("\n"));
  }

  parts.push(
    "## Response requirements",
    "Return a concise result for this step. Include commands/tests run, files changed or inspected, blockers, and confidence."
  );

  return parts.filter((part) => part.length > 0).join("\n\n");
}

export function applyVariables(
  template: string,
  variables: Record<string, string> = {}
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

function contentBlocksText(text: string): string {
  return text.trim() || "(empty prompt)";
}
