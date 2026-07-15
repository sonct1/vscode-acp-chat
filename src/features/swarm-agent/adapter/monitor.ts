import type { AgentContext, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { SwarmWorkerState } from "../types";
import { normalizeSwarmState } from "./state-machine";

export interface SwarmMonitorUpdate {
  workflowId: string;
  stepId?: string;
  roleId?: string;
  state: SwarmWorkerState;
  preview?: string;
  elapsedMs?: number;
  extra?: Record<string, unknown>;
}

export class SwarmMonitor {
  private readonly startTimes = new Map<string, number>();

  constructor(
    private readonly client: AgentContext,
    private readonly sessionId: string,
    private readonly workflowId: string
  ) {}

  async run(state: SwarmWorkerState, preview?: string): Promise<void> {
    await this.toolUpdate({
      toolCallId: `swarm-run-${this.sessionId}`,
      title: "swarm_run",
      kind: "think",
      status: toToolStatus(state),
      rawOutput: {
        kind: "swarm_run",
        workflowId: this.workflowId,
        state,
        preview,
      },
    });
  }

  async step(params: {
    stepId: string;
    roleId: string;
    state: SwarmWorkerState | string;
    preview?: string;
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const state = normalizeSwarmState(params.state);
    const key = `step:${params.stepId}`;
    if (!this.startTimes.has(key)) this.startTimes.set(key, Date.now());
    const startedAt = this.startTimes.get(key) ?? Date.now();

    await this.toolUpdate({
      toolCallId: `swarm-step-${this.sessionId}-${params.stepId}`,
      title: "swarm_step",
      kind: "think",
      status: toToolStatus(state),
      rawOutput: {
        kind: "swarm_step",
        workflowId: this.workflowId,
        stepId: params.stepId,
        roleId: params.roleId,
        state,
        preview: params.preview,
        elapsedMs: Date.now() - startedAt,
        ...params.extra,
      },
    });
  }

  async worker(params: {
    stepId: string;
    roleId: string;
    state: SwarmWorkerState | string;
    preview?: string;
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const state = normalizeSwarmState(params.state);
    await this.toolUpdate({
      toolCallId: `swarm-worker-${this.sessionId}-${params.stepId}`,
      title: "swarm_worker",
      kind: "other",
      status: toToolStatus(state),
      rawOutput: {
        kind: "swarm_worker",
        workflowId: this.workflowId,
        stepId: params.stepId,
        roleId: params.roleId,
        state,
        preview: params.preview,
        ...params.extra,
      },
    });
  }

  async lock(params: {
    stepId: string;
    lockId: string;
    event: "wait" | "acquire" | "release";
  }): Promise<void> {
    await this.toolUpdate({
      toolCallId: `swarm-lock-${this.sessionId}-${params.lockId}`,
      title: "swarm_lock",
      kind: "other",
      status: params.event === "release" ? "completed" : "in_progress",
      rawOutput: {
        kind: "swarm_lock",
        workflowId: this.workflowId,
        stepId: params.stepId,
        lockId: params.lockId,
        event: params.event,
      },
    });
  }

  async evidence(params: {
    stepId?: string;
    state: SwarmWorkerState;
    preview: string;
  }): Promise<void> {
    await this.toolUpdate({
      toolCallId: `swarm-evidence-${this.sessionId}`,
      title: "swarm_evidence",
      kind: "other",
      status: toToolStatus(params.state),
      rawOutput: {
        kind: "swarm_evidence",
        workflowId: this.workflowId,
        stepId: params.stepId,
        state: params.state,
        preview: params.preview,
      },
    });
  }

  private async toolUpdate(params: {
    toolCallId: string;
    title: string;
    kind: ToolKind;
    status: "pending" | "in_progress" | "completed" | "failed";
    rawOutput: Record<string, unknown>;
  }): Promise<void> {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      title: params.title,
      kind: params.kind,
      status: params.status,
      rawOutput: params.rawOutput,
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: summarizeRawOutput(params.rawOutput),
          },
        },
      ],
    };

    await this.client.notify(methods.client.session.update, {
      sessionId: this.sessionId,
      update,
    });
  }
}

export function toToolStatus(
  state: SwarmWorkerState
): "pending" | "in_progress" | "completed" | "failed" {
  switch (state) {
    case "CREATED":
    case "STARTING":
    case "IDLE":
      return "pending";
    case "DONE":
      return "completed";
    case "FAILED":
    case "CANCELLED":
    case "BLOCKED":
      return "failed";
    default:
      return "in_progress";
  }
}

function summarizeRawOutput(raw: Record<string, unknown>): string {
  const parts = [raw.kind, raw.stepId, raw.roleId, raw.state, raw.event, raw.lockId]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" · ");
  const preview = typeof raw.preview === "string" ? raw.preview : "";
  return preview ? `${parts}\n${preview}` : parts;
}
