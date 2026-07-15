import type {
  LiveToolOutputContext,
  LiveToolOutputProfile,
} from "../../acp/tool-output-presentation";
import {
  boundedTerminalPresentation,
  extractTextContent,
  isRecord,
  normalizeGenericToolOutput,
  tailTextUtf8,
} from "../../acp/tool-output-presentation";

const SUBAGENT_PREVIEW_LIMIT = 32 * 1024;
const MAX_TOOL_HISTORY = 30;
const SUMMARY_LIMIT = 120;
const DELEGATE_TOOLS = new Set([
  "delegate_explore",
  "delegate_oracle",
  "delegate_librarian",
  "delegate_general",
  "delegate_reviewer",
]);

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function finiteNumberField(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function truncateSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > SUMMARY_LIMIT
    ? `${value.slice(0, SUMMARY_LIMIT - 1)}…`
    : value;
}

function extractDetails(
  rawOutput: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(rawOutput)) return undefined;
  const details = rawOutput.details;
  return isRecord(details) ? details : undefined;
}

function joinStdoutStderr(record: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const stdout = stringField(record, "stdout");
  const stderr = stringField(record, "stderr");
  if (stdout) parts.push(stdout);
  if (stderr)
    parts.push(stdout ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`);
  return parts.length > 0 ? parts.join("") : undefined;
}

function bashText(context: LiveToolOutputContext): string | undefined {
  if (context.outputCleared) return "";
  const contentText = extractTextContent(context.content);
  if (contentText !== undefined) return contentText;
  if (typeof context.rawOutput === "string") return context.rawOutput;

  if (isRecord(context.rawOutput)) {
    const details = extractDetails(context.rawOutput);
    if (details) {
      const stdio = joinStdoutStderr(details);
      if (stdio) return stdio;
      const detailOutput = stringField(details, "output");
      if (detailOutput) return detailOutput;
    }

    const stdio = joinStdoutStderr(context.rawOutput);
    if (stdio) return stdio;
    for (const key of ["output", "text"] as const) {
      const value = stringField(context.rawOutput, key);
      if (value) return value;
    }
  }

  return undefined;
}

function normalizeToolHistory(details: Record<string, unknown>) {
  const history = details.toolHistory;
  if (!Array.isArray(history)) return undefined;
  const normalized = history
    .filter(isRecord)
    .map((entry) => {
      const name = stringField(entry, "name");
      if (!name) return undefined;
      return {
        name,
        summary: truncateSummary(entry.summary),
        startMs: finiteNumberField(entry, "startMs"),
        endMs: finiteNumberField(entry, "endMs"),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .slice(-MAX_TOOL_HISTORY);
  return normalized.length > 0 ? normalized : undefined;
}

export const bundledPiLiveToolOutputProfile: LiveToolOutputProfile = {
  id: "bundled-pi",
  project(context) {
    const title = context.title?.toLowerCase() ?? "";
    if (title === "bash") {
      if (context.outputCleared) {
        return { format: "terminal", text: "", truncated: false };
      }
      const text = bashText(context);
      return text === undefined ? undefined : boundedTerminalPresentation(text);
    }

    if (!DELEGATE_TOOLS.has(title)) return undefined;
    if (context.outputCleared) {
      return { format: "subagent", text: "", truncated: false, subagent: {} };
    }

    const details = extractDetails(context.rawOutput);
    if (details) {
      const preview = stringField(details, "outputPreview");
      const fallback = extractTextContent(context.content);
      const genericFallback = normalizeGenericToolOutput(
        context.content,
        context.rawOutput
      );
      const rawText = preview ?? fallback ?? genericFallback?.text;
      if (rawText !== undefined && rawText.length > 0) {
        const bounded = tailTextUtf8(rawText, SUBAGENT_PREVIEW_LIMIT);
        return {
          format: "subagent",
          text: bounded.text,
          truncated: bounded.truncated,
          subagent: {
            agent: stringField(details, "agent"),
            status: stringField(details, "status"),
            model: stringField(details, "model"),
            elapsedMs: finiteNumberField(details, "elapsedMs"),
            outputChars: finiteNumberField(details, "outputChars"),
            currentTool: stringField(details, "currentTool"),
            toolCallCount: finiteNumberField(details, "toolCallCount"),
            toolHistory: normalizeToolHistory(details),
          },
        };
      }
    }

    const fallback = normalizeGenericToolOutput(
      context.content,
      context.rawOutput
    );
    return fallback?.format === "text"
      ? { ...fallback, format: "subagent", subagent: {} }
      : fallback;
  },
};
