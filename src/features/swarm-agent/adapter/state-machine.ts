import type { SwarmWorkerState } from "../types";

const FINAL_STATES = new Set<SwarmWorkerState>([
  "DONE",
  "FAILED",
  "CANCELLED",
  "DISPOSED",
]);

const ALLOWED_TRANSITIONS: Record<SwarmWorkerState, SwarmWorkerState[]> = {
  CREATED: ["STARTING", "DISPOSED"],
  STARTING: ["IDLE", "RUNNING", "FAILED", "CANCELLED", "DISPOSED"],
  IDLE: ["RUNNING", "DISPOSED"],
  RUNNING: [
    "AWAITING_PERMISSION",
    "BLOCKED",
    "DONE",
    "FAILED",
    "CANCELLED",
    "DISPOSED",
  ],
  AWAITING_PERMISSION: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED", "DISPOSED"],
  BLOCKED: ["RUNNING", "FAILED", "CANCELLED", "DISPOSED"],
  DONE: ["DISPOSED"],
  FAILED: ["DISPOSED"],
  CANCELLED: ["DISPOSED"],
  DISPOSED: [],
};

export function isFinalSwarmState(state: SwarmWorkerState): boolean {
  return FINAL_STATES.has(state);
}

export function canTransitionSwarmState(
  from: SwarmWorkerState,
  to: SwarmWorkerState
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionSwarmState(
  from: SwarmWorkerState,
  to: SwarmWorkerState
): SwarmWorkerState {
  if (!canTransitionSwarmState(from, to)) {
    throw new Error(`Invalid Swarm state transition: ${from} -> ${to}`);
  }
  return to;
}

export function normalizeSwarmState(raw: unknown): SwarmWorkerState {
  if (typeof raw !== "string") return "RUNNING";

  switch (raw.trim().toLowerCase().replace(/[\s-]+/g, "_")) {
    case "created":
    case "new":
      return "CREATED";
    case "starting":
    case "connecting":
      return "STARTING";
    case "idle":
    case "ready":
      return "IDLE";
    case "running":
    case "in_progress":
    case "working":
      return "RUNNING";
    case "awaiting_permission":
    case "permission":
    case "waiting_permission":
      return "AWAITING_PERMISSION";
    case "blocked":
    case "waiting":
      return "BLOCKED";
    case "done":
    case "complete":
    case "completed":
    case "success":
    case "end_turn":
      return "DONE";
    case "failed":
    case "failure":
    case "error":
      return "FAILED";
    case "cancelled":
    case "canceled":
    case "cancel":
      return "CANCELLED";
    case "disposed":
    case "closed":
      return "DISPOSED";
    default:
      return "RUNNING";
  }
}

export class SwarmStateMachine {
  private currentState: SwarmWorkerState;

  constructor(initialState: SwarmWorkerState = "CREATED") {
    this.currentState = initialState;
  }

  get state(): SwarmWorkerState {
    return this.currentState;
  }

  transition(to: SwarmWorkerState): SwarmWorkerState {
    this.currentState = transitionSwarmState(this.currentState, to);
    return this.currentState;
  }

  normalizeAndTransition(raw: unknown): SwarmWorkerState {
    return this.transition(normalizeSwarmState(raw));
  }
}
