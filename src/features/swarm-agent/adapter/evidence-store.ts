import type { SwarmWorkerState } from "../types";

export interface SwarmEvidenceStep {
  stepId: string;
  roleId: string;
  state: SwarmWorkerState;
  output: string;
  attempts: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface SwarmPolicyViolation {
  stepId: string;
  roleId: string;
  capability: string;
  message: string;
}

export interface SwarmLockEvidence {
  stepId: string;
  lockId: string;
  event: "wait" | "acquire" | "release";
  timestamp: number;
}

export class SwarmEvidenceStore {
  private readonly steps = new Map<string, SwarmEvidenceStep>();
  private readonly violations: SwarmPolicyViolation[] = [];
  private readonly lockEvents: SwarmLockEvidence[] = [];

  startStep(stepId: string, roleId: string, attempt: number): void {
    const previous = this.steps.get(stepId);
    this.steps.set(stepId, {
      stepId,
      roleId,
      state: "RUNNING",
      output: previous?.output ?? "",
      attempts: attempt,
      startedAt: previous?.startedAt ?? Date.now(),
    });
  }

  finishStep(params: {
    stepId: string;
    roleId: string;
    state: SwarmWorkerState;
    output?: string;
    error?: string;
  }): void {
    const existing = this.steps.get(params.stepId);
    this.steps.set(params.stepId, {
      stepId: params.stepId,
      roleId: params.roleId,
      state: params.state,
      output: params.output ?? existing?.output ?? "",
      attempts: existing?.attempts ?? 1,
      startedAt: existing?.startedAt ?? Date.now(),
      endedAt: Date.now(),
      error: params.error,
    });
  }

  appendStepOutput(stepId: string, text: string): void {
    const existing = this.steps.get(stepId);
    if (!existing) return;
    existing.output += text;
  }

  addViolation(violation: SwarmPolicyViolation): void {
    this.violations.push(violation);
  }

  addLockEvent(event: SwarmLockEvidence): void {
    this.lockEvents.push(event);
  }

  getStepOutput(stepId: string): string | undefined {
    return this.steps.get(stepId)?.output;
  }

  getSteps(): SwarmEvidenceStep[] {
    return [...this.steps.values()];
  }

  getViolations(): SwarmPolicyViolation[] {
    return [...this.violations];
  }

  getLockEvents(): SwarmLockEvidence[] {
    return [...this.lockEvents];
  }

  summarize(status: SwarmWorkerState): string {
    const lines: string[] = [`Swarm workflow status: ${status}`];
    const steps = this.getSteps();

    if (steps.length > 0) {
      lines.push("", "Steps:");
      for (const step of steps) {
        const elapsed = step.endedAt
          ? `${Math.max(0, step.endedAt - step.startedAt)}ms`
          : "running";
        const suffix = step.error ? ` — ${step.error}` : "";
        lines.push(
          `- ${step.stepId} (${step.roleId}): ${step.state}, attempts=${step.attempts}, elapsed=${elapsed}${suffix}`
        );
        const preview = trimPreview(step.output, 1200);
        if (preview) lines.push(indent(preview));
      }
    }

    if (this.violations.length > 0) {
      lines.push("", "Capability denials:");
      for (const violation of this.violations) {
        lines.push(
          `- ${violation.stepId} (${violation.roleId}) ${violation.capability}: ${violation.message}`
        );
      }
    }

    if (this.lockEvents.length > 0) {
      lines.push("", "Lock events:");
      for (const event of this.lockEvents.slice(-20)) {
        lines.push(`- ${event.stepId}: ${event.event} ${event.lockId}`);
      }
    }

    return lines.join("\n");
  }
}

function trimPreview(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
