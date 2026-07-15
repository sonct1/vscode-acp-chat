import type {
  SwarmRuntimeConfig,
  SwarmWorkflowConfig,
  SwarmWorkflowStepConfig,
  SwarmWorkerState,
} from "../types";
import { getWorkflowExecutionOrder } from "../types";

export interface SwarmStepExecutorResult {
  state: SwarmWorkerState;
  output: string;
  error?: string;
}

export type SwarmStepExecutor = (
  step: SwarmWorkflowStepConfig,
  attempt: number
) => Promise<SwarmStepExecutorResult>;

export interface SwarmWorkflowEngineResult {
  state: SwarmWorkerState;
  completed: Map<string, SwarmStepExecutorResult>;
}

export class SwarmWorkflowEngine {
  constructor(private readonly runtimeConfig: SwarmRuntimeConfig) {}

  async execute(
    workflow: SwarmWorkflowConfig,
    executor: SwarmStepExecutor
  ): Promise<SwarmWorkflowEngineResult> {
    const maxWorkers = Math.max(
      1,
      Math.min(workflow.maxWorkers ?? this.runtimeConfig.maxWorkers, this.runtimeConfig.maxWorkers)
    );
    const completed = new Map<string, SwarmStepExecutorResult>();
    const running = new Set<string>();
    const skipped = new Set<string>();
    let stopped = false;
    let finalState: SwarmWorkerState = "DONE";

    while (completed.size + skipped.size < workflow.steps.length) {
      if (stopped && running.size === 0) break;

      const runnable = workflow.steps.filter(
        (step) =>
          !stopped &&
          !completed.has(step.id) &&
          !running.has(step.id) &&
          !skipped.has(step.id) &&
          step.dependsOn.every((dependency) => completed.has(dependency))
      );

      if (runnable.length === 0 && running.size === 0) {
        const unresolved = workflow.steps
          .filter((step) => !completed.has(step.id) && !skipped.has(step.id))
          .map((step) => step.id);
        if (unresolved.length > 0) {
          finalState = "BLOCKED";
          for (const id of unresolved) skipped.add(id);
        }
        break;
      }

      const batch = runnable.slice(0, Math.max(1, maxWorkers - running.size));
      if (batch.length === 0) {
        await sleep(0);
        continue;
      }

      await Promise.all(
        batch.map(async (step) => {
          running.add(step.id);
          try {
            const result = await this.executeWithPolicy(step, executor);
            completed.set(step.id, result);
            if (["FAILED", "BLOCKED", "CANCELLED"].includes(result.state)) {
              finalState = result.state;
              if (step.onFailure !== "continue") stopped = true;
            }
          } finally {
            running.delete(step.id);
          }
        })
      );
    }

    return { state: finalState, completed };
  }

  getExecutionOrder(workflow: SwarmWorkflowConfig): string[] {
    return getWorkflowExecutionOrder(workflow);
  }

  private async executeWithPolicy(
    step: SwarmWorkflowStepConfig,
    executor: SwarmStepExecutor
  ): Promise<SwarmStepExecutorResult> {
    const maxAttempts = step.onFailure === "retry" ? step.retryLimit + 1 : 1;
    let lastResult: SwarmStepExecutorResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await executor(step, attempt);
        lastResult = result;
        if (result.state !== "FAILED" && result.state !== "BLOCKED") return result;
        if (step.onFailure !== "retry") return normalizeFailureByPolicy(step, result);
      } catch (error) {
        lastResult = {
          state: "FAILED",
          output: "",
          error: error instanceof Error ? error.message : String(error),
        };
        if (step.onFailure !== "retry") return normalizeFailureByPolicy(step, lastResult);
      }
    }

    return normalizeFailureByPolicy(
      step,
      lastResult ?? { state: "FAILED", output: "", error: "unknown failure" }
    );
  }
}

function normalizeFailureByPolicy(
  step: SwarmWorkflowStepConfig,
  result: SwarmStepExecutorResult
): SwarmStepExecutorResult {
  if (step.onFailure === "continue") {
    return { ...result, state: "DONE", error: result.error };
  }
  if (step.onFailure === "askUser") {
    return { ...result, state: "BLOCKED" };
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
