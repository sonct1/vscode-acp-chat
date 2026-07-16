export interface MultiSessionRenderMessage {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type MultiSessionStatus =
  | "draft"
  | "starting"
  | "loading_history"
  | "idle"
  | "running"
  | "awaiting_input"
  | "awaiting_permission"
  | "cancelling"
  | "error"
  | "closed";

export interface TranscriptEvent {
  seq: number;
  message: MultiSessionRenderMessage;
  createdAt: number;
}

export interface MultiSessionAgentOption {
  id: string;
  name: string;
}

export interface MultiSessionListItem {
  localSessionId: string;
  acpSessionId?: string;
  agentId: string;
  agentName: string;
  title: string;
  status: MultiSessionStatus;
  createdAt: number;
  updatedAt: number;
  pendingPermissionCount: number;
  pendingElicitationCount: number;
  lastError?: string;
}

export interface MultiSessionSnapshot {
  type: "feature.multi-session.snapshot";
  activeLocalSessionId: string;
  activationRevision: number;
  session: MultiSessionListItem;
  transcript: TranscriptEvent[];
  lastSeq: number;
  metadata?: {
    modes?: unknown;
    models?: unknown;
    genericConfigOptions?: unknown[];
    commands?: unknown;
    lastUsageUpdate?: unknown;
  } | null;
  contextUsage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
  } | null;
  diffChanges?: Array<{
    path: string;
    relativePath: string;
    oldText: string | null;
    newText: string;
    status: string;
  }>;
  pendingPermissions?: MultiSessionRenderMessage[];
  pendingElicitations?: import("../acp-elicitation/types").ElicitationFormView[];
  isGenerating: boolean;
  scrollToBottom?: boolean;
}

export interface MultiSessionAggregate {
  open: number;
  running: number;
  awaitingPermission: number;
  awaitingInput: number;
}

export interface MultiSessionChatStateMessage {
  type: "feature.multi-session.chatState";
  enabled: boolean;
  activeLocalSessionId?: string;
  activationRevision: number;
  active?: MultiSessionListItem;
  aggregate: MultiSessionAggregate;
}

export interface MultiSessionStateMessage {
  type: "feature.multi-session.state";
  enabled: boolean;
  activeLocalSessionId?: string;
  activationRevision: number;
  sessions: MultiSessionListItem[];
  aggregate: Omit<MultiSessionAggregate, "open"> & { open?: number };
  agents?: MultiSessionAgentOption[];
  selectedAgentId?: string;
  /** Deprecated. Full session management now lives in a dedicated WebviewPanel. */
  managerOpen?: boolean;
}

export interface MultiSessionManagerStateMessage {
  type: "feature.multi-session.managerState";
  revision: number;
  activeLocalSessionId?: string;
  sessions: MultiSessionListItem[];
  aggregate: MultiSessionAggregate;
  agents: MultiSessionAgentOption[];
  selectedAgentId: string;
}

export interface MultiSessionManagerPatchMessage {
  type: "feature.multi-session.managerPatch";
  revision: number;
  upserts: MultiSessionListItem[];
  removals: string[];
  activeLocalSessionId?: string;
  aggregate: MultiSessionAggregate;
}

export interface MultiSessionDeltaMessage {
  type: "feature.multi-session.delta";
  localSessionId: string;
  activationRevision: number;
  event: TranscriptEvent;
}

export interface MultiSessionFocusInputMessage {
  type: "feature.multi-session.focusInput";
  requestId: string;
  localSessionId: string;
  activationRevision: number;
}

export interface MultiSessionFocusInputCommitMessage {
  type: "feature.multi-session.focusInputCommit";
  requestId: string;
  localSessionId: string;
  activationRevision: number;
}

export interface MultiSessionFocusInputProof {
  documentHasFocus: boolean;
  activeInput: boolean;
  caret: boolean;
}

export interface MultiSessionFocusInputResponseMessage {
  type:
    | "feature.multi-session.focusInputArmed"
    | "feature.multi-session.focusInputAck";
  requestId: string;
  localSessionId: string;
  activationRevision: number;
  proof?: MultiSessionFocusInputProof;
}

export type MultiSessionHostMessage =
  | { type: "feature.multi-session.ready" }
  | MultiSessionFocusInputResponseMessage
  | { type: "feature.multi-session.managerReady" }
  | { type: "feature.multi-session.managerResync" }
  | { type: "feature.multi-session.new"; focusChat?: boolean }
  | {
      type: "feature.multi-session.activate";
      localSessionId: string;
      focusChat?: boolean;
    }
  | { type: "feature.multi-session.stop"; localSessionId?: string }
  | { type: "feature.multi-session.close"; localSessionId: string }
  | { type: "feature.multi-session.retry"; localSessionId: string }
  | { type: "feature.multi-session.manage" }
  | { type: "feature.multi-session.openManagerPanel" }
  | { type: "feature.multi-session.quickSwitch" }
  | { type: "feature.multi-session.hideManager" }
  | { type: "feature.multi-session.resync" }
  | {
      type: "feature.multi-session.reviewPermission";
      localSessionId: string;
      focusChat?: boolean;
    }
  | {
      type: "feature.multi-session.reviewInput";
      localSessionId: string;
      focusChat?: boolean;
    }
  | {
      type: "feature.multi-session.permission.respond";
      localSessionId: string;
      requestId: string;
      outcome:
        { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
    };
