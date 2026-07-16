import { RequestError } from "@agentclientprotocol/sdk";
import type { SwarmRuntimeConfig } from "../types";

export type SwarmRootRouteDecision =
  | { version: 1; action: "direct" }
  | { version: 1; action: "workflow"; workflowId: string };

const MAX_ROUTE_BYTES = 8 * 1024;
const objectConstructor = Object as ObjectConstructor & { hasOwn?: (object: object, key: PropertyKey) => boolean };
const hasOwn = (object: object, key: PropertyKey): boolean =>
  objectConstructor.hasOwn?.(object, key) ?? Object.prototype.hasOwnProperty.call(object, key);

export function parseSwarmRootRouteDecision(
  text: string,
  config: Pick<SwarmRuntimeConfig, "workflows">
): SwarmRootRouteDecision {
  if (Buffer.byteLength(text, "utf8") > MAX_ROUTE_BYTES) {
    throw routeError("Root route decision exceeds 8KiB");
  }

  const jsonText = extractRouteJson(text);
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw routeError(error instanceof Error ? error.message : String(error));
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError("Root route decision must be a JSON object");
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const version = object.version;
  const action = object.action;

  if (version !== 1) throw routeError("Root route decision version must be 1");
  if (action === "direct") {
    if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "version") {
      throw routeError("Direct route decision must contain only version and action");
    }
    return { version: 1, action: "direct" };
  }

  if (action === "workflow") {
    if (
      keys.length !== 3 ||
      keys[0] !== "action" ||
      keys[1] !== "version" ||
      keys[2] !== "workflowId"
    ) {
      throw routeError(
        "Workflow route decision must contain only version, action, and workflowId"
      );
    }
    const workflowId = object.workflowId;
    if (typeof workflowId !== "string" || workflowId.trim() !== workflowId || workflowId.length === 0) {
      throw routeError("Workflow route decision requires a non-empty workflowId");
    }
    if (!hasOwn(config.workflows, workflowId)) {
      throw routeError(`Unknown workflow selected by Root: ${workflowId}`);
    }
    return { version: 1, action: "workflow", workflowId };
  }

  throw routeError("Root route decision action must be direct or workflow");
}

function extractRouteJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw routeError("Root route decision is empty");
  if (trimmed.startsWith("```")) {
    const match = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!match) throw routeError("Root route decision must be bare JSON or one complete JSON fence");
    const inner = match[1].trim();
    if (inner.includes("```")) throw routeError("Root route decision contains multiple fences");
    return inner;
  }
  if (trimmed.includes("```")) {
    throw routeError("Root route decision must be bare JSON or one complete JSON fence");
  }
  return trimmed;
}

function routeError(message: string): RequestError {
  return RequestError.invalidParams(undefined, `Invalid Swarm Root route decision: ${message}`);
}
