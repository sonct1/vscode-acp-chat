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
  | "awaiting_permission"
  | "cancelling"
  | "error"
  | "closed";

export interface TranscriptEvent {
  seq: number;
  message: MultiSessionRenderMessage;
  createdAt: number;
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
  unreadCount: number;
  pendingPermissionCount: number;
  diffCount: number;
  conflictedDiffCount: number;
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
  isGenerating: boolean;
}

export interface MultiSessionStateMessage {
  type: "feature.multi-session.state";
  enabled: boolean;
  activeLocalSessionId?: string;
  activationRevision: number;
  sessions: MultiSessionListItem[];
  aggregate: {
    running: number;
    awaitingPermission: number;
    unread: number;
  };
  /** Host-authoritative visibility for the transient session manager drawer. */
  managerOpen?: boolean;
}

export interface MultiSessionDeltaMessage {
  type: "feature.multi-session.delta";
  localSessionId: string;
  activationRevision: number;
  event: TranscriptEvent;
}

export type MultiSessionHostMessage =
  | { type: "feature.multi-session.ready" }
  | { type: "feature.multi-session.new" }
  | { type: "feature.multi-session.activate"; localSessionId: string }
  | { type: "feature.multi-session.stop"; localSessionId?: string }
  | { type: "feature.multi-session.close"; localSessionId: string }
  | { type: "feature.multi-session.manage" }
  | { type: "feature.multi-session.hideManager" }
  | { type: "feature.multi-session.resync" }
  | { type: "feature.multi-session.reviewPermission"; localSessionId: string }
  | {
      type: "feature.multi-session.permission.respond";
      localSessionId: string;
      requestId: string;
      outcome:
        { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
    };
