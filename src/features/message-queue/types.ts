import type { Mention } from "../../utils/mention-serializer";

export type QueueIntent = "steer" | "followUp";
export type QueueOwnership = "host" | "native";

export interface ComposerPayload {
  text: string;
  images: string[];
  mentions: Mention[];
  composerHtml: string;
  currentDraft?: string;
}

export interface QueuedComposerMessage {
  id: string;
  intent: QueueIntent;
  payload: ComposerPayload;
  createdAt: number;
}

export interface MessageQueueSnapshot {
  type: "feature.message-queue.state";
  sessionId?: string;
  revision: number;
  ownership: QueueOwnership;
  processing: boolean;
  steering: QueuedComposerMessage[];
  followUp: QueuedComposerMessage[];
  effectiveSteering: "native" | "after-current-acp-turn";
}

export type QueueSubmitDisposition = "dispatched" | "queued" | "rejected";

export interface QueueSubmitResultMessage {
  type: "feature.message-queue.submitResult";
  requestId: string;
  sessionId?: string;
  disposition: QueueSubmitDisposition;
  acceptedHtml?: string;
  reason?: string;
}

export interface QueueRestoreResultMessage {
  type: "feature.message-queue.restoreResult";
  requestId: string;
  sessionId?: string;
  payloads: ComposerPayload[];
  aborted: boolean;
}

export type MessageQueueHostMessage =
  | {
      type: "feature.message-queue.submit";
      requestId: string;
      sessionId?: string;
      activationRevision?: number;
      intent: QueueIntent;
      payload: ComposerPayload;
      currentDraft?: ComposerPayload;
    }
  | {
      type: "feature.message-queue.abortAndRestore";
      requestId: string;
      sessionId?: string;
      activationRevision?: number;
      currentDraft?: ComposerPayload;
    }
  | {
      type: "feature.message-queue.restoreQueued";
      requestId: string;
      sessionId?: string;
      activationRevision?: number;
      currentDraft?: ComposerPayload;
    };
