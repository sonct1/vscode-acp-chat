import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { LiveToolOutputProfileId } from "./agents";

export const LIVE_TOOL_TEXT_TAIL_LIMIT = 256 * 1024;
export const LIVE_TOOL_TRUNCATION_MARKER =
  "[... truncated earlier output ...]\n";

export interface LiveToolOutputContext {
  agentId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: ToolCall["content"] | ToolCallUpdate["content"];
  locations?: ToolCall["locations"] | ToolCallUpdate["locations"];
  outputCleared?: boolean;
}

export type LiveToolPresentation =
  | {
      format: "text";
      text: string;
      truncated: boolean;
    }
  | {
      format: "terminal";
      text: string;
      truncated: boolean;
    }
  | {
      format: "subagent";
      text: string;
      truncated: boolean;
      subagent: {
        agent?: string;
        status?: string;
        model?: string;
        elapsedMs?: number;
        outputChars?: number;
        currentTool?: string;
        toolCallCount?: number;
        toolHistory?: Array<{
          name: string;
          summary?: string;
          startMs?: number;
          endMs?: number;
        }>;
      };
    };

export interface LiveToolOutputProfile {
  id: LiveToolOutputProfileId;
  project(context: LiveToolOutputContext): LiveToolPresentation | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function tailTextUtf8(
  text: string,
  limitBytes: number,
  marker = LIVE_TOOL_TRUNCATION_MARKER
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limitBytes) return { text, truncated: false };

  const markerBytes = encoder.encode(marker).byteLength;
  if (markerBytes >= limitBytes) {
    const markerSlice = encoder
      .encode(marker)
      .slice(0, Math.max(0, limitBytes));
    let end = markerSlice.byteLength;
    while (end > 0 && (markerSlice[end - 1] & 0xc0) === 0x80) end--;
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(
        markerSlice.slice(0, end)
      ),
      truncated: true,
    };
  }

  const tailLimit = limitBytes - markerBytes;
  let start = Math.max(0, bytes.byteLength - tailLimit);
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start++;
  const tail = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(start)
  );
  return { text: marker + tail, truncated: true };
}

export function boundedTextPresentation(
  text: string,
  limitBytes = LIVE_TOOL_TEXT_TAIL_LIMIT
): LiveToolPresentation | undefined {
  if (text.length === 0) return undefined;
  const bounded = tailTextUtf8(text, limitBytes);
  return { format: "text", ...bounded };
}

export function boundedTerminalPresentation(
  text: string,
  limitBytes = LIVE_TOOL_TEXT_TAIL_LIMIT
): LiveToolPresentation | undefined {
  if (text.length === 0) return undefined;
  const bounded = tailTextUtf8(text, limitBytes);
  return { format: "terminal", ...bounded };
}

export function extractTextContent(
  content: ToolCall["content"] | ToolCallUpdate["content"] | undefined
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (item.type !== "content") return undefined;
      const nested = "content" in item ? item.content : undefined;
      return nested?.type === "text" ? nested.text : undefined;
    })
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return text.length > 0 ? text : undefined;
}

export function normalizeGenericToolOutput(
  content: ToolCall["content"] | ToolCallUpdate["content"] | undefined,
  rawOutput: unknown
): LiveToolPresentation | undefined {
  const contentText = extractTextContent(content);
  if (contentText !== undefined) return boundedTextPresentation(contentText);

  if (typeof rawOutput === "string") return boundedTextPresentation(rawOutput);

  if (isRecord(rawOutput)) {
    for (const key of ["formatted_output", "output", "text"] as const) {
      const value = rawOutput[key];
      if (typeof value === "string") return boundedTextPresentation(value);
    }
  }

  return undefined;
}

export function projectLiveToolOutput(
  context: LiveToolOutputContext,
  options: {
    profiles?: LiveToolOutputProfile[];
    enableGeneric?: boolean;
  }
): LiveToolPresentation | undefined {
  for (const profile of options.profiles ?? []) {
    const presentation = profile.project(context);
    if (presentation) return presentation;
  }

  return options.enableGeneric
    ? normalizeGenericToolOutput(context.content, context.rawOutput)
    : undefined;
}
