import * as vscode from "vscode";
import type {
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ACPClient, ContextUsageUpdate, SessionMetadata } from "./client";
import type { FileHandler } from "./file-handler";
import { extractMentions } from "../utils/mention-serializer";
import { getPiContextUsageUnavailableMeta } from "./pi-context-usage-meta";
import type { LiveToolOutputProfileId } from "./agents";
import {
  type LiveToolOutputProfile,
  type LiveToolPresentation,
  projectLiveToolOutput,
} from "./tool-output-presentation";
import { bundledPiLiveToolOutputProfile } from "../features/pi-agent/live-tool-output";
import { bundledSwarmLiveToolOutputProfile } from "../features/swarm-agent/live-tool-output";

export interface SessionRenderMessage {
  type: string;
  [key: string]: unknown;
}

type FinalToolCallUpdate = (ToolCall | ToolCallUpdate) & {
  status: "completed" | "failed";
};

type ToolCallMetadataUpdate = Pick<ToolCall | ToolCallUpdate, "toolCallId"> &
  Partial<
    Pick<
      ToolCall | ToolCallUpdate,
      | "rawInput"
      | "rawOutput"
      | "kind"
      | "title"
      | "content"
      | "locations"
      | "status"
    >
  >;

export interface ToolCallRuntimeState {
  pending?: boolean;
  completed?: boolean;
  startTime?: number;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  kind?: string;
  title?: string;
  status?: string;
  content?: ToolCall["content"];
  locations?: ToolCall["locations"];
  baseContent?: Promise<string | undefined>;
  revision: number;
  latestPresentation?: LiveToolPresentation;
  lastProgressEmitAt?: number;
  pendingProgress?: SessionRenderMessage;
  progressTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionOutputState {
  userMessageBuffer: string;
  userMessageImages: string[];
  toolCalls: Map<string, ToolCallRuntimeState>;
  isLoadingHistory: boolean;
}

export interface SessionOutputPipelineOptions {
  client: ACPClient;
  fileHandler: FileHandler;
  emit: (message: SessionRenderMessage) => void;
  state?: SessionOutputState;
  onMetadataChanged?: (metadata: Partial<SessionMetadata> | null) => void;
  onContextUsageChanged?: (usage: ContextUsageUpdate | null) => void;
  onSessionInfoChanged?: (update: Record<string, unknown>) => void;
  onStructuredDiffContent?: (content: unknown) => void | Promise<void>;
  onToolCallComplete?: () => void;
  liveToolOutputProfile?: LiveToolOutputProfileId;
  enableGenericLiveToolOutput?: boolean;
}

function createState(): SessionOutputState {
  return {
    userMessageBuffer: "",
    userMessageImages: [],
    toolCalls: new Map(),
    isLoadingHistory: false,
  };
}

function formatJsonValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Session-scoped ACP notification pipeline shared by legacy and multi-session
 * runtimes. It owns history reconstruction and tool-call presentation state;
 * callers own transport, transcript routing, and UI activation.
 */
export class SessionOutputPipeline implements vscode.Disposable {
  readonly state: SessionOutputState;

  private readonly textDecoder = new TextDecoder();
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly options: SessionOutputPipelineOptions) {
    this.state = options.state ?? createState();
  }

  setLoadingHistory(value: boolean): void {
    this.state.isLoadingHistory = value;
  }

  setLiveToolOutputProfile(profile: LiveToolOutputProfileId | undefined): void {
    this.options.liveToolOutputProfile = profile;
  }

  reset(): void {
    this.state.userMessageBuffer = "";
    this.state.userMessageImages = [];
    for (const state of this.state.toolCalls.values()) {
      this.cancelProgressTimer(state);
    }
    this.state.toolCalls.clear();
    this.options.fileHandler.clearLastFileContents();
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
  }

  dispose(): void {
    this.reset();
  }

  flushUserMessageBuffer(): void {
    if (!this.state.userMessageBuffer) return;

    this.options.emit({ type: "streamEnd", stopReason: "end_turn" });
    const { text, mentions } = extractMentions(this.state.userMessageBuffer);

    if (this.state.userMessageImages.length > 0) {
      let imageIndex = 0;
      for (const mention of mentions) {
        if (mention.type === "image" && !mention.dataUrl) {
          const dataUrl = this.state.userMessageImages[imageIndex];
          if (dataUrl) {
            mention.dataUrl = dataUrl;
            imageIndex += 1;
          }
        }
      }
    }

    this.options.emit({ type: "userMessage", text, mentions });
    this.state.userMessageBuffer = "";
    this.state.userMessageImages = [];
  }

  async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;

    if (
      update.sessionUpdate === "user_message_chunk" &&
      !this.state.isLoadingHistory
    ) {
      return;
    }

    const isContentChunk = [
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
    ].includes(update.sessionUpdate);

    if (update.sessionUpdate !== "user_message_chunk" && isContentChunk) {
      this.flushUserMessageBuffer();
    }

    if (update.sessionUpdate === "user_message_chunk") {
      if (update.content.type === "text") {
        this.state.userMessageBuffer += update.content.text;
      } else if (
        update.content.type === "image" &&
        update.content.data &&
        update.content.mimeType
      ) {
        this.state.userMessageImages.push(
          `data:${update.content.mimeType};base64,${update.content.data}`
        );
      }
      return;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        this.options.emit({ type: "streamChunk", text: update.content.text });
      }
      return;
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content?.type === "text") {
        this.options.emit({ type: "thoughtChunk", text: update.content.text });
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      this.markToolCallPending(update.toolCallId);
      this.rememberToolCallMetadata(update, true);
      this.captureToolCallBaseContent(update);

      if (this.isFinalToolCall(update)) {
        await this.completeToolCall(update);
      } else {
        this.options.emit({
          type: "toolCallStart",
          name: update.title,
          toolCallId: update.toolCallId,
          kind: update.kind,
          rawInput: update.rawInput,
        });
        this.scheduleToolCleanup(update.toolCallId);
      }
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      if (this.isFinalToolCall(update)) {
        if (!this.isToolCallPending(update.toolCallId)) {
          this.markToolCallPending(update.toolCallId);
        }
        this.rememberToolCallMetadata(update);
        await this.completeToolCall(update);
      } else {
        const wasPending = this.isToolCallPending(update.toolCallId);
        this.rememberToolCallMetadata(update);
        this.captureToolCallBaseContent(update);
        const state = this.getToolCallState(update.toolCallId);
        const presentation = this.projectProgress(
          update.toolCallId,
          state,
          this.isExplicitOutputClear(update)
        );
        if (presentation) {
          this.markToolCallPending(update.toolCallId);
          if (!wasPending) this.emitToolCallStart(update.toolCallId, state);
          this.scheduleToolProgress(update.toolCallId, presentation);
        } else if (this.hasToolCallPresentation(update)) {
          this.markToolCallPending(update.toolCallId);
          if (!wasPending) this.emitToolCallStart(update.toolCallId, state);
          this.scheduleToolCleanup(update.toolCallId);
        }
      }
      return;
    }

    if (update.sessionUpdate === "current_mode_update") {
      this.options.emit({ type: "modeUpdate", modeId: update.currentModeId });
      return;
    }

    if (update.sessionUpdate === "available_commands_update") {
      this.options.emit({
        type: "availableCommands",
        commands: update.availableCommands,
      });
      return;
    }

    if (update.sessionUpdate === "plan") {
      this.options.emit({ type: "plan", plan: { entries: update.entries } });
      return;
    }

    if (update.sessionUpdate === "config_option_update") {
      this.options.client.updateSessionMetadataFromConfigOptions(
        update.configOptions
      );
      this.options.onMetadataChanged?.(clientMetadata(this.options.client));
      return;
    }

    if (update.sessionUpdate === "usage_update") {
      const usage = update as Partial<ContextUsageUpdate>;
      if (
        typeof usage.size !== "number" ||
        usage.size <= 0 ||
        typeof usage.used !== "number"
      ) {
        return;
      }
      const cost =
        usage.cost &&
        typeof usage.cost.amount === "number" &&
        typeof usage.cost.currency === "string"
          ? { amount: usage.cost.amount, currency: usage.cost.currency }
          : null;
      const normalized = { used: usage.used, size: usage.size, cost };
      this.options.client.setLastUsageUpdate(normalized);
      this.options.onContextUsageChanged?.(normalized);
      return;
    }

    if (update.sessionUpdate === "session_info_update") {
      if (getPiContextUsageUnavailableMeta(update)) {
        this.options.client.clearLastUsageUpdate();
        this.options.onContextUsageChanged?.(null);
      }
      this.options.onSessionInfoChanged?.(
        update as unknown as Record<string, unknown>
      );
    }
  }

  async finalizePendingToolCalls(
    stopReason: string | undefined
  ): Promise<void> {
    const pendingToolCallIds = Array.from(this.state.toolCalls.entries())
      .filter(([, state]) => state.pending)
      .map(([toolCallId]) => toolCallId);
    const status =
      stopReason === "cancelled" || stopReason === "error"
        ? "failed"
        : "completed";

    for (const toolCallId of pendingToolCallIds) {
      if (!this.isToolCallPending(toolCallId)) continue;
      await this.completeToolCall({ toolCallId, status });
    }
  }

  private getToolCallState(toolCallId: string): ToolCallRuntimeState {
    let state = this.state.toolCalls.get(toolCallId);
    if (!state) {
      state = { revision: 0 };
      this.state.toolCalls.set(toolCallId, state);
    }
    return state;
  }

  markToolCallPendingForPermission(toolCallId: string): void {
    this.markToolCallPending(toolCallId);
    this.scheduleToolCleanup(toolCallId);
  }

  private markToolCallPending(toolCallId: string): ToolCallRuntimeState {
    const state = this.getToolCallState(toolCallId);
    state.completed = false;
    state.pending = true;
    return state;
  }

  private isToolCallPending(toolCallId: string): boolean {
    return this.state.toolCalls.get(toolCallId)?.pending === true;
  }

  private cleanupToolCall(toolCallId: string): void {
    const state = this.state.toolCalls.get(toolCallId);
    this.cancelProgressTimer(state);
    this.state.toolCalls.delete(toolCallId);
    const timer = this.cleanupTimers.get(toolCallId);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(toolCallId);
  }

  private scheduleToolCleanup(toolCallId: string): void {
    const existing = this.cleanupTimers.get(toolCallId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => this.cleanupToolCall(toolCallId),
      10 * 60 * 1000
    );
    timer.unref?.();
    this.cleanupTimers.set(toolCallId, timer);
  }

  private emitToolCallStart(
    toolCallId: string,
    state: ToolCallRuntimeState
  ): void {
    this.options.emit({
      type: "toolCallStart",
      name: state.title || "Tool",
      toolCallId,
      kind: state.kind,
      rawInput: state.rawInput,
    });
  }

  private cancelProgressTimer(state: ToolCallRuntimeState | undefined): void {
    if (state?.progressTimer) {
      clearTimeout(state.progressTimer);
      state.progressTimer = undefined;
    }
    if (state) state.pendingProgress = undefined;
  }

  private getLiveProfiles(): LiveToolOutputProfile[] {
    switch (this.options.liveToolOutputProfile) {
      case "bundled-pi":
        return [bundledPiLiveToolOutputProfile];
      case "bundled-swarm":
        return [bundledSwarmLiveToolOutputProfile];
      default:
        return [];
    }
  }

  private projectProgress(
    toolCallId: string,
    state: ToolCallRuntimeState,
    outputCleared = false
  ): LiveToolPresentation | undefined {
    return projectLiveToolOutput(
      {
        agentId: this.options.client.getAgentId?.() ?? "",
        toolCallId,
        title: state.title,
        kind: state.kind,
        status: state.status,
        rawInput: state.rawInput,
        rawOutput: outputCleared ? undefined : state.rawOutput,
        content: outputCleared ? undefined : state.content,
        locations: state.locations,
        outputCleared,
      },
      {
        profiles: this.getLiveProfiles(),
        enableGeneric: this.options.enableGenericLiveToolOutput === true,
      }
    );
  }

  private makeProgressMessage(
    toolCallId: string,
    state: ToolCallRuntimeState,
    presentation: LiveToolPresentation
  ): SessionRenderMessage {
    return {
      type: "toolCallProgress",
      toolCallId,
      revision: state.revision,
      title: state.title || "Tool",
      name: state.title || "Tool",
      kind: state.kind,
      status: state.status === "pending" ? "pending" : "in_progress",
      rawInput: state.rawInput,
      locations: state.locations,
      presentation,
    };
  }

  private scheduleToolProgress(
    toolCallId: string,
    presentation: LiveToolPresentation
  ): void {
    const state = this.getToolCallState(toolCallId);
    if (state.completed) return;
    this.markToolCallPending(toolCallId);
    this.scheduleToolCleanup(toolCallId);
    state.latestPresentation = presentation;
    const message = this.makeProgressMessage(toolCallId, state, presentation);
    const elapsed = state.lastProgressEmitAt
      ? Date.now() - state.lastProgressEmitAt
      : Number.POSITIVE_INFINITY;
    if (elapsed >= 175 && !state.progressTimer) {
      state.lastProgressEmitAt = Date.now();
      this.options.emit(message);
      return;
    }

    state.pendingProgress = message;
    if (state.progressTimer) return;

    state.progressTimer = setTimeout(
      () => {
        state.progressTimer = undefined;
        const latest = state.pendingProgress;
        state.pendingProgress = undefined;
        if (!latest || state.completed || !this.isToolCallPending(toolCallId)) {
          return;
        }
        state.lastProgressEmitAt = Date.now();
        this.options.emit(latest);
      },
      Math.max(0, 175 - elapsed)
    );
    state.progressTimer.unref?.();
  }

  private isExplicitOutputClear(update: ToolCallUpdate): boolean {
    const hasContent = Object.prototype.hasOwnProperty.call(update, "content");
    const hasRawOutput = Object.prototype.hasOwnProperty.call(
      update,
      "rawOutput"
    );
    const contentCleared =
      hasContent &&
      (update.content === null ||
        update.content === undefined ||
        (Array.isArray(update.content) && update.content.length === 0));
    const rawOutputCleared =
      hasRawOutput &&
      (update.rawOutput === null ||
        update.rawOutput === undefined ||
        update.rawOutput === "");
    const contentDisplayable =
      Array.isArray(update.content) && update.content.length > 0;
    const rawOutputDisplayable =
      typeof update.rawOutput === "string"
        ? update.rawOutput.length > 0
        : update.rawOutput !== null && update.rawOutput !== undefined;
    return (
      (contentCleared && !rawOutputDisplayable) ||
      (rawOutputCleared && !contentDisplayable)
    );
  }

  private isFinalToolCall(
    update: ToolCall | ToolCallUpdate
  ): update is FinalToolCallUpdate {
    return update.status === "completed" || update.status === "failed";
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private extractOutputText(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value);
    return text.length > 0 ? text : undefined;
  }

  private extractRawOutputText(rawOutput: unknown): string | undefined {
    const rawOutputRecord = this.asRecord(rawOutput);
    if (!rawOutputRecord) return this.extractOutputText(rawOutput);

    const knownOutput =
      this.extractOutputText(rawOutputRecord.formatted_output) ||
      this.extractOutputText(rawOutputRecord.output) ||
      this.extractOutputText(rawOutputRecord.text);
    if (knownOutput) return knownOutput;

    const keys = Object.keys(rawOutputRecord);
    return keys.length > 0
      ? keys
          .map((key) => `${key}: ${formatJsonValue(rawOutputRecord[key])}`)
          .join("\n")
      : undefined;
  }

  private hasToolCallPresentation(update: ToolCallUpdate): boolean {
    return (
      update.kind !== undefined ||
      update.title !== undefined ||
      update.content !== undefined ||
      update.locations !== undefined ||
      update.rawInput !== undefined
    );
  }

  private rememberToolCallMetadata(
    update: ToolCallMetadataUpdate,
    resetStartTime = false
  ): void {
    const state = this.getToolCallState(update.toolCallId);
    const rawInput = this.asRecord(update.rawInput);
    if (Object.prototype.hasOwnProperty.call(update, "rawInput")) {
      state.rawInput = rawInput;
    }
    if (Object.prototype.hasOwnProperty.call(update, "rawOutput")) {
      state.rawOutput = update.rawOutput;
    }
    if (Object.prototype.hasOwnProperty.call(update, "kind")) {
      state.kind = typeof update.kind === "string" ? update.kind : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(update, "title")) {
      state.title = typeof update.title === "string" ? update.title : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(update, "content")) {
      state.content = Array.isArray(update.content)
        ? update.content
        : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(update, "locations")) {
      state.locations = Array.isArray(update.locations)
        ? update.locations
        : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(update, "status")) {
      state.status =
        typeof update.status === "string" ? update.status : undefined;
    }
    if (resetStartTime || state.startTime === undefined) {
      state.startTime = Date.now();
    }
    state.revision += 1;
  }

  private captureToolCallBaseContent(
    update: Pick<
      ToolCall | ToolCallUpdate,
      "toolCallId" | "rawInput" | "kind" | "title"
    >
  ): void {
    if (this.state.isLoadingHistory) return;
    const state = this.getToolCallState(update.toolCallId);
    if (state.baseContent) return;
    const rawInput = this.asRecord(update.rawInput) || state.rawInput;
    if (!this.extractPath(rawInput)) return;
    state.baseContent = this.captureBaseContent(
      update.kind || state.kind,
      update.title || state.title,
      rawInput
    );
  }

  private async completeToolCall(update: FinalToolCallUpdate): Promise<void> {
    const state = this.state.toolCalls.get(update.toolCallId);
    if (!state?.pending || state.completed) return;

    state.completed = true;
    state.revision += 1;
    this.cancelProgressTimer(state);
    let content = update.content ?? state.content;
    const rawOutput =
      update.rawOutput !== undefined ? update.rawOutput : state.rawOutput;
    const locations = update.locations ?? state.locations;
    let terminalOutput = this.extractRawOutputText(rawOutput);

    if (!terminalOutput && content?.length) {
      const terminalContent = content.find(
        (item) => item.type === "terminal" && "terminalId" in item
      );
      if (terminalContent && "terminalId" in terminalContent) {
        terminalOutput = `[Terminal: ${terminalContent.terminalId}]`;
      }
    }

    const rawInput = this.asRecord(update.rawInput) || state.rawInput;
    const path = this.extractPath(rawInput);
    const kind = update.kind || state.kind;
    const title = update.title || state.title;
    const terminalSemantics =
      this.projectProgress(update.toolCallId, state)?.format === "terminal";
    const hasDisplayableFinalContent =
      Array.isArray(update.content) && update.content.length > 0;
    const hasDisplayableFinalRawOutput =
      this.extractRawOutputText(update.rawOutput) !== undefined;
    const fallbackPresentation =
      hasDisplayableFinalContent || hasDisplayableFinalRawOutput
        ? undefined
        : state.latestPresentation;

    if (
      path &&
      this.isFileMutation(kind, title) &&
      !this.state.isLoadingHistory
    ) {
      let oldText: string | undefined;
      const captured = this.options.fileHandler.getLastFileContent(path);
      if (captured !== undefined) {
        oldText = captured ?? undefined;
      } else {
        const baseContent = state.baseContent;
        oldText = baseContent ? await baseContent : undefined;
        if (!this.isToolCallPending(update.toolCallId)) return;
        if (oldText === undefined && !baseContent) {
          oldText = await this.captureBaseContent(kind, title, rawInput);
          if (!this.isToolCallPending(update.toolCallId)) return;
        }
      }

      let newText = this.extractNewText(rawInput);
      let editReconstructed = false;
      if (
        rawInput?.old_string !== undefined &&
        rawInput?.new_string !== undefined &&
        oldText !== undefined
      ) {
        const oldString = String(rawInput.old_string);
        const newString = String(rawInput.new_string);
        if (oldText.includes(oldString)) {
          newText = oldText.split(oldString).join(newString);
          editReconstructed = true;
        } else {
          try {
            const currentBytes = await vscode.workspace.fs.readFile(
              vscode.Uri.file(path)
            );
            newText = this.textDecoder.decode(currentBytes);
            editReconstructed = newText !== oldText;
          } catch {
            editReconstructed = false;
          }
        }
      }

      const hasEditFields =
        rawInput?.old_string !== undefined &&
        rawInput?.new_string !== undefined;
      if (
        (!hasEditFields || editReconstructed) &&
        newText !== undefined &&
        !content?.some((item) => item.type === "diff")
      ) {
        content = content ? [...content] : [];
        content.push({
          type: "diff",
          path,
          oldText,
          newText: String(newText),
        });
      }
    }

    if (update.status === "completed" && !this.state.isLoadingHistory) {
      await this.options.onStructuredDiffContent?.(content);
    }
    if (!this.isToolCallPending(update.toolCallId)) return;

    this.options.emit({
      type: "toolCallComplete",
      toolCallId: update.toolCallId,
      title,
      kind,
      content,
      rawInput,
      rawOutput,
      status: update.status,
      terminalOutput,
      terminalSemantics,
      presentation: fallbackPresentation,
      locations,
      duration: state.startTime ? Date.now() - state.startTime : undefined,
      revision: state.revision,
    });
    this.options.onToolCallComplete?.();
    this.cleanupToolCall(update.toolCallId);
  }

  private extractPath(
    rawInput: Record<string, unknown> | undefined
  ): string | undefined {
    return (
      (rawInput?.path as string) ||
      (rawInput?.file as string) ||
      (rawInput?.filePath as string) ||
      (rawInput?.file_path as string) ||
      (rawInput?.filename as string) ||
      (rawInput?.uri as string) ||
      (rawInput?.filepath as string) ||
      (rawInput?.file_name as string) ||
      (rawInput?.target as string) ||
      (rawInput?.target_file as string) ||
      (rawInput?.destination as string) ||
      (rawInput?.destination_path as string) ||
      (rawInput?.source as string) ||
      (rawInput?.source_path as string)
    );
  }

  private extractNewText(
    rawInput: Record<string, unknown> | undefined
  ): string | undefined {
    const value =
      rawInput?.content ??
      rawInput?.text ??
      rawInput?.newContent ??
      rawInput?.newText ??
      rawInput?.new_string ??
      rawInput?.replacement ??
      rawInput?.data ??
      rawInput?.text_content ??
      rawInput?.modified_content;
    return value === undefined ? undefined : String(value);
  }

  private isFileMutation(
    kind: string | undefined,
    title: string | undefined
  ): boolean {
    return (
      kind === "write" ||
      kind === "edit" ||
      title?.toLowerCase().includes("write") === true ||
      title?.toLowerCase().includes("edit") === true
    );
  }

  private async captureBaseContent(
    kind: string | undefined,
    title: string | undefined,
    rawInput: Record<string, unknown> | undefined
  ): Promise<string | undefined> {
    const path = this.extractPath(rawInput);
    if (!path || !this.isFileMutation(kind, title)) return undefined;

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return this.textDecoder.decode(bytes);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return undefined;
      }
      console.error(
        `[SessionOutputPipeline] Failed to capture base content for ${path}:`,
        error
      );
      return undefined;
    }
  }
}

export function clientMetadata(
  client: ACPClient
): Partial<SessionMetadata> | null {
  const metadata = client.getSessionMetadata();
  if (!metadata) return null;
  return {
    modes: metadata.modes,
    models: metadata.models,
    genericConfigOptions: metadata.genericConfigOptions,
    commands: metadata.commands,
    lastUsageUpdate: metadata.lastUsageUpdate ?? null,
  };
}
