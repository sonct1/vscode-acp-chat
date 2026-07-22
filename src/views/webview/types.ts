/**
 * Shared type definitions for the webview layer.
 *
 * Every interface / type that is consumed across multiple webview modules
 * (main, tool-render, widget/*, tests) lives here so that import paths
 * stay stable and circular dependencies are avoided.
 */

// ---------------------------------------------------------------------------
// VS Code webview bridge
// ---------------------------------------------------------------------------

/** Proxy object returned by `acquireVsCodeApi()` inside the webview. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
}

// ---------------------------------------------------------------------------
// Tool kinds & summaries
// ---------------------------------------------------------------------------

/**
 * Semantic categories of tool calls that the extension host may stream to
 * the webview.  Used for icon selection, collapse heuristics, and analytics.
 */
export type ToolKind =
  | "read"
  | "edit"
  | "write"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/** Runtime representation of a tool block exposed via `getTools()`. */
export interface Tool {
  id: string;
  name: string;
  input: string | null;
  output: string | null;
  status: "running" | "completed" | "failed";
  kind?: ToolKind;
  element?: HTMLElement;
}

/** A single content item inside a tool call's streamed output. */
export type ToolCallContentItem =
  | { type: "content"; content?: { type: "text"; text?: string } }
  | { type: "diff"; path?: string; oldText?: string; newText?: string }
  | { type: "terminal"; terminalId?: string };

/** Source location associated with a tool call (e.g. file + line). */
export interface ToolCallLocation {
  path: string;
  line?: number;
}

/** Summary payload the host sends for `toolCallStart` / `toolCallComplete`. */
export type LiveToolPresentation =
  | { format: "text"; text: string; truncated: boolean }
  | { format: "terminal"; text: string; truncated: boolean }
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

export interface ToolCallSummary {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status: string;
  revision?: number;
  presentation?: LiveToolPresentation;
  locations?: ToolCallLocation[];
  rawInput?: {
    command?: string;
    description?: string;
    path?: string;
    cwd?: string;
    args?: string[];
    [key: string]: unknown;
  };
  rawOutput?: { output?: string; text?: string } | string;
  content?: ToolCallContentItem[];
  duration?: number;
  terminalOutput?: string;
  terminalSemantics?: boolean;
}

// ---------------------------------------------------------------------------
// Block model (text / thought / tool)
// ---------------------------------------------------------------------------

/** Discriminator for the three kinds of streaming blocks. */
export type BlockType = "text" | "thought" | "tool";

// ---------------------------------------------------------------------------
// Webview persisted state
// ---------------------------------------------------------------------------

/** Shape of the object stored via `vscode.setState()`. */
export interface WebviewState {
  isConnected: boolean;
  inputValue: string;
  diffChanges?: Array<{
    path: string;
    relativePath: string;
    oldText: string | null;
    newText: string;
    status: string;
  }>;
}

// ---------------------------------------------------------------------------
// Commands & plan
// ---------------------------------------------------------------------------

/** A slash-command advertised by the extension host. */
export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

/** Single entry in the agent's execution plan. */
export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

// ---------------------------------------------------------------------------
// @-mention
// ---------------------------------------------------------------------------

/** An @-mention inserted into the input via autocomplete or paste. */
export interface Mention {
  name: string;
  path?: string;
  type?: "file" | "folder" | "selection" | "terminal" | "image";
  content?: string;
  range?: { startLine: number; endLine: number };
  dataUrl?: string; // For images
}

/** User message content that can be restored into the prompt input. */
export interface PromptHistoryEntry {
  html: string;
  text: string;
}

export interface MessageScrollPosition {
  isNearBottom: boolean;
  scrollTop: number;
}

// ---------------------------------------------------------------------------
// Extension → webview message
// ---------------------------------------------------------------------------

/**
 * Union of all message shapes the extension host may post to the webview.
 * The `type` field discriminates the variant.
 */
export interface ExtensionMessage {
  type: string;
  text?: string;
  html?: string;
  state?: string;
  modeId?: string;
  modelId?: string;
  configId?: string;
  value?: string;
  modes?: {
    availableModes: Array<{ id: string; name: string }>;
    currentModeId: string;
  } | null;
  models?: {
    availableModels: Array<{ modelId: string; name: string }>;
    currentModelId: string;
  } | null;
  genericConfigOptions?: Array<{
    id: string;
    name: string;
    category: string | null;
    description?: string | null;
    options: Array<{
      value: string;
      name: string;
      description?: string | null;
    }>;
    currentValue: string;
  }>;
  commands?: AvailableCommand[] | null;
  starredModels?: string[];
  toolCallId?: string;
  agentId?: string;
  agentName?: string;
  name?: string;
  title?: string;
  kind?: ToolKind;
  content?: ToolCallContentItem[];
  rawInput?: {
    command?: string;
    description?: string;
    path?: string;
    cwd?: string;
    args?: string[];
    [key: string]: unknown;
  };
  rawOutput?: { output?: string; text?: string } | string;
  status?: string;
  disposition?: string;
  terminalOutput?: string;
  terminalSemantics?: boolean;
  results?: Array<{
    name: string;
    path: string;
    dir: string;
    type: "file" | "folder";
    fsPath: string;
  }>;
  mention?: Mention;
  plan?: { entries: PlanEntry[] };
  requestId?: string;
  toolCall?: {
    kind?: string;
    title?: string;
    description?: string;
  };
  options?: Array<{
    optionId: string;
    kind: string;
    name: string;
  }>;
  locations?: ToolCallLocation[];
  duration?: number;
  finalized?: boolean;
  historical?: boolean;
  images?: string[];
  mentions?: Mention[];
  changes?: Array<{
    path: string;
    relativePath: string;
    oldText: string | null;
    newText: string;
    status: string;
  }>;
  used?: number | null;
  size?: number | null;
  cost?: { amount: number; currency: string } | null;
  ownerId?: string;
  pendingElicitations?: unknown[];
  errors?: Record<string, string>;
  interactionId?: string;
  action?: string;
  actionLabel?: string;
  payloads?: unknown[];
  aborted?: boolean;
  revision?: number;
  stateRevision?: number;
  presentation?: LiveToolPresentation;
  processing?: boolean;
  steering?: unknown[];
  followUp?: unknown[];
  effectiveSteering?: string;
}

// ---------------------------------------------------------------------------
// Internal webview events (EventBus)
// ---------------------------------------------------------------------------

/**
 * Map of intra-webview event names to their payload types.
 *
 * Extend this interface when adding new events to the {@link EventBus}.
 * The payload type is inferred automatically at every `emit()` / `on()` call
 * site, giving full compile-time safety.
 */
export interface WebviewEventMap {
  /** Fired just before a user message is posted to the extension host. */
  beforeSend: undefined;
  /** Fired after a user message has been posted to the extension host. */
  messageSent: { text: string; images: string[]; mentions: Mention[] };
  /** Fired when the composer draft changes from direct user input. */
  draftChanged: { html: string };
  /** Fired after a Markdown block has been rendered into the DOM. */
  markdownRendered: { root: HTMLElement; kind: "text" | "thought" };
  /** Fired before the active transcript DOM is replaced or replayed. */
  chatSurfaceReplacementStarted: { generation: number };
  /** Fired after transcript replay and scroll restoration finish or abort. */
  chatSurfaceReplacementFinished: {
    generation: number;
    committed: boolean;
  };
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

/** Option item rendered inside a `Dropdown` popover. */
export interface DropdownOption {
  id: string;
  name: string;
  type?: "item" | "header" | "divider";
  searchText?: string;
  isStarred?: boolean;
  canStar?: boolean;
}

// ---------------------------------------------------------------------------
// Webview DOM element handles
// ---------------------------------------------------------------------------

/** DOM handles owned by the message list component. */
export interface MessageListElements {
  containerEl: HTMLElement;
  messagesEl: HTMLElement;
  typingIndicatorEl: HTMLElement;
  welcomeView: HTMLElement;
}

/** DOM handles owned by the session toolbar nested inside the input panel. */
export interface SessionToolbarElements {
  modeDropdown: HTMLElement;
  modelDropdown: HTMLElement;
  configOptionsContainer: HTMLElement;
  contextUsageRing: HTMLDivElement;
}

/** DOM handles owned by the input panel component. */
export interface InputPanelElements {
  inputEl: HTMLElement;
  commandAutocomplete: HTMLElement;
  attachImageBtn: HTMLButtonElement;
  imagePreviewPopover: HTMLElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  toolbar: SessionToolbarElements;
}

/** DOM handles for secondary panels rendered around the main chat flow. */
export interface AuxiliaryPanelElements {
  planContainer: HTMLElement;
  diffSummaryContainer: HTMLElement;
}

/**
 * Top-level webview component handles.
 *
 * The nested component fields are the preferred ownership boundaries.  The
 * flat fields are compatibility aliases while controller responsibilities are
 * migrated out of `main.ts`; new code should prefer the nested fields.
 */
export interface WebviewElements {
  messageList: MessageListElements;
  inputPanel: InputPanelElements;
  sessionToolbar: SessionToolbarElements;
  auxiliaryPanels: AuxiliaryPanelElements;

  messagesContainerEl: HTMLElement;
  messagesEl: HTMLElement;
  inputEl: HTMLElement;
  attachImageBtn: HTMLButtonElement;
  imagePreviewPopover: HTMLElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  modeDropdown: HTMLElement;
  modelDropdown: HTMLElement;
  configOptionsContainer: HTMLElement;
  contextUsageRing: HTMLDivElement;
  welcomeView: HTMLElement;
  commandAutocomplete: HTMLElement;
  planContainer: HTMLElement;
  typingIndicatorEl: HTMLElement;
  diffSummaryContainer: HTMLElement;
}

// ---------------------------------------------------------------------------
// Scroll helpers
// ---------------------------------------------------------------------------

/** Direction of the user's most recent scroll gesture. */
export type UserScrollDirection = "none" | "up" | "down" | "unknown";
