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
export interface ToolCallSummary {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status: string;
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
}

// ---------------------------------------------------------------------------
// Block model (text / thought / tool)
// ---------------------------------------------------------------------------

/** Discriminator for the three kinds of streaming blocks. */
export type BlockType = "text" | "thought" | "tool";

/**
 * Internal bookkeeping object for a block that is being streamed into the
 * current assistant message.  Tracks the DOM element, accumulated content,
 * and optional tool metadata.
 */
export interface Block {
  type: BlockType;
  element: HTMLElement;
  contentEl: HTMLElement;
  content: string;
  key: string;
  toolId?: string;
  kind?: ToolKind;
  title?: string;
  status?: string;
}

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
  terminalOutput?: string;
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
  action?: string;
  actionLabel?: string;
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

/** Option item rendered inside a `Dropdown` popover. */
export interface DropdownOption {
  id: string;
  name: string;
  type?: "item" | "header" | "divider";
  isStarred?: boolean;
  canStar?: boolean;
}

// ---------------------------------------------------------------------------
// Webview DOM element handles
// ---------------------------------------------------------------------------

/** Cached references to every DOM element the controller interacts with. */
export interface WebviewElements {
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
