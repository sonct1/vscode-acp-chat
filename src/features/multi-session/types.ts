import type { WebviewState } from "../../views/webview/types";

export * from "./contracts";

export const MULTI_SESSION_PREFIX = "feature.multi-session.";

export interface MultiSessionDraftState {
  activeLocalSessionId?: string;
  drafts?: Record<string, string>;
  scrollTop?: Record<string, number>;
}

export type MultiSessionWebviewState = WebviewState & {
  multiSession?: MultiSessionDraftState;
};
