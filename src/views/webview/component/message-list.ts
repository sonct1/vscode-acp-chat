import type {
  AvailableCommand,
  ExtensionMessage,
  Mention,
  MessageListElements,
  MessageScrollPosition,
  PromptHistoryEntry,
  UserScrollDirection,
} from "../types";
import type { WebviewContext } from "../context";
import type { MessageHandler } from "../message-router";
import { ChipRendererComponent } from "./chip-renderer";
import { BlockManager } from "../block/block-manager";
import { TextBlock } from "../block/text-block";
import { ActionButtonsComponent } from "./action-buttons";
import { getRequiredElement } from "../widget/dom";

const BOTTOM_THRESHOLD_PX = 100;
const AUTO_SCROLL_SETTLE_FRAMES = 3;

/**
 * Settings interface consumed by {@link applyAutoScrollSettings}.
 * These match the shape produced by the chat-auto-scroll feature.
 */
export interface AutoScrollSettings {
  bottomThresholdPx: number;
  settleFrames: number;
}

type MessageType = "user" | "assistant" | "error" | "system";

/**
 * Owns the chat transcript surface: message DOM, streaming block lifecycle,
 * list-level event delegation, keyboard navigation, and auto-scroll state.
 *
 * Implements {@link MessageHandler} to self-register for all streaming and
 * message-related extension messages. The {@link BlockManager} and
 * {@link ActionButtonsComponent} are owned sub-components.
 */
export class MessageListComponent implements MessageHandler {
  readonly elements: MessageListElements;
  private blockManager: BlockManager;
  private actionButtons: ActionButtonsComponent;
  private chipRenderer: ChipRendererComponent;
  private currentAssistantMessage: HTMLElement | null = null;
  private snapshotReplayDepth = 0;
  private snapshotCompletedAssistantMessages: HTMLElement[] = [];
  private pendingSnapshotText = "";
  private pendingSnapshotThought = "";

  private isAutoScrollEnabled = true;
  private pendingBottomScrollFrame: number | null = null;
  private pendingBottomScrollForce = false;
  private bottomScrollSettleFrames = 0;
  private autoScrollBottomThreshold = BOTTOM_THRESHOLD_PX;
  private autoScrollSettleFrames = AUTO_SCROLL_SETTLE_FRAMES;
  private pendingPaintFrame: number | null = null;
  private paintBump = false;
  private userScrollIntent = false;
  private pointerScrollActive = false;
  private touchScrollActive = false;
  private userScrollDirection: UserScrollDirection = "none";
  private readonly scrollPositionListeners = new Set<
    (position: MessageScrollPosition) => void
  >();

  private availableCommands: AvailableCommand[] = [];
  private isGenerating = false;

  /** Callback invoked when generation state changes. */
  onGeneratingChange?: (isGenerating: boolean) => void;

  /** Callback for "copy to input" action button. */
  onCopyToInput?: (text: string) => void;

  constructor(
    private ctx: WebviewContext,
    options?: {
      elements?: MessageListElements;
      chipRenderer: ChipRendererComponent;
    }
  ) {
    this.elements = options?.elements ?? {
      containerEl: getRequiredElement(ctx.doc, "messages-container"),
      messagesEl: getRequiredElement(ctx.doc, "messages"),
      typingIndicatorEl: getRequiredElement(ctx.doc, "typing-indicator"),
      welcomeView: getRequiredElement(ctx.doc, "welcome-view"),
    };

    this.chipRenderer = options?.chipRenderer ?? new ChipRendererComponent(ctx);
    this.blockManager = new BlockManager(ctx);
    this.actionButtons = new ActionButtonsComponent(ctx);

    // Register for all streaming and message-related messages.
    ctx.messageRouter.registerMany(
      [
        "userMessage",
        "streamStart",
        "streamChunk",
        "streamEnd",
        "thoughtChunk",
        "toolCallStart",
        "toolCallProgress",
        "toolCallComplete",
      ],
      this
    );

    // Scroll to bottom when a user message is sent.
    ctx.eventBus.on("messageSent", () => {
      this.scrollToBottom(true);
    });
  }

  // -------------------------------------------------------------------
  // MessageHandler
  // -------------------------------------------------------------------

  handleMessage(msg: ExtensionMessage): boolean | void {
    switch (msg.type) {
      case "userMessage":
        return this.handleUserMessage(msg);
      case "streamStart":
        return this.handleStreamStart();
      case "streamChunk":
        return this.handleStreamChunk(msg);
      case "streamEnd":
        return this.handleStreamEnd();
      case "thoughtChunk":
        return this.handleThoughtChunk(msg);
      case "toolCallStart":
        return this.handleToolCallStart(msg);
      case "toolCallProgress":
        return this.handleToolCallProgress(msg);
      case "toolCallComplete":
        return this.handleToolCallComplete(msg);
    }
  }

  // -------------------------------------------------------------------
  // Message handlers (moved from controller)
  // -------------------------------------------------------------------

  private handleUserMessage(msg: ExtensionMessage): void {
    this.flushSnapshotContent();
    // Always reset assistant state before a new turn
    this.currentAssistantMessage = null;
    this.blockManager.reset();

    if (msg.text || (msg.images && msg.images.length > 0)) {
      this.addMessage(msg.text || "", "user", msg.mentions);
    }
  }

  private handleStreamStart(): void {
    this.flushSnapshotContent();
    this.currentAssistantMessage = null;
    this.blockManager.reset();
    this.setGenerating(true);
  }

  private handleStreamChunk(msg: ExtensionMessage): void {
    if (!msg.text) return;
    if (this.isSnapshotReplay() && msg.finalized) {
      this.flushSnapshotThought();
      this.pendingSnapshotText += msg.text;
      return;
    }
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureBlock(
      "text",
      parentEl,
      this.elements.typingIndicatorEl
    ) as TextBlock;
    block.appendContent(msg.text);
    this.scrollToBottom();
  }

  private handleStreamEnd(): void {
    this.flushSnapshotContent();
    this.blockManager.clearStaleRunningToolIndicators();
    this.blockManager.finalizeAll();
    this.setGenerating(false);

    if (this.currentAssistantMessage) {
      if (this.isSnapshotReplay()) {
        this.snapshotCompletedAssistantMessages.push(
          this.currentAssistantMessage
        );
      } else {
        this.renderActionButtons(this.currentAssistantMessage);
      }
      this.currentAssistantMessage = null;
    }
    this.scrollToBottom();
  }

  private handleThoughtChunk(msg: ExtensionMessage): void {
    if (!msg.text) return;
    if (this.isSnapshotReplay() && msg.finalized) {
      this.flushSnapshotText();
      this.pendingSnapshotThought += msg.text;
      return;
    }
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureBlock(
      "thought",
      parentEl,
      this.elements.typingIndicatorEl
    );
    block.appendContent(msg.text);
    this.scrollToBottom();
  }

  private handleToolCallStart(msg: ExtensionMessage): void {
    this.flushSnapshotContent();
    if (!msg.toolCallId || !msg.name) return;
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureToolBlock(
      msg.toolCallId,
      parentEl,
      this.elements.typingIndicatorEl
    );
    if (block) {
      if (!block.acceptRevision(msg.revision)) return;
      if (msg.kind) block.kind = msg.kind;
      if (msg.name) block.title = msg.name;

      block.updateSummary({
        toolCallId: msg.toolCallId,
        title: msg.name || block.title || "Tool",
        kind: msg.kind,
        status: "in_progress",
        rawInput: msg.rawInput,
        revision: msg.revision,
      });
    }
    this.scrollToBottom();
  }

  private handleToolCallProgress(msg: ExtensionMessage): void {
    this.flushSnapshotContent();
    if (!msg.toolCallId || !msg.presentation) return;
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureToolBlock(
      msg.toolCallId,
      parentEl,
      this.elements.typingIndicatorEl
    );
    if (!block || !block.acceptRevision(msg.revision)) return;

    if (msg.kind) block.kind = msg.kind;
    if (msg.title || msg.name) block.title = msg.title || msg.name;
    if (msg.status) block.status = msg.status;
    const title =
      msg.title || msg.name || block.title || block.toolId || "Tool";

    const summary = {
      toolCallId: msg.toolCallId,
      title,
      kind: msg.kind || block.kind,
      status: msg.status || "in_progress",
      locations: msg.locations,
      rawInput: msg.rawInput,
      revision: msg.revision,
      presentation: msg.presentation,
    };
    block.updateSummary(summary);
    block.updateDetails(summary);
    this.scrollToBottom();
  }

  private handleToolCallComplete(msg: ExtensionMessage): void {
    this.flushSnapshotContent();
    if (!msg.toolCallId) return;
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureToolBlock(
      msg.toolCallId,
      parentEl,
      this.elements.typingIndicatorEl
    );
    if (block) {
      if (!block.acceptRevision(msg.revision)) return;
      if (msg.kind) block.kind = msg.kind;
      if (msg.title) block.title = msg.title;
      if (msg.status) block.status = msg.status;

      const finalTitle = msg.title || block.title || block.toolId || "Tool";

      block.removeSpinner();

      block.updateSummary({
        toolCallId: msg.toolCallId,
        title: finalTitle,
        kind: msg.kind || block.kind,
        status: msg.status || "completed",
        locations: msg.locations,
        rawInput: msg.rawInput,
        duration: msg.duration,
        revision: msg.revision,
      });

      if (msg.status === "failed") {
        block.markFailed();
      }

      block.updateDetails(
        {
          toolCallId: msg.toolCallId,
          title: finalTitle,
          kind: msg.kind || block.kind,
          status: msg.status || "completed",
          locations: msg.locations,
          rawInput: msg.rawInput,
          rawOutput: msg.rawOutput,
          content: msg.content,
          duration: msg.duration,
          terminalOutput: msg.terminalOutput,
          terminalSemantics: msg.terminalSemantics,
          presentation: msg.presentation,
          revision: msg.revision,
        },
        this.isSnapshotReplay()
      );

      this.blockManager.finalizeBlock(block);
      this.scrollToBottom();
    }
  }

  beginSnapshotReplay(): void {
    this.snapshotReplayDepth += 1;
    this.pendingSnapshotText = "";
    this.pendingSnapshotThought = "";
  }

  endSnapshotReplay(): void {
    this.flushSnapshotContent();
    this.snapshotReplayDepth = Math.max(0, this.snapshotReplayDepth - 1);
    if (this.snapshotReplayDepth === 0) {
      for (const message of this.snapshotCompletedAssistantMessages) {
        this.renderActionButtons(message);
      }
      this.snapshotCompletedAssistantMessages = [];
    }
  }

  private flushSnapshotContent(): void {
    this.flushSnapshotText();
    this.flushSnapshotThought();
  }

  private flushSnapshotText(): void {
    if (!this.pendingSnapshotText) return;
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureBlock(
      "text",
      parentEl,
      this.elements.typingIndicatorEl
    ) as TextBlock;
    block.setContent(this.pendingSnapshotText);
    this.pendingSnapshotText = "";
  }

  private flushSnapshotThought(): void {
    if (!this.pendingSnapshotThought) return;
    const parentEl = this.ensureAssistantMessage();
    const block = this.blockManager.ensureBlock(
      "thought",
      parentEl,
      this.elements.typingIndicatorEl
    );
    if ("setContent" in block) {
      (block as { setContent(text: string): void }).setContent(
        this.pendingSnapshotThought
      );
    }
    this.pendingSnapshotThought = "";
  }

  private isSnapshotReplay(): boolean {
    return this.snapshotReplayDepth > 0;
  }

  private renderActionButtons(message: HTMLElement): void {
    this.actionButtons.render(message, {
      onCopyToInput: (text) => {
        this.onCopyToInput?.(text);
      },
      scrollToTop: () => this.scrollToTop(),
      scrollToPreviousUserMessage: (el) => this.scrollToPreviousUserMessage(el),
    });
  }

  // -------------------------------------------------------------------
  // Assistant message management
  // -------------------------------------------------------------------

  /**
   * Ensure the current assistant message element exists. Creates a new
   * empty assistant message if needed.
   * Public so the controller can create assistant messages for block
   * operations like showThinking.
   */
  ensureAssistantMessage(): HTMLElement {
    if (!this.currentAssistantMessage) {
      this.currentAssistantMessage = this.addMessage("", "assistant");
      if (this.elements.typingIndicatorEl.classList.contains("visible")) {
        this.currentAssistantMessage.appendChild(
          this.elements.typingIndicatorEl
        );
      }
    }
    return this.currentAssistantMessage;
  }

  // -------------------------------------------------------------------
  // Public API (used by controller and other components)
  // -------------------------------------------------------------------

  /** Set the available commands for mention/command rendering. */
  setAvailableCommands(commands: AvailableCommand[]): void {
    this.availableCommands = commands;
  }

  /** Return the block manager (for permission dialog lookups). */
  getBlockManager(): BlockManager {
    return this.blockManager;
  }

  /** Return the generation state. */
  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  getScrollTop(): number {
    return this.elements.messagesEl.scrollTop;
  }

  setScrollTop(value: number): void {
    this.cancelPendingBottomScroll();
    this.elements.messagesEl.scrollTop = value;
    this.isAutoScrollEnabled = this.isNearMessagesBottom();
    this.notifyScrollPositionChange();
    this.scheduleMessagesPaintInvalidation();
  }

  onScrollPositionChange(handler: (position: MessageScrollPosition) => void): {
    dispose(): void;
  } {
    this.scrollPositionListeners.add(handler);
    handler(this.getScrollPosition());
    return {
      dispose: () => this.scrollPositionListeners.delete(handler),
    };
  }

  getUserMessageDrafts(): PromptHistoryEntry[] {
    return Array.from(
      this.elements.messagesEl.querySelectorAll<HTMLElement>(
        ".message.user .message-content-text"
      )
    ).flatMap((contentEl) => {
      const clone = contentEl.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll<HTMLElement>(".mention-chip, .command-chip")
        .forEach((chip) => chip.classList.remove("readonly"));

      const text = clone.textContent?.trim() ?? "";
      if (!text && clone.children.length === 0) return [];

      return [{ html: clone.innerHTML, text }];
    });
  }

  addMessage(
    text: string,
    type: MessageType,
    mentions?: Mention[]
  ): HTMLElement {
    const { doc } = this.ctx;
    const messageEl = doc.createElement("div");
    messageEl.className = "message " + type;
    messageEl.setAttribute("role", "article");
    messageEl.setAttribute("tabindex", "0");

    const label =
      type === "user"
        ? "Your message"
        : type === "assistant"
          ? "Agent response"
          : type === "error"
            ? "Error message"
            : "System message";
    messageEl.setAttribute("aria-label", label);

    if (text) {
      messageEl.appendChild(this.renderMessageText(text, type, mentions));
    }

    this.elements.messagesEl.appendChild(messageEl);
    this.scrollToBottom(type === "user");

    if (text) {
      this.announceToScreenReader(label + ": " + text.substring(0, 100));
    }

    this.updateViewState();
    return messageEl;
  }

  updateViewState(): void {
    const hasMessages = this.elements.messagesEl.children.length > 0;
    this.elements.welcomeView.style.display = !hasMessages ? "flex" : "none";
    this.elements.containerEl.style.display = hasMessages ? "flex" : "none";
  }

  clear(): void {
    this.cancelPendingBottomScroll();
    this.elements.messagesEl.innerHTML = "";
    this.elements.messagesEl.scrollTop = 0;
    this.isAutoScrollEnabled = true;
    this.currentAssistantMessage = null;
    this.blockManager.reset();
    this.updateViewState();
    this.notifyScrollPositionChange();
    this.scheduleMessagesPaintInvalidation();
  }

  showTypingIndicator(): void {
    this.elements.typingIndicatorEl.classList.add("visible");
    if (this.currentAssistantMessage) {
      this.currentAssistantMessage.appendChild(this.elements.typingIndicatorEl);
    } else {
      this.elements.messagesEl.appendChild(this.elements.typingIndicatorEl);
    }
  }

  hideTypingIndicator(): void {
    this.elements.typingIndicatorEl.classList.remove("visible");
  }

  scrollToBottom(force = false): void {
    if (this.isSnapshotReplay()) return;
    if (force) {
      this.enableAutoScroll();
    }

    if (!force && !this.isAutoScrollEnabled) {
      this.scheduleMessagesPaintInvalidation();
      return;
    }

    this.pendingBottomScrollForce = this.pendingBottomScrollForce || force;
    this.bottomScrollSettleFrames = Math.max(
      this.bottomScrollSettleFrames,
      this.autoScrollSettleFrames
    );
    this.scheduleBottomScrollFrame();
  }

  disableAutoScroll(): void {
    this.isAutoScrollEnabled = false;
    this.cancelPendingBottomScroll();
  }

  scrollToTop(): void {
    this.disableAutoScroll();
    this.elements.messagesEl.scrollTo({ top: 0, behavior: "smooth" });
  }

  scrollToPreviousUserMessage(messageEl: HTMLElement): void {
    this.disableAutoScroll();
    const allMessages = Array.from(
      this.elements.messagesEl.querySelectorAll(".message")
    );
    const currentIdx = allMessages.indexOf(messageEl);
    if (currentIdx <= 0) return;

    for (let index = currentIdx - 1; index >= 0; index--) {
      if (allMessages[index].classList.contains("user")) {
        allMessages[index].scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        break;
      }
    }
  }

  /**
   * Apply runtime auto-scroll settings received from the extension host.
   * Called by the chat-auto-scroll feature controller.
   */
  applyAutoScrollSettings(settings: AutoScrollSettings): void {
    this.autoScrollBottomThreshold = settings.bottomThresholdPx;
    this.autoScrollSettleFrames = settings.settleFrames;
    this.isAutoScrollEnabled = this.isNearMessagesBottom();
    this.notifyScrollPositionChange();
    this.scheduleMessagesPaintInvalidation();
  }

  // -------------------------------------------------------------------
  // Event delegation (called from controller / setupEventListeners)
  // -------------------------------------------------------------------

  setupCodeCopyHandler(): void {
    this.elements.messagesEl.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const copyBtn = target.closest(".code-copy-btn") as HTMLButtonElement;
      if (!copyBtn) return;

      event.preventDefault();
      event.stopPropagation();

      const wrapper = copyBtn.closest(".code-block-wrapper");
      if (!wrapper) return;

      const pre = wrapper.querySelector("pre");
      if (!pre) return;

      const textToCopy = pre.textContent || "";

      try {
        await navigator.clipboard.writeText(textToCopy);

        const icon = copyBtn.querySelector(".codicon");
        if (icon) {
          icon.classList.remove("codicon-copy");
          icon.classList.add("codicon-check");
          copyBtn.classList.add("copied");
          copyBtn.setAttribute("acp-title", "Copied!");
        }

        setTimeout(() => {
          if (icon) {
            icon.classList.remove("codicon-check");
            icon.classList.add("codicon-copy");
            copyBtn.classList.remove("copied");
            const wrapper = copyBtn.closest(".code-block-wrapper");
            if (wrapper) {
              const pre = wrapper.querySelector("pre");
              if (pre && pre.classList.contains("detail-input")) {
                copyBtn.setAttribute("acp-title", "Copy input");
              } else if (pre && pre.classList.contains("tool-output")) {
                copyBtn.setAttribute("acp-title", "Copy output");
              } else {
                copyBtn.setAttribute("acp-title", "Copy code");
              }
            }
          }
        }, 1500);
      } catch (error) {
        console.error("Failed to copy:", error);
      }
    });
  }

  setupFileLinkHandler(): void {
    this.elements.messagesEl.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest(
        "a"
      ) as HTMLAnchorElement | null;
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      if (href.startsWith("#")) return;
      if (/^[a-zA-Z][a-zA-Z0-9.+-]*:/.test(href) && !href.startsWith("file:"))
        return;

      event.preventDefault();
      event.stopPropagation();
      const message: { type: "openFile"; href: string; checkExists?: boolean } =
        {
          type: "openFile",
          href,
        };
      if (target.dataset.acpCheckExists === "true") {
        message.checkExists = true;
      }
      this.ctx.vscode.postMessage(message);
    });
  }

  setupDiffHeaderClickHandler(): void {
    this.elements.messagesEl.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest(
        ".diff-header"
      ) as HTMLElement | null;
      if (!target) return;

      const path = target.getAttribute("data-file-path");
      if (!path) return;

      event.preventDefault();
      event.stopPropagation();
      this.ctx.vscode.postMessage({
        type: "openFile",
        path,
        checkExists: true,
      });
    });
  }

  setupScrollEventListeners(): void {
    const { messagesEl } = this.elements;
    const { win } = this.ctx;

    messagesEl.addEventListener("wheel", (event) => {
      if (!this.isEventFromMessagesScrollContainer(event.target)) return;
      const direction =
        event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : "unknown";
      this.markUserScrollIntent(direction);
    });

    messagesEl.addEventListener("pointerdown", (event) => {
      if (
        event.target !== messagesEl ||
        !this.isEventFromMessagesScrollContainer(event.target)
      ) {
        return;
      }
      this.pointerScrollActive = true;
      this.markUserScrollIntent("unknown");
    });

    messagesEl.addEventListener("touchstart", (event) => {
      if (!this.isEventFromMessagesScrollContainer(event.target)) return;
      this.touchScrollActive = true;
    });

    messagesEl.addEventListener("touchmove", (event) => {
      if (!this.isEventFromMessagesScrollContainer(event.target)) return;
      this.touchScrollActive = true;
      this.markUserScrollIntent("unknown");
    });

    messagesEl.addEventListener("keydown", (event) => {
      if (this.isEventFromMessagesScrollContainer(event.target)) {
        if (
          event.key === "ArrowUp" ||
          event.key === "PageUp" ||
          event.key === "Home"
        ) {
          this.markUserScrollIntent("up");
        } else if (
          event.key === "ArrowDown" ||
          event.key === "PageDown" ||
          event.key === "End" ||
          event.key === " "
        ) {
          this.markUserScrollIntent("down");
        }
      }

      const messages = Array.from(messagesEl.querySelectorAll(".message"));
      const currentIndex = messages.indexOf(
        this.ctx.doc.activeElement as Element
      );

      if (event.key === "ArrowDown" && currentIndex < messages.length - 1) {
        event.preventDefault();
        (messages[currentIndex + 1] as HTMLElement).focus();
      } else if (event.key === "ArrowUp" && currentIndex > 0) {
        event.preventDefault();
        (messages[currentIndex - 1] as HTMLElement).focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        (messages[0] as HTMLElement)?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        (messages[messages.length - 1] as HTMLElement)?.focus();
      }
    });

    messagesEl.addEventListener("scroll", () => this.handleMessagesScroll());

    win.addEventListener("pointerup", () => this.clearPointerScroll());
    win.addEventListener("pointercancel", () => this.clearPointerScroll());
    win.addEventListener("touchend", () => this.clearTouchScroll());
    win.addEventListener("touchcancel", () => this.clearTouchScroll());
  }

  // -------------------------------------------------------------------
  // Generating state
  // -------------------------------------------------------------------

  private setGenerating(isGenerating: boolean): void {
    this.isGenerating = isGenerating;
    if (isGenerating) {
      this.showTypingIndicator();
      this.scrollToBottom(true);
    } else {
      this.hideTypingIndicator();
    }
    this.onGeneratingChange?.(isGenerating);
  }

  // -------------------------------------------------------------------
  // Message text rendering (unchanged logic)
  // -------------------------------------------------------------------

  private renderMessageText(
    text: string,
    type: MessageType,
    mentions?: Mention[]
  ): HTMLElement {
    const { doc } = this.ctx;
    const textEl = doc.createElement("div");
    textEl.className = "message-content-text";

    const placeholderRegex = /__MENTION_(\d+)__/g;
    const commandRegex = /(?<=^|\s)\/[\w-]+(?=\s|$)/g;

    type Token =
      | { type: "mention"; start: number; end: number; index: number }
      | { type: "command"; start: number; end: number; name: string };

    const tokens: Token[] = [];
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(text)) !== null) {
      tokens.push({
        type: "mention",
        start: match.index,
        end: placeholderRegex.lastIndex,
        index: parseInt(match[1], 10),
      });
    }

    if (type === "user") {
      while ((match = commandRegex.exec(text)) !== null) {
        const commandName = match[0].substring(1);
        const command = this.availableCommands.find(
          (availableCommand) => availableCommand.name === commandName
        );
        if (command) {
          tokens.push({
            type: "command",
            start: match.index,
            end: commandRegex.lastIndex,
            name: commandName,
          });
        }
      }
    }

    tokens.sort((a, b) => a.start - b.start);

    const validTokens: Token[] = [];
    let currentEnd = 0;
    for (const token of tokens) {
      if (token.start >= currentEnd) {
        validTokens.push(token);
        currentEnd = token.end;
      }
    }

    let lastIndex = 0;
    for (const token of validTokens) {
      if (token.start > lastIndex) {
        textEl.appendChild(
          doc.createTextNode(text.substring(lastIndex, token.start))
        );
      }

      if (token.type === "mention") {
        if (mentions && mentions[token.index]) {
          textEl.appendChild(
            this.chipRenderer.renderMentionChip(mentions[token.index], true)
          );
        }
      } else if (token.type === "command") {
        const command = this.availableCommands.find(
          (availableCommand) => availableCommand.name === token.name
        )!;
        textEl.appendChild(
          this.chipRenderer.renderCommandChip(
            "/" + token.name,
            command.description,
            true
          )
        );
      }

      lastIndex = token.end;
    }

    if (lastIndex < text.length) {
      textEl.appendChild(doc.createTextNode(text.substring(lastIndex)));
    }

    return textEl;
  }

  // -------------------------------------------------------------------
  // Scroll & paint helpers (unchanged)
  // -------------------------------------------------------------------

  private announceToScreenReader(message: string): void {
    const { doc } = this.ctx;
    const announcement = doc.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.className = "sr-only";
    announcement.textContent = message;
    doc.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  private isNearMessagesBottom(): boolean {
    const { messagesEl } = this.elements;
    return (
      messagesEl.scrollHeight -
        messagesEl.scrollTop -
        messagesEl.clientHeight <=
      this.autoScrollBottomThreshold
    );
  }

  private isEventFromMessagesScrollContainer(
    target: EventTarget | null
  ): boolean {
    const { messagesEl } = this.elements;
    if (target === messagesEl) return true;
    if (!target || typeof (target as Element).closest !== "function")
      return false;

    const targetEl = target as Element;
    if (!messagesEl.contains(targetEl)) return false;

    return !targetEl.closest(
      ".diff-content, .tool-output, .diff-summary-list, .detail-input"
    );
  }

  private markUserScrollIntent(direction: UserScrollDirection): void {
    this.userScrollIntent = true;
    this.userScrollDirection = direction;
  }

  private clearDiscreteScrollIntent(): void {
    if (this.pointerScrollActive || this.touchScrollActive) return;
    this.userScrollIntent = false;
    this.userScrollDirection = "none";
  }

  private clearPointerScroll(): void {
    this.pointerScrollActive = false;
    this.clearDiscreteScrollIntent();
  }

  private clearTouchScroll(): void {
    this.touchScrollActive = false;
    this.clearDiscreteScrollIntent();
  }

  private enableAutoScroll(): void {
    this.isAutoScrollEnabled = true;
  }

  private handleMessagesScroll(): void {
    const hasUserIntent =
      this.userScrollIntent ||
      this.pointerScrollActive ||
      this.touchScrollActive;

    if (hasUserIntent) {
      const isNearBottom = this.isNearMessagesBottom();
      const direction = this.userScrollDirection;

      if (isNearBottom) {
        this.enableAutoScroll();
      } else if (this.pointerScrollActive || this.touchScrollActive) {
        this.disableAutoScroll();
      } else if (direction === "up" || direction === "unknown") {
        this.disableAutoScroll();
      }

      this.clearDiscreteScrollIntent();
    }

    this.notifyScrollPositionChange();
    this.scheduleMessagesPaintInvalidation();
  }

  getScrollPosition(): MessageScrollPosition {
    return {
      isNearBottom: this.isNearMessagesBottom(),
      scrollTop: this.elements.messagesEl.scrollTop,
    };
  }

  private notifyScrollPositionChange(): void {
    const position = this.getScrollPosition();
    for (const listener of this.scrollPositionListeners) {
      listener(position);
    }
  }

  private scheduleBottomScrollFrame(): void {
    if (this.pendingBottomScrollFrame !== null) return;

    this.pendingBottomScrollFrame = this.requestFrame(() => {
      this.pendingBottomScrollFrame = null;
      const shouldScroll =
        this.pendingBottomScrollForce || this.isAutoScrollEnabled;
      this.pendingBottomScrollForce = false;

      if (!shouldScroll) {
        this.bottomScrollSettleFrames = 0;
        this.scheduleMessagesPaintInvalidation();
        return;
      }

      this.performScrollToBottom();
      this.bottomScrollSettleFrames = Math.max(
        0,
        this.bottomScrollSettleFrames - 1
      );
      if (this.bottomScrollSettleFrames > 0 && this.isAutoScrollEnabled) {
        this.scheduleBottomScrollFrame();
      }
    });
  }

  private performScrollToBottom(): void {
    const { messagesEl } = this.elements;
    const previousScrollBehavior = messagesEl.style.scrollBehavior;
    messagesEl.style.scrollBehavior = "auto";
    messagesEl.scrollTop = messagesEl.scrollHeight;
    void messagesEl.offsetHeight;
    messagesEl.style.scrollBehavior = previousScrollBehavior;
    this.isAutoScrollEnabled = true;
    this.notifyScrollPositionChange();
    this.scheduleMessagesPaintInvalidation();
  }

  private cancelPendingBottomScroll(): void {
    if (this.pendingBottomScrollFrame !== null) {
      this.cancelFrame(this.pendingBottomScrollFrame);
      this.pendingBottomScrollFrame = null;
    }
    this.pendingBottomScrollForce = false;
    this.bottomScrollSettleFrames = 0;
  }

  private scheduleMessagesPaintInvalidation(): void {
    if (this.pendingPaintFrame !== null) return;

    this.pendingPaintFrame = this.requestFrame(() => {
      this.pendingPaintFrame = null;
      this.paintBump = !this.paintBump;
      this.elements.messagesEl.dataset.paintBump = this.paintBump ? "1" : "0";
      void this.elements.messagesEl.offsetHeight;
    });
  }

  private requestFrame(callback: FrameRequestCallback): number {
    const { win } = this.ctx;
    if (typeof win?.requestAnimationFrame === "function") {
      return win.requestAnimationFrame(callback);
    }
    return win?.setTimeout(() => callback(Date.now()), 0) ?? 0;
  }

  private cancelFrame(frame: number): void {
    const { win } = this.ctx;
    if (typeof win?.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(frame);
      return;
    }
    win?.clearTimeout(frame);
  }
}
