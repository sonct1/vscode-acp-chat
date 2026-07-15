import type { LiveToolOutputProfile } from "../../acp/tool-output-presentation";
import {
  boundedTextPresentation,
  isRecord,
  normalizeGenericToolOutput,
  tailTextUtf8,
} from "../../acp/tool-output-presentation";

const SWARM_PREVIEW_LIMIT = 32 * 1024;
const SWARM_TOOLS = new Set([
  "swarm_run",
  "swarm_step",
  "swarm_worker",
  "swarm_lock",
  "swarm_evidence",
]);

export const bundledSwarmLiveToolOutputProfile: LiveToolOutputProfile = {
  id: "bundled-swarm",
  project(context) {
    const title = context.title?.toLowerCase() ?? "";
    if (!SWARM_TOOLS.has(title)) return undefined;
    if (context.outputCleared) return { format: "text", text: "", truncated: false };

    const payload = isRecord(context.rawOutput) ? context.rawOutput : undefined;
    if (!payload) {
      return normalizeGenericToolOutput(context.content, context.rawOutput);
    }

    const text = formatSwarmPayload(title, payload);
    if (!text) return normalizeGenericToolOutput(context.content, context.rawOutput);
    const bounded = tailTextUtf8(text, SWARM_PREVIEW_LIMIT);
    return { format: "subagent", ...bounded, subagent: subagentMeta(payload) };
  },
};

function formatSwarmPayload(title: string, payload: Record<string, unknown>): string {
  const header = [
    stringField(payload, "workflowId"),
    stringField(payload, "stepId"),
    stringField(payload, "roleId"),
    stringField(payload, "state"),
  ]
    .filter(Boolean)
    .join(" · ");

  if (title === "swarm_lock") {
    return [
      "Swarm lock",
      stringField(payload, "event"),
      stringField(payload, "lockId"),
      stringField(payload, "stepId"),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const preview = stringField(payload, "preview");
  return [labelFor(title), header, preview].filter(Boolean).join("\n");
}

function labelFor(title: string): string {
  switch (title) {
    case "swarm_run":
      return "Swarm run";
    case "swarm_step":
      return "Swarm step";
    case "swarm_worker":
      return "Swarm worker";
    case "swarm_evidence":
      return "Swarm evidence";
    default:
      return title;
  }
}

function subagentMeta(payload: Record<string, unknown>) {
  return {
    agent: stringField(payload, "roleId") ?? stringField(payload, "workflowId"),
    status: stringField(payload, "state") ?? stringField(payload, "event"),
    elapsedMs: numberField(payload, "elapsedMs"),
    outputChars: stringField(payload, "preview")?.length,
    currentTool: stringField(payload, "kind"),
  };
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? escapeControl(value) : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function bundledSwarmTextPresentation(text: string) {
  return boundedTextPresentation(text, SWARM_PREVIEW_LIMIT);
}
