import type { VsCodeApi } from "./types";
import type { MessageRouter } from "./message-router";
import type { StatePersistenceService } from "./state-persistence";

/**
 * Shared context available to every webview component.
 *
 * Components receive this through their constructor instead of depending on
 * individual `VsCodeApi`, `Document`, or scattered utility imports. This
 * makes components easier to test (mock one interface) and keeps import
 * paths stable as the codebase evolves.
 */
export interface WebviewContext {
  readonly vscode: VsCodeApi;
  readonly doc: Document;
  readonly win: Window;
  readonly stateService: StatePersistenceService;
  readonly messageRouter: MessageRouter;

  // Convenience wrappers so components do not need their own utility imports.
  escapeHtml(str: string): string;
  renderMarkdown(content: string): string;
  getFileIconHtml(fileName: string, size?: number): string;
  getFolderIconHtml(
    folderName: string,
    isOpen?: boolean,
    size?: number
  ): string;
  scrollToBottom(force?: boolean): void;
}
