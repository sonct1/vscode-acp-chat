import { marked } from "./marked-config";
import { escapeHtml } from "./html-utils";
import { getFileIconHtml, getFolderIconHtml } from "./file-icon";
import { TooltipManager } from "./widget/tooltip";
import { showConfirmDialog } from "./widget/confirm-dialog";
import { PermissionDialog } from "./widget/permission-dialog";
import { AuxiliaryPanelsComponent } from "./component/auxiliary-panels";
import { InputPanelComponent } from "./component/input-panel";
import { MessageListComponent } from "./component/message-list";
import { SessionToolbarComponent } from "./component/session-toolbar";
import { ChipRendererComponent } from "./component/chip-renderer";
import { createWebviewRoot } from "./component/webview-root";
import { MessageRouter, type MessageHandler } from "./message-router";
import { StatePersistenceService } from "./state-persistence";
import { EventBus } from "./event-bus";
import { AsyncSerialQueue } from "../../utils/async-queue";
import type { WebviewContext } from "./context";
import type {
  VsCodeApi,
  Mention,
  ExtensionMessage,
  WebviewElements,
  WebviewEventMap,
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
  private elements: WebviewElements;
  private messageRouter: MessageRouter;
  private stateService: StatePersistenceService;
  private incomingNotifier = new AsyncSerialQueue();

  readonly messageList: MessageListComponent;
  readonly inputPanel: InputPanelComponent;
  readonly sessionToolbar: SessionToolbarComponent;
  readonly auxiliaryPanels: AuxiliaryPanelsComponent;
  readonly chipRenderer: ChipRendererComponent;

  private permissionDialog: PermissionDialog;
  private isConnected = false;

  constructor(
    vscode: VsCodeApi,
    elements: WebviewElements,
    doc: Document,
    win: Window
  ) {
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
      escapeHtml,
      renderMarkdown: (content: string) => marked.parse(content) as string,
      getFileIconHtml,
      getFolderIconHtml,
      scrollToBottom: (force?: boolean) =>
        this.messageList.scrollToBottom(force ?? false),
    };

    this.chipRenderer = new ChipRendererComponent(this.ctx);
    this.elements = elements;

    this.messageList = new MessageListComponent(this.ctx, {
      elements: this.elements.messageList,
      chipRenderer: this.chipRenderer,
    });

    this.inputPanel = new InputPanelComponent(this.ctx, {
      elements: this.elements.inputPanel,
      chipRenderer: this.chipRenderer,
    });

    this.sessionToolbar = new SessionToolbarComponent(this.ctx, {
      elements: this.elements.sessionToolbar,
    });

    this.auxiliaryPanels = new AuxiliaryPanelsComponent(this.ctx, {
      elements: this.elements.auxiliaryPanels,
    });

    this.permissionDialog = new PermissionDialog(
      this.ctx,
      () => this.messageList.getBlockManager(),
      () => this.messageList.getIsGenerating(),
      (v) => this.inputPanel.setGenerating(v),
      () => this.messageList.scrollToBottom()
    );

    // Wire cross-component dependencies
    this.messageList.onGeneratingChange = (isGenerating) => {
      this.inputPanel.setGenerating(isGenerating);
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

      case "triggerNewChat":
        this.ctx.vscode.postMessage({ type: "newChat" });
        return;

      case "triggerClearChat":
        this.ctx.vscode.postMessage({ type: "clearChat" });
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

      case "permissionRequest":
        if (msg.requestId && msg.toolCall && msg.options) {
          this.permissionDialog.show(
            msg.requestId,
            msg.toolCall,
            msg.options,
            msg.toolCallId
          );
        }
        return;

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
      if (previousState.inputValue) {
        this.elements.inputEl.innerHTML = previousState.inputValue;
        // Re-attach listeners to mention chips
        const chips = Array.from(
          this.elements.inputEl.querySelectorAll(".mention-chip")
        );
        chips.forEach((chip) => {
          const c = chip as HTMLElement;
          const mention: Mention = {
            name: c.dataset.name || "",
            path: c.dataset.path,
            type: c.dataset.type as Mention["type"],
            content: c.dataset.content,
            dataUrl: c.dataset.dataUrl,
            range: c.dataset.range
              ? {
                  startLine: parseInt(c.dataset.range.split("-")[0], 10),
                  endLine: parseInt(c.dataset.range.split("-")[1], 10),
                }
              : undefined,
          };
          const newChip = this.chipRenderer.renderMentionChip(mention, false);
          c.replaceWith(newChip);
        });
      }
      if (previousState.diffChanges) {
        this.auxiliaryPanels.setDiffChanges(previousState.diffChanges);
      }
    }
  }

  private saveState(): void {
    this.stateService.save({
      isConnected: this.isConnected,
      inputValue: this.elements.inputEl.innerHTML || "",
      diffChanges: this.auxiliaryPanels.getDiffChanges(),
    });
  }

  // -------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------

  private setupEventListeners(): void {
    const { sendBtn, stopBtn, inputEl, commandAutocomplete } = this.elements;

    sendBtn.addEventListener("click", () => this.inputPanel.send());
    stopBtn.addEventListener("click", () => {
      this.ctx.vscode.postMessage({ type: "stop" });
    });

    inputEl.addEventListener("keydown", (e) => {
      // Let autocomplete handle keys first
      if (this.inputPanel.autocomplete.handleKeyDown(e)) {
        // If Enter/Tab was pressed with a selection, insert the chip
        if (
          (e.key === "Tab" || e.key === "Enter") &&
          this.inputPanel.autocomplete.isActive()
        ) {
          const result = this.inputPanel.autocomplete.selectCurrent();
          if (result) {
            if (typeof result === "string") {
              this.inputPanel.insertCommandChip(result);
            } else {
              this.inputPanel.insertMentionChip(result);
            }
          }
          this.saveState();
          this.inputPanel.updateInputState();
        }
        return;
      }

      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !this.inputPanel.getIsGenerating()
      ) {
        e.preventDefault();
        this.inputPanel.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.inputPanel.clearInput();
        this.inputPanel.autocomplete.hide();
        this.saveState();
        this.inputPanel.updateInputState();
      }
    });

    inputEl.addEventListener("input", () => {
      this.inputPanel.adjustHeight();
      this.inputPanel.autocomplete.update();
      this.saveState();
      this.inputPanel.updateInputState();
    });

    inputEl.addEventListener("paste", (e) => {
      const insertedText = this.inputPanel.handlePaste(
        e as unknown as Parameters<typeof this.inputPanel.handlePaste>[0],
        (file) =>
          this.inputPanel.handleImageAttachment(file, (mention) =>
            this.inputPanel.insertMentionChip(mention)
          )
      );
      if (!insertedText) return;
      this.inputPanel.autocomplete.update();
      this.saveState();
      this.inputPanel.updateInputState();
    });

    this.inputPanel.setupAttachImageButton((file) =>
      this.inputPanel.handleImageAttachment(file, (mention) =>
        this.inputPanel.insertMentionChip(mention)
      )
    );

    commandAutocomplete.addEventListener("mousedown", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        e.preventDefault();
      }
    });

    commandAutocomplete.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        e.stopPropagation();
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        const result = this.inputPanel.autocomplete.selectAt(index);
        if (result) {
          if (typeof result === "string") {
            this.inputPanel.insertCommandChip(result);
          } else {
            this.inputPanel.insertMentionChip(result);
          }
        }
        this.saveState();
        this.inputPanel.updateInputState();
      }
    });

    commandAutocomplete.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        const items = commandAutocomplete.querySelectorAll(".command-item");
        items.forEach((it, i) => {
          if (i === index) {
            it.classList.add("selected");
            it.setAttribute("aria-selected", "true");
          } else {
            it.classList.remove("selected");
            it.setAttribute("aria-selected", "false");
          }
        });
      }
    });

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

  private resetChatState(): void {
    this.messageList.clear();
    this.inputPanel.autocomplete.hide();
    this.auxiliaryPanels.hidePlan();
    this.auxiliaryPanels.clearDiff();
    this.messageList.updateViewState();
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  getTools() {
    return this.messageList.getBlockManager().getToolsSnapshot();
  }
}

/**
 * Backward-compatible helper: look up DOM elements using the flat alias map.
 * Kept for the incremental test migration; remove when getElements moves
 * out of the public API.
 */
export function getElements(doc: Document): WebviewElements {
  // Build a minimal context for DOM lookup only (no message routing).
  const router = new MessageRouter();
  const mockVscode: VsCodeApi = {
    postMessage: () => {},
    getState: () => undefined,
    setState: (s) => s,
  };
  const ctx: WebviewContext = {
    vscode: mockVscode,
    doc,
    win: (doc.defaultView ?? globalThis) as unknown as Window,
    stateService: new StatePersistenceService(mockVscode),
    messageRouter: router,
    eventBus: new EventBus<WebviewEventMap>(),
    escapeHtml,
    renderMarkdown: (c: string) => marked.parse(c) as string,
    getFileIconHtml,
    getFolderIconHtml,
    scrollToBottom: () => {},
  };
  return createWebviewRoot(ctx);
}

/**
 * Backward-compatible entry point.
 */
export function initWebview(
  vscode: VsCodeApi,
  doc: Document,
  win: Window
): WebviewController {
  const elements = getElements(doc);
  return new WebviewController(vscode, elements, doc, win);
}

if (typeof acquireVsCodeApi !== "undefined") {
  const vscode = acquireVsCodeApi();
  initWebview(vscode, document, window);
}
