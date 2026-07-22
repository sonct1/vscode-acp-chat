import { TooltipManager } from "./widget/tooltip";
import { showConfirmDialog } from "./widget/confirm-dialog";
import { AuxiliaryPanelsComponent } from "./component/auxiliary-panels";
import { InputPanelComponent } from "./component/input-panel";
import { MessageListComponent } from "./component/message-list";
import { SessionToolbarComponent } from "./component/session-toolbar";
import { ChipRendererComponent } from "./component/chip-renderer";
import { WebviewRootComponent } from "./component/webview-root";
import { MessageRouter, type MessageHandler } from "./message-router";
import { StatePersistenceService } from "./state-persistence";
import { EventBus } from "./event-bus";
import { AsyncSerialQueue } from "../../utils/async-queue";
import {
  registerWebviewFeatures,
  type RegisteredWebviewFeatures,
} from "../../features/register-webview";
import type { WebviewContext } from "./context";
import type {
  VsCodeApi,
  ExtensionMessage,
  WebviewEventMap,
  WebviewState,
} from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * Thin orchestration layer that wires all webview components together.
 *
 * Owns the {@link WebviewContext}, registers for top-level messages that
 * don't belong to any specific component (connection state, errors, chat
 * lifecycle, confirm actions, permission requests), and coordinates
 * cross-cutting concerns like send() and event listeners.
 *
 * All streaming block logic, autocomplete, chip rendering, action buttons,
 * plan/diff panels, and session toolbar logic live in their respective
 * component classes.
 */
export class WebviewController implements MessageHandler {
  private ctx: WebviewContext;
  private messageRouter: MessageRouter;
  private stateService: StatePersistenceService;
  private incomingNotifier = new AsyncSerialQueue();
  private features?: RegisteredWebviewFeatures;
  private snapshotReplayDepth = 0;
  private chatSurfaceGeneration = 0;

  readonly messageList: MessageListComponent;
  readonly inputPanel: InputPanelComponent;
  readonly sessionToolbar: SessionToolbarComponent;
  readonly auxiliaryPanels: AuxiliaryPanelsComponent;
  readonly chipRenderer: ChipRendererComponent;

  getContext(): WebviewContext {
    return this.ctx;
  }

  private isConnected = false;
  private sessionTransitionLocked = false;
  private previousInputContentEditable: string | null = null;
  private previousSendDisabled: boolean | null = null;
  private previousAttachDisabled: boolean | null = null;
  private restoreInputFocusAfterTransition = false;

  constructor(vscode: VsCodeApi, doc: Document, win: Window) {
    this.messageRouter = new MessageRouter();
    this.stateService = new StatePersistenceService(vscode);

    const eventBus = new EventBus<WebviewEventMap>();

    this.ctx = {
      vscode,
      doc,
      win,
      stateService: this.stateService,
      messageRouter: this.messageRouter,
      eventBus,
    };

    const root = new WebviewRootComponent(this.ctx);
    this.chipRenderer = root.chipRenderer;
    this.messageList = root.messageList;
    this.inputPanel = root.inputPanel;
    this.sessionToolbar = root.sessionToolbar;
    this.auxiliaryPanels = root.auxiliaryPanels;

    // Wire cross-component dependencies
    this.messageList.onGeneratingChange = (isGenerating) => {
      if (this.snapshotReplayDepth > 0) return;
      this.features?.messageQueue.setTurnGenerating(isGenerating);
      if (!isGenerating) {
        this.inputPanel.focus();
      }
    };

    this.messageList.onCopyToInput = (text) => {
      this.inputPanel.setTextAndFocus(text);
      this.stateService.flush();
      this.inputPanel.updateInputState();
    };

    // The controller is NOT registered in the router to avoid double-dispatch.
    // Component handlers self-register in their constructors.
    // The window listener dispatches through the router AND calls the
    // controller directly for top-level messages.
    eventBus.on("beforeSend", () => this.beforeMultiSessionSend());

    this.features = registerWebviewFeatures(this);

    this.restoreState();
    this.setupEventListeners();
    this.messageList.updateViewState();
    this.inputPanel.adjustHeight();
    this.inputPanel.updateInputState();
    vscode.postMessage({ type: "ready" });
    new TooltipManager(doc, win).setup();

    // Delegated message-list handlers
    this.messageList.setupCodeCopyHandler();
    this.messageList.setupFileLinkHandler();
    this.messageList.setupDiffHeaderClickHandler();
    this.messageList.setupScrollEventListeners();
  }

  // -------------------------------------------------------------------
  // MessageHandler — unified synchronous dispatch
  // -------------------------------------------------------------------

  /**
   * Handle an incoming extension message. This is the unified entry point
   * called by the window message listener and by tests directly.
   *
   * Processes top-level messages directly, then dispatches to all registered
   * component handlers synchronously.
   */
  handleMessage(
    msg: ExtensionMessage
  ): boolean | void | Promise<boolean | void> {
    const chatFontSizeResult = this.features?.chatFontSize.handleMessage(msg);
    if (chatFontSizeResult === true) return true;

    const chatAutoScrollResult =
      this.features?.chatAutoScroll.handleMessage(msg);
    if (chatAutoScrollResult === true) return true;

    const messageQueueResult = this.features?.messageQueue.handleMessage(msg);
    if (messageQueueResult === true) return true;

    const elicitationResult = this.features?.acpElicitation.handleMessage(msg);
    if (elicitationResult === true) return true;

    const permissionUiResult = this.features?.permissionUi.handleMessage(msg);
    if (permissionUiResult === true) return true;

    const multiSessionResult = this.features?.multiSession.handleMessage(msg);
    if (multiSessionResult === true) return true;
    if (isPromiseLike(multiSessionResult)) {
      return multiSessionResult.then((handled) => {
        if (handled === true) return true;
        return this.handleNonFeatureMessage(msg);
      });
    }
    return this.handleNonFeatureMessage(msg);
  }

  private handleNonFeatureMessage(
    msg: ExtensionMessage
  ): boolean | void | Promise<boolean | void> {
    // 1. Handle top-level messages in this controller
    const topResult = this.handleTopLevelMessage(msg);

    // 2. Dispatch to component handlers
    const handlers = this.messageRouter.getHandlers(msg.type);
    if (handlers.length === 0) return topResult;

    // If any handler returns a Promise, we need to await everything
    const results: (boolean | void | Promise<boolean | void>)[] = [topResult];
    for (const handler of handlers) {
      try {
        results.push(handler.handleMessage(msg));
      } catch (error) {
        console.error(
          `[WebviewController] Error in handler for "${msg.type}":`,
          error
        );
      }
    }

    // If all results are synchronous, return immediately
    const hasAsync = results.some(
      (r) =>
        r !== null &&
        r !== undefined &&
        typeof (r as Promise<unknown>).then === "function"
    );
    if (!hasAsync) return;

    // Otherwise await all results
    return Promise.all(results.map((r) => Promise.resolve(r))).then(() => {});
  }

  private handleTopLevelMessage(
    msg: ExtensionMessage
  ): boolean | void | Promise<boolean | void> {
    switch (msg.type) {
      case "connectionState":
        if (msg.state) {
          this.isConnected = msg.state === "connected";
          this.messageList.updateViewState();
          this.stateService.update("isConnected", this.isConnected);
        }
        return;

      case "error":
        if (msg.text) this.messageList.addMessage(msg.text, "error");
        this.inputPanel.setGenerating(false);
        this.inputPanel.focus();
        return;

      case "agentError":
        if (msg.text) this.messageList.addMessage(msg.text, "error");
        return;

      case "system":
        if (msg.text) this.messageList.addMessage(msg.text, "system");
        return;

      case "agentChanged":
        if (msg.agentName) {
          this.inputPanel.setPlaceholder(msg.agentName);
        }
        this.resetChatState();
        return;

      case "chatCleared":
        this.resetChatState();
        return;

      case "focusInput":
        this.inputPanel.focusWithCaret();
        return;

      case "confirmAction": {
        const actionLabel = msg.actionLabel || msg.action || "this action";
        return showConfirmDialog(this.ctx.doc, actionLabel).then(
          (confirmed) => {
            this.ctx.vscode.postMessage({
              type: "confirmActionResponse",
              requestId: msg.requestId,
              confirmed,
            });
          }
        );
      }

      case "sessionMetadata": {
        this.sessionToolbar.updateMetadata(msg);
        if (msg.commands && Array.isArray(msg.commands)) {
          this.messageList.setAvailableCommands(msg.commands);
          this.inputPanel.setAvailableCommands(msg.commands);
        }
        return;
      }

      case "availableCommands":
        if (msg.commands && Array.isArray(msg.commands)) {
          this.messageList.setAvailableCommands(msg.commands);
          this.inputPanel.setAvailableCommands(msg.commands);
        }
        return;
    }
  }

  // -------------------------------------------------------------------
  // State persistence
  // -------------------------------------------------------------------

  private restoreState(): void {
    const previousState = this.stateService.restore();
    if (previousState) {
      this.isConnected = previousState.isConnected;
    }
  }

  // -------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------

  private setupEventListeners(): void {
    this.ctx.win.addEventListener(
      "message",
      (e: MessageEvent<ExtensionMessage>) =>
        this.incomingNotifier.enqueue(async () => {
          try {
            await this.handleMessage(e.data);
          } catch (error) {
            console.error("[Webview] Error handling extension message:", error);
          }
        })
    );
  }

  resetChatState(): void {
    this.features?.acpElicitation.handleMessage({
      type: "feature.acp-elicitation.show",
      ownerId: "",
      pendingElicitations: [],
    });
    this.features?.permissionUi.clear();
    this.messageList.clear();
    this.inputPanel.autocomplete.hide();
    this.auxiliaryPanels.hidePlan();
    this.auxiliaryPanels.clearDiff();
    this.messageList.updateViewState();
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  getVsCodeApi(): VsCodeApi {
    return this.ctx.vscode;
  }

  getDocument(): Document {
    return this.ctx.doc;
  }

  getWindow(): Window {
    return this.ctx.win;
  }

  getEventBus(): EventBus<WebviewEventMap> {
    return this.ctx.eventBus;
  }

  onMessageSent(handler: () => void): { dispose(): void } {
    const listener = () => handler();
    this.ctx.eventBus.on("messageSent", listener);
    return {
      dispose: () => this.ctx.eventBus.off("messageSent", listener),
    };
  }

  getWebviewState() {
    return this.stateService.restore();
  }

  saveWebviewState(state: WebviewState): void {
    this.stateService.save(state);
    this.stateService.flush();
  }

  beginSnapshotReplay(): void {
    this.snapshotReplayDepth += 1;
    this.messageList.beginSnapshotReplay();
  }

  endSnapshotReplay(): void {
    this.messageList.endSnapshotReplay();
    this.snapshotReplayDepth = Math.max(0, this.snapshotReplayDepth - 1);
  }

  beginChatSurfaceReplacement(): number {
    const generation = ++this.chatSurfaceGeneration;
    this.ctx.eventBus.emit("chatSurfaceReplacementStarted", { generation });
    return generation;
  }

  finishChatSurfaceReplacement(
    generation: number,
    committed: boolean
  ): void {
    this.ctx.eventBus.emit("chatSurfaceReplacementFinished", {
      generation,
      committed,
    });
  }

  beforeMultiSessionSend(): void {
    this.features?.multiSession.beforeSend();
  }

  acknowledgeSubmittedDraft(sessionId: string | undefined): void {
    this.features?.multiSession.acknowledgeSubmittedDraft(sessionId);
  }

  restoreDraftPayloads(sessionId: string | undefined, html: string): void {
    this.features?.multiSession.restoreDraftPayloads(sessionId, html);
  }

  setSessionTransitionLocked(value: boolean): void {
    if (this.sessionTransitionLocked === value) return;
    this.sessionTransitionLocked = value;

    const { inputEl, sendBtn, attachImageBtn } = this.inputPanel.elements;
    const messagesContainer = this.messageList.elements.containerEl;
    const inputContainer = this.ctx.doc.getElementById("input-container");

    if (value) {
      this.restoreInputFocusAfterTransition =
        this.ctx.doc.activeElement === inputEl ||
        inputEl.contains(this.ctx.doc.activeElement);
    }

    messagesContainer.setAttribute("aria-busy", value ? "true" : "false");
    inputContainer?.setAttribute("aria-busy", value ? "true" : "false");
    inputContainer?.toggleAttribute("inert", value);
    messagesContainer.toggleAttribute("inert", value);

    if (value) {
      this.previousInputContentEditable =
        inputEl.getAttribute("contenteditable");
      this.previousSendDisabled = sendBtn.disabled;
      this.previousAttachDisabled = attachImageBtn.disabled;
      inputEl.setAttribute("contenteditable", "false");
      inputEl.setAttribute("aria-disabled", "true");
      sendBtn.disabled = true;
      attachImageBtn.disabled = true;
      return;
    }

    inputEl.setAttribute(
      "contenteditable",
      this.previousInputContentEditable ?? "true"
    );
    inputEl.removeAttribute("aria-disabled");
    sendBtn.disabled = this.previousSendDisabled ?? sendBtn.disabled;
    attachImageBtn.disabled = this.previousAttachDisabled ?? false;
    this.inputPanel.updateInputState();
    const restoreInputFocus = this.restoreInputFocusAfterTransition;
    this.restoreInputFocusAfterTransition = false;
    this.previousInputContentEditable = null;
    this.previousSendDisabled = null;
    this.previousAttachDisabled = null;
    if (restoreInputFocus) {
      this.inputPanel.focus();
    }
  }

  setTurnGenerating(value: boolean): void {
    this.features?.messageQueue.setTurnGenerating(value);
    if (!value) {
      this.messageList.clearGeneratingState();
    }
  }

  getTools() {
    return this.messageList.getBlockManager().getToolsSnapshot();
  }
}

function isPromiseLike<T>(
  value: T | PromiseLike<T> | undefined
): value is PromiseLike<T> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

/**
 * Backward-compatible entry point.
 */
export function initWebview(
  vscode: VsCodeApi,
  doc: Document,
  win: Window
): WebviewController {
  return new WebviewController(vscode, doc, win);
}

if (typeof acquireVsCodeApi !== "undefined") {
  const vscode = acquireVsCodeApi();
  initWebview(vscode, document, window);
}
