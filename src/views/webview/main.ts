import { marked } from "./marked-config";
import { renderToolSummary, renderToolDetails } from "./tool-render";
import { escapeHtml } from "./html-utils";
import { AsyncSerialQueue } from "../../utils/async-queue";
import { getFileIconHtml, getFolderIconHtml } from "./file-icon";
import { Dropdown } from "./widget/dropdown";
import { TooltipManager } from "./widget/tooltip";
import { showConfirmDialog } from "./widget/confirm-dialog";
import { updateContextUsageRing } from "./widget/context-usage";
import { PermissionDialog } from "./widget/permission-dialog";
import { DiffSummary } from "./widget/diff-summary";
import { PlanView } from "./widget/plan-view";
import type {
  VsCodeApi,
  Tool,
  BlockType,
  Block,
  WebviewState,
  AvailableCommand,
  PlanEntry,
  ExtensionMessage,
  Mention,
  DropdownOption,
  WebviewElements,
  UserScrollDirection,
} from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

const BOTTOM_THRESHOLD_PX = 100;
const AUTO_SCROLL_SETTLE_FRAMES = 3;

function cssEscapeAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/**
 * Maps ACP `SessionConfigOptionCategory` values to codicon class names used
 * in the dropdown trigger. Categories not listed here render without an
 * icon. Add new entries here when agents advertise new semantic categories.
 */
const CATEGORY_ICONS: Record<string, string> = {
  thought_level: "codicon-lightbulb",
};

export function updateSelectLabel(select: HTMLSelectElement): void {
  Array.from(select.options).forEach((opt) => {
    opt.textContent = opt.dataset.label || opt.textContent;
  });
}

export function getElements(doc: Document): WebviewElements {
  return {
    messagesContainerEl: doc.getElementById("messages-container")!,
    messagesEl: doc.getElementById("messages")!,
    inputEl: doc.getElementById("input")!,
    attachImageBtn: doc.getElementById("attach-image") as HTMLButtonElement,
    imagePreviewPopover: doc.getElementById("image-preview-popover")!,
    sendBtn: doc.getElementById("send") as HTMLButtonElement,
    stopBtn: doc.getElementById("stop") as HTMLButtonElement,
    modeDropdown: doc.getElementById("mode-dropdown")!,
    modelDropdown: doc.getElementById("model-dropdown")!,
    configOptionsContainer: doc.getElementById("config-options-container")!,
    contextUsageRing: doc.getElementById(
      "context-usage-ring"
    ) as HTMLDivElement,
    welcomeView: doc.getElementById("welcome-view")!,
    commandAutocomplete: doc.getElementById("command-autocomplete")!,
    planContainer: doc.getElementById("agent-plan-container")!,
    typingIndicatorEl: doc.getElementById("typing-indicator")!,
    diffSummaryContainer: doc.getElementById("diff-summary-container")!,
  };
}

export class WebviewController {
  private vscode: VsCodeApi;
  private elements: WebviewElements;
  private doc: Document;
  private win: Window;

  private currentAssistantMessage: HTMLElement | null = null;
  private activeBlock: Block | null = null;
  private blocks: Block[] = [];
  private toolBlockById: Map<string, Block> = new Map();
  private isConnected = false;
  private availableCommands: AvailableCommand[] = [];
  private fileResults: Array<{
    name: string;
    path: string;
    dir: string;
    type: "file" | "folder";
    fsPath: string;
  }> = [];
  private selectedIndex = -1;
  private autocompleteMode: "none" | "command" | "file" = "none";
  private autocompleteTriggerPos = -1;

  private modeDropdown: Dropdown;
  private modelDropdown: Dropdown;
  private configOptionDropdowns = new Map<string, Dropdown>();
  private isGenerating = false;
  private hoveredImageChip: HTMLElement | null = null;
  private starredModels = new Set<string>();
  private lastModelsMsg: ExtensionMessage["models"] = null;
  private permissionDialog: PermissionDialog;
  private diffSummary: DiffSummary;
  private planView: PlanView;
  private isAutoScrollEnabled = true;
  private pendingBottomScrollFrame: number | null = null;
  private pendingBottomScrollForce = false;
  private bottomScrollSettleFrames = 0;
  private pendingPaintFrame: number | null = null;
  private paintBump = false;
  private userScrollIntent = false;
  private pointerScrollActive = false;
  private touchScrollActive = false;
  private userScrollDirection: UserScrollDirection = "none";
  // Serializes messages from the extension host so they are processed
  // one-at-a-time in arrival order, preventing DOM update races when
  // multiple messages arrive in quick succession.
  private incomingNotifier = new AsyncSerialQueue();

  constructor(
    vscode: VsCodeApi,
    elements: WebviewElements,
    doc: Document,
    win: Window
  ) {
    this.vscode = vscode;
    this.elements = elements;
    this.doc = doc;
    this.win = win;

    this.modeDropdown = new Dropdown(this.elements.modeDropdown, (id) => {
      this.vscode.postMessage({ type: "selectMode", modeId: id });
    });

    this.modelDropdown = new Dropdown(
      this.elements.modelDropdown,
      (id) => {
        this.vscode.postMessage({ type: "selectModel", modelId: id });
      },
      (id, isStarred) => {
        this.vscode.postMessage({
          type: "toggleModelStar",
          modelId: id,
          isStarred,
        });
      }
    );

    this.permissionDialog = new PermissionDialog({
      doc: this.doc,
      vscode: this.vscode,
      getIsGenerating: () => this.isGenerating,
      setGenerating: (v) => this.setGenerating(v),
      scrollToBottom: () => this.scrollToBottom(),
      findToolBlock: (id) =>
        this.blocks.find((b) => b.type === "tool" && b.toolId === id),
    });

    this.diffSummary = new DiffSummary({
      container: this.elements.diffSummaryContainer,
      vscode: this.vscode,
      onSaveState: () => this.saveState(),
    });

    this.planView = new PlanView({
      container: this.elements.planContainer,
    });

    this.restoreState();
    this.setupEventListeners();
    this.updateViewState();
    this.adjustHeight();
    this.updateInputState();
    this.vscode.postMessage({ type: "ready" });
    new TooltipManager(this.doc, this.win).setup();
    this.setupCodeCopyHandler();
    this.setupFileLinkHandler();
    this.setupDiffHeaderClickHandler();
  }

  private setupCodeCopyHandler(): void {
    // Use event delegation on messages container to handle copy button clicks
    this.elements.messagesEl.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      const copyBtn = target.closest(".code-copy-btn") as HTMLButtonElement;

      if (!copyBtn) return;

      e.preventDefault();
      e.stopPropagation();

      // Find the pre element within the same wrapper
      const wrapper = copyBtn.closest(".code-block-wrapper");
      if (!wrapper) return;

      const pre = wrapper.querySelector("pre");
      if (!pre) return;

      // Extract text content from the pre element
      const textToCopy = pre.textContent || "";

      try {
        await navigator.clipboard.writeText(textToCopy);

        // Show success feedback by changing icon
        const icon = copyBtn.querySelector(".codicon");
        if (icon) {
          icon.classList.remove("codicon-copy");
          icon.classList.add("codicon-check");
          copyBtn.classList.add("copied");
          copyBtn.setAttribute("acp-title", "Copied!");
        }

        // Reset after 1.5 seconds
        setTimeout(() => {
          if (icon) {
            icon.classList.remove("codicon-check");
            icon.classList.add("codicon-copy");
            copyBtn.classList.remove("copied");
            // Reset tooltip based on button type
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
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    });
  }

  private setupFileLinkHandler(): void {
    // Delegated click handler for file links in markdown
    this.elements.messagesEl.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest(
        "a"
      ) as HTMLAnchorElement | null;
      if (!target) return;

      const href = target.getAttribute("href");
      if (href) {
        // Ignore anchor-only links
        if (href.startsWith("#")) return;
        // Ignore links with a scheme other than file://
        if (/^[a-zA-Z][a-zA-Z0-9.+-]*:/.test(href) && !href.startsWith("file:"))
          return;

        e.preventDefault();
        e.stopPropagation();
        this.vscode.postMessage({
          type: "openFile",
          href: href,
        });
      }
    });
  }

  private setupDiffHeaderClickHandler(): void {
    // Delegated click handler for diff headers
    this.elements.messagesEl.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest(
        ".diff-header"
      ) as HTMLElement | null;
      if (!target) return;

      const path = target.getAttribute("data-file-path");
      if (path) {
        e.preventDefault();
        e.stopPropagation();
        this.vscode.postMessage({
          type: "openFile",
          path: path,
          checkExists: true,
        });
      }
    });
  }

  private showConfirmDialog(actionLabel: string): Promise<boolean> {
    return showConfirmDialog(this.doc, actionLabel);
  }

  private updateInputState(): void {
    const text = this.elements.inputEl.textContent?.trim() || "";
    const hasMentions =
      this.elements.inputEl.querySelectorAll(".mention-chip").length > 0;

    // If the hovered image chip is no longer present, hide the preview
    if (
      this.hoveredImageChip &&
      !this.elements.inputEl.contains(this.hoveredImageChip)
    ) {
      this.hoveredImageChip = null;
      this.hideImagePreview();
    }

    // Fix for placeholder: if truly empty of text and mentions, ensure innerHTML is empty
    // to allow :empty CSS selector to work.
    if (!text && !hasMentions) {
      if (this.elements.inputEl.innerHTML !== "") {
        this.elements.inputEl.innerHTML = "";
      }
    }

    this.elements.sendBtn.disabled =
      (!text && !hasMentions) || this.isGenerating;
  }

  private updatePlaceholder(agentName: string): void {
    const placeholder = `Ask ${agentName.toLowerCase()}... (type / for commands, @ for files)`;
    this.elements.inputEl.setAttribute("data-placeholder", placeholder);
  }

  private adjustHeight(): void {
    const { inputEl } = this.elements;
    const scrollTop = inputEl.scrollTop;
    inputEl.style.height = "auto";
    const maxHeight = this.win.innerHeight / 3;
    const scrollHeight = inputEl.scrollHeight;
    const newHeight = Math.max(52, Math.min(scrollHeight, maxHeight));
    inputEl.style.height = newHeight + "px";
    inputEl.style.overflowY =
      scrollHeight > maxHeight - 1 ? "overlay" : "hidden";
    inputEl.scrollTop = scrollTop;
  }

  private restoreState(): void {
    const previousState = this.vscode.getState<WebviewState>();
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
          const newChip = this.renderMentionChip(mention, false);
          c.replaceWith(newChip);
        });
      }
      if (previousState.diffChanges) {
        this.diffSummary.setChanges(previousState.diffChanges);
      }
    }
  }

  private saveState(): void {
    this.vscode.setState<WebviewState>({
      isConnected: this.isConnected,
      inputValue: this.elements.inputEl.innerHTML || "",
      diffChanges: this.diffSummary.getChanges(),
    });
  }

  /**
   * Handle paste events from the input element.
   * Public so tests can invoke it directly without JSDOM ClipboardEvent constraints.
   *
   * For image clipboard items: extracts the image and creates a mention chip.
   * For all other content: prevents default HTML paste behavior and inserts only
   * plain text, avoiding UI misalignment and XSS injection from rich HTML.
   */
  public onPaste(e: {
    clipboardData?: {
      items: Array<{ type: string; getAsFile?: () => File | null }>;
      getData: (type: string) => string;
    };
    preventDefault: () => void;
  }): void {
    const items = e.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile?.();
          if (blob) this.handleImageAttachment(blob);
          return;
        }
      }
    }
    // For text content, extract plain text only to avoid:
    // 1. UI misalignment from rich HTML formatting
    // 2. XSS injection from malicious HTML/scripts
    e.preventDefault();
    const plainText = e.clipboardData?.getData("text/plain") ?? "";
    const selection = this.win.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = this.doc.createTextNode(plainText);
    range.insertNode(textNode);
    range.setStart(textNode, textNode.length);
    range.setEnd(textNode, textNode.length);
    selection.removeAllRanges();
    selection.addRange(range);
    this.adjustHeight();
    this.updateAutocomplete();
    this.saveState();
    this.updateInputState();
  }

  private setupEventListeners(): void {
    const { sendBtn, stopBtn, inputEl, messagesEl, attachImageBtn } =
      this.elements;

    const { commandAutocomplete } = this.elements;

    sendBtn.addEventListener("click", () => this.send());
    stopBtn.addEventListener("click", () => {
      this.vscode.postMessage({ type: "stop" });
    });

    inputEl.addEventListener("keydown", (e) => {
      const isAutocompleteVisible =
        commandAutocomplete.classList.contains("visible");

      if (isAutocompleteVisible) {
        const count =
          commandAutocomplete.querySelectorAll(".command-item").length;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.selectedIndex = Math.min(this.selectedIndex + 1, count - 1);
          this.updateAutocompleteSelection();
          this.scrollSelectedIntoView();
          return;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.updateAutocompleteSelection();
          this.scrollSelectedIntoView();
          return;
        } else if (
          e.key === "Tab" ||
          (e.key === "Enter" && this.selectedIndex >= 0)
        ) {
          e.preventDefault();
          this.selectAutocomplete(this.selectedIndex);
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.hideAutocomplete();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !this.isGenerating) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clearInput();
      }
    });

    inputEl.addEventListener("input", () => {
      this.adjustHeight();
      this.updateAutocomplete();
      this.saveState();
      this.updateInputState();
    });

    inputEl.addEventListener("paste", (e) => {
      this.onPaste(e as unknown as Parameters<typeof this.onPaste>[0]);
    });

    attachImageBtn.addEventListener("click", () => {
      const input = this.doc.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => {
        if (input.files) {
          Array.from(input.files).forEach((file) =>
            this.handleImageAttachment(file)
          );
        }
      };
      input.click();
    });

    commandAutocomplete.addEventListener("mousedown", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        e.preventDefault(); // Prevent focus loss from inputEl
      }
    });

    commandAutocomplete.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        e.stopPropagation();
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        this.selectAutocomplete(index);
      }
    });

    commandAutocomplete.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        if (this.selectedIndex !== index) {
          this.selectedIndex = index;
          this.updateAutocompleteSelection();
        }
      }
    });

    messagesEl.addEventListener("wheel", (e) => {
      if (!this.isEventFromMessagesScrollContainer(e.target)) return;
      const direction = e.deltaY < 0 ? "up" : e.deltaY > 0 ? "down" : "unknown";
      this.markUserScrollIntent(direction);
    });

    messagesEl.addEventListener("pointerdown", (e) => {
      // Treat scrollbar/container drags as scroll intent, but not clicks inside message content.
      if (
        e.target !== messagesEl ||
        !this.isEventFromMessagesScrollContainer(e.target)
      ) {
        return;
      }
      this.pointerScrollActive = true;
      this.markUserScrollIntent("unknown");
    });

    messagesEl.addEventListener("touchstart", (e) => {
      if (!this.isEventFromMessagesScrollContainer(e.target)) return;
      this.touchScrollActive = true;
    });

    messagesEl.addEventListener("touchmove", (e) => {
      if (!this.isEventFromMessagesScrollContainer(e.target)) return;
      this.touchScrollActive = true;
      this.markUserScrollIntent("unknown");
    });

    messagesEl.addEventListener("keydown", (e) => {
      if (this.isEventFromMessagesScrollContainer(e.target)) {
        if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
          this.markUserScrollIntent("up");
        } else if (
          e.key === "ArrowDown" ||
          e.key === "PageDown" ||
          e.key === "End" ||
          e.key === " "
        ) {
          this.markUserScrollIntent("down");
        }
      }

      const messages = Array.from(messagesEl.querySelectorAll(".message"));
      const currentIndex = messages.indexOf(this.doc.activeElement as Element);

      if (e.key === "ArrowDown" && currentIndex < messages.length - 1) {
        e.preventDefault();
        (messages[currentIndex + 1] as HTMLElement).focus();
      } else if (e.key === "ArrowUp" && currentIndex > 0) {
        e.preventDefault();
        (messages[currentIndex - 1] as HTMLElement).focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        (messages[0] as HTMLElement)?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        (messages[messages.length - 1] as HTMLElement)?.focus();
      }
    });

    messagesEl.addEventListener("scroll", () => this.handleMessagesScroll());

    this.win.addEventListener("pointerup", () => this.clearPointerScroll());
    this.win.addEventListener("pointercancel", () => this.clearPointerScroll());
    this.win.addEventListener("touchend", () => this.clearTouchScroll());
    this.win.addEventListener("touchcancel", () => this.clearTouchScroll());

    this.win.addEventListener("message", (e: MessageEvent<ExtensionMessage>) =>
      this.enqueueExtensionMessage(e.data)
    );
  }

  private enqueueExtensionMessage(msg: ExtensionMessage): void {
    this.incomingNotifier.enqueue(async () => {
      try {
        await this.handleMessage(msg);
      } catch (error) {
        console.error("[Webview] Error handling extension message:", error);
      }
    });
  }

  private handleImageAttachment(file: File): void {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      this.insertMentionChip({
        name: file.name,
        type: "image",
        dataUrl: base64,
      });
    };
    reader.readAsDataURL(file);
  }

  private showImagePreview(base64: string, event: MouseEvent): void {
    const { imagePreviewPopover } = this.elements;
    const img = imagePreviewPopover.querySelector("img")!;
    img.src = base64;
    imagePreviewPopover.style.display = "block";

    const x = Math.min(
      event.clientX + 10,
      this.win.innerWidth - imagePreviewPopover.offsetWidth - 20
    );
    const y = Math.max(
      20,
      event.clientY - imagePreviewPopover.offsetHeight - 10
    );
    imagePreviewPopover.style.left = x + "px";
    imagePreviewPopover.style.top = y + "px";
  }

  private hideImagePreview(): void {
    this.elements.imagePreviewPopover.style.display = "none";
  }

  private isNearMessagesBottom(): boolean {
    const { messagesEl } = this.elements;
    return (
      messagesEl.scrollHeight -
        messagesEl.scrollTop -
        messagesEl.clientHeight <=
      BOTTOM_THRESHOLD_PX
    );
  }

  private isEventFromMessagesScrollContainer(
    target: EventTarget | null
  ): boolean {
    const { messagesEl } = this.elements;
    if (target === messagesEl) {
      return true;
    }
    if (!target || typeof (target as Element).closest !== "function") {
      return false;
    }

    const targetEl = target as Element;
    if (!messagesEl.contains(targetEl)) {
      return false;
    }

    return !targetEl.closest(
      ".diff-content, .tool-output, .diff-summary-list, .detail-input"
    );
  }

  private markUserScrollIntent(direction: UserScrollDirection): void {
    this.userScrollIntent = true;
    this.userScrollDirection = direction;
  }

  private clearDiscreteScrollIntent(): void {
    if (this.pointerScrollActive || this.touchScrollActive) {
      return;
    }
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

  private disableAutoScroll(): void {
    this.isAutoScrollEnabled = false;
    this.cancelPendingBottomScroll();
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

    this.scheduleMessagesPaintInvalidation();
  }

  private scrollToBottom(force = false): void {
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
      AUTO_SCROLL_SETTLE_FRAMES
    );
    this.scheduleBottomScrollFrame();
  }

  private scheduleBottomScrollFrame(): void {
    if (this.pendingBottomScrollFrame !== null) {
      return;
    }

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
    if (this.pendingPaintFrame !== null) {
      return;
    }

    this.pendingPaintFrame = this.requestFrame(() => {
      this.pendingPaintFrame = null;
      this.paintBump = !this.paintBump;
      this.elements.messagesEl.dataset.paintBump = this.paintBump ? "1" : "0";
      void this.elements.messagesEl.offsetHeight;
    });
  }

  private requestFrame(callback: FrameRequestCallback): number {
    if (typeof this.win.requestAnimationFrame === "function") {
      return this.win.requestAnimationFrame(callback);
    }
    return this.win.setTimeout(() => callback(Date.now()), 0);
  }

  private cancelFrame(frame: number): void {
    if (typeof this.win.cancelAnimationFrame === "function") {
      this.win.cancelAnimationFrame(frame);
      return;
    }
    this.win.clearTimeout(frame);
  }

  public addMessage(
    text: string,
    type: "user" | "assistant" | "error" | "system",
    mentions?: Mention[]
  ): HTMLElement {
    const div = this.doc.createElement("div");
    div.className = "message " + type;
    div.setAttribute("role", "article");
    div.setAttribute("tabindex", "0");

    const label =
      type === "user"
        ? "Your message"
        : type === "assistant"
          ? "Agent response"
          : type === "error"
            ? "Error message"
            : "System message";
    div.setAttribute("aria-label", label);

    if (text) {
      const textEl = this.doc.createElement("div");
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
          const cmd = this.availableCommands.find(
            (c) => c.name === commandName
          );
          if (cmd) {
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
            this.doc.createTextNode(text.substring(lastIndex, token.start))
          );
        }

        if (token.type === "mention") {
          if (mentions && mentions[token.index]) {
            textEl.appendChild(
              this.renderMentionChip(mentions[token.index], true)
            );
          }
        } else if (token.type === "command") {
          const cmd = this.availableCommands.find(
            (c) => c.name === token.name
          )!;
          textEl.appendChild(
            this.renderCommandChip("/" + token.name, cmd.description, true)
          );
        }

        lastIndex = token.end;
      }

      if (lastIndex < text.length) {
        textEl.appendChild(this.doc.createTextNode(text.substring(lastIndex)));
      }

      div.appendChild(textEl);
    }

    this.elements.messagesEl.appendChild(div);
    this.scrollToBottom(type === "user");

    if (text) {
      this.announceToScreenReader(label + ": " + text.substring(0, 100));
    }

    this.updateViewState();
    return div;
  }

  private announceToScreenReader(message: string): void {
    const announcement = this.doc.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.className = "sr-only";
    announcement.textContent = message;
    this.doc.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  private resetActiveBlockTracking(): void {
    this.activeBlock = null;
    this.toolBlockById.clear();
  }

  private resetRenderedBlockTracking(): void {
    this.resetActiveBlockTracking();
    this.blocks = [];
  }

  private createBlock(options: {
    type: BlockType;
    key: string;
    toolId?: string;
  }): Block {
    const { type, key, toolId } = options;

    // Create new block
    if (!this.currentAssistantMessage) {
      this.currentAssistantMessage = this.addMessage("", "assistant");
      // If generating, move indicator to the bottom of the new message
      if (this.elements.typingIndicatorEl.classList.contains("visible")) {
        this.currentAssistantMessage.appendChild(
          this.elements.typingIndicatorEl
        );
      }
    }

    if (type === "text" && this.currentAssistantMessage) {
      // No special logic needed here as we now retrieve the last text block from the DOM
    }

    const blockEl = this.doc.createElement("div");
    blockEl.className = `block block-${type}`;
    blockEl.dataset.blockKey = key;

    let contentEl: HTMLElement;

    if (type === "thought") {
      const details = this.doc.createElement("details");
      details.className = "agent-thought";
      details.setAttribute("open", "");
      details.setAttribute("role", "status");
      details.setAttribute("aria-live", "polite");
      details.setAttribute("aria-label", "Assistant is thinking");
      details.innerHTML = `
        <summary class="thought-header">
          <span class="thought-icon"><span class="codicon codicon-lightbulb"></span></span>
          <span class="thought-title">Thinking...</span>
        </summary>
        <div class="thought-content"></div>
      `;
      blockEl.appendChild(details);
      contentEl = details.querySelector(".thought-content")!;
    } else if (type === "tool") {
      const details = this.doc.createElement("details");
      details.className = "tool-item";
      details.setAttribute("open", "");
      details.innerHTML = `
        <summary class="tool-summary">
          <span class="tool-status running"><span class="codicon codicon-loading animate-spin"></span></span>
          <span class="tool-summary-content"><span class="tool-name">Initializing...</span></span>
        </summary>
        <div class="tool-details-content"></div>
      `;
      blockEl.appendChild(details);
      contentEl = details.querySelector(".tool-details-content")!;
    } else {
      contentEl = blockEl;
    }

    // Insert block before the typing indicator if it exists within the message
    if (
      this.elements.typingIndicatorEl.parentNode ===
      this.currentAssistantMessage
    ) {
      this.currentAssistantMessage.insertBefore(
        blockEl,
        this.elements.typingIndicatorEl
      );
    } else {
      this.currentAssistantMessage.appendChild(blockEl);
    }

    const block: Block = {
      type,
      element: blockEl,
      contentEl,
      content: "",
      key,
      toolId,
    };

    this.blocks.push(block);
    return block;
  }

  private ensureBlock(type: BlockType, toolId?: string): Block {
    if (this.activeBlock && this.activeBlock.type === type) {
      if (type !== "tool" || this.activeBlock.toolId === toolId) {
        return this.activeBlock;
      }
    }

    // If we're starting a new block and had an active one, finalize the old one.
    // This ensures thoughts fold as soon as the next thing (text or tool) starts.
    if (this.activeBlock) {
      this.finalizeBlock(this.activeBlock);
    }

    const key = type === "tool" && toolId ? `tool:${toolId}` : `${type}:main`;
    const block = this.createBlock({
      type,
      key,
      toolId,
    });

    this.activeBlock = block;
    if (type === "tool" && toolId) {
      this.toolBlockById.set(toolId, block);
    }
    return block;
  }

  private ensureToolBlock(toolCallId: string): Block {
    const existing =
      this.toolBlockById.get(toolCallId) ||
      this.blocks.find((b) => b.type === "tool" && b.toolId === toolCallId);
    if (existing) {
      this.toolBlockById.set(toolCallId, existing);
      return existing;
    }

    this.finalizeActiveBlocksExcept();
    return this.ensureBlock("tool", toolCallId);
  }

  private finalizeBlock(block: Block): void {
    if (block.type === "thought") {
      const details = block.element.querySelector("details");
      if (details) {
        details.removeAttribute("open");
        const title = details.querySelector(".thought-title");
        if (title) title.textContent = "Thought Process";
      }
    } else if (block.type === "tool") {
      const details = block.element.querySelector("details");
      if (details) {
        // Don't close running tool blocks - they should stay expanded
        if (!block.status || block.status === "in_progress") {
          return;
        }

        // Keep edit/write/execute tools open if they are completed successfully
        const isWriteOrEdit = block.kind === "edit" || block.kind === "write";
        const isExecute = block.kind === "execute";

        const shouldKeepOpen =
          isWriteOrEdit || isExecute || block.status === "failed";

        if (!shouldKeepOpen) {
          details.removeAttribute("open");
        }
      }
    }
  }

  private finalizeBlocks(): void {
    this.blocks.forEach((block) => {
      this.finalizeBlock(block);
    });
    this.activeBlock = null;
  }

  private finalizeActiveBlocksExcept(blockToKeep?: Block): void {
    if (this.activeBlock && this.activeBlock !== blockToKeep) {
      this.finalizeBlock(this.activeBlock);
      this.activeBlock = null;
    }
  }

  private clearStaleRunningToolIndicators(): void {
    this.blocks
      .filter((block) => block.type === "tool")
      .forEach((block) => {
        const runningStatus = block.element.querySelector(
          ".tool-status.running"
        );
        if (!runningStatus) {
          return;
        }

        runningStatus.remove();
        block.status = block.status || "completed";
        this.finalizeBlock(block);
      });
  }

  public showThinking(): void {
    this.ensureBlock("thought");
  }

  public hideThinking(): void {
    if (this.activeBlock && this.activeBlock.type === "thought") {
      this.finalizeBlock(this.activeBlock);
      this.activeBlock = null;
    }
  }

  public appendThought(text: string): void {
    const block = this.ensureBlock("thought");
    block.content += text;
    block.contentEl.innerHTML = marked.parse(block.content) as string;
    this.scrollToBottom();
  }

  public hideThought(): void {
    this.hideThinking();
  }

  public getTools(): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    this.blocks
      .filter((b) => b.type === "tool" && b.toolId)
      .forEach((b) => {
        const isRunning =
          b.element.querySelector(".tool-status.running") !== null;

        // Handle new detail-input or old tool-input
        const detailInput = b.element.querySelector(".detail-input");
        const toolInput = b.element.querySelector(".tool-input");
        let inputText = "";

        if (detailInput) {
          // In new structure, command is often prefixed with $ in a div
          const cmdDiv = detailInput.querySelector("div");
          if (cmdDiv && cmdDiv.textContent?.startsWith("$ ")) {
            inputText = cmdDiv.textContent.substring(2);
          } else {
            inputText = detailInput.textContent || "";
          }
        } else if (toolInput) {
          inputText = toolInput.textContent || "";
        }

        const input = inputText.startsWith("$ ")
          ? inputText.substring(2)
          : inputText.startsWith("$")
            ? inputText.substring(1).trim()
            : inputText;

        // Clean up name which might contain duration
        let name = b.element.querySelector(".tool-name")?.textContent || "Tool";
        if (name.includes(" | ")) {
          name = name.split(" | ")[0];
        }

        tools[b.toolId!] = {
          id: b.toolId!,
          name: name,
          input: input || null,
          output: b.element.querySelector(".tool-output")?.textContent || null,
          status: isRunning ? "running" : "completed",
          kind: b.kind,
        };
      });
    return tools;
  }

  public updateStatus(state: string): void {
    this.isConnected = state === "connected";
    this.updateViewState();
    this.saveState();
  }

  updateViewState(): void {
    const hasMessages = this.elements.messagesEl.children.length > 0;
    this.elements.welcomeView.style.display = !hasMessages ? "flex" : "none";
    this.elements.messagesContainerEl.style.display = hasMessages
      ? "flex"
      : "none";
  }

  showPlan(entries: PlanEntry[]): void {
    this.planView.show(entries);
  }

  hidePlan(): void {
    this.planView.hide();
  }

  private send(): void {
    if (this.isGenerating) return;
    const inputEl = this.elements.inputEl;
    const mentions: Mention[] = [];
    const images: string[] = [];
    let text = "";

    inputEl.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.classList.contains("mention-chip")) {
          const type = el.dataset.type as Mention["type"];
          const dataUrl = el.dataset.dataUrl;

          const mention: Mention = {
            name: el.dataset.name || "",
            path: el.dataset.path,
            type,
            content: el.dataset.content,
            dataUrl,
            range: el.dataset.range
              ? {
                  startLine: parseInt(el.dataset.range.split("-")[0], 10),
                  endLine: parseInt(el.dataset.range.split("-")[1], 10),
                }
              : undefined,
          };

          if (type === "image" && dataUrl) {
            images.push(dataUrl);
          }

          const idx = mentions.length;
          mentions.push(mention);
          text += `__MENTION_${idx}__`;
        } else if (el.classList.contains("command-chip")) {
          text += el.dataset.command || "";
        } else if (el.tagName === "BR") {
          text += "\n";
        } else {
          text += el.textContent;
        }
      }
    });

    text = text.trim();
    if (!text && images.length === 0) return;

    this.scrollToBottom(true);

    this.vscode.postMessage({
      type: "sendMessage",
      text,
      images,
      mentions,
    });

    this.clearInput();
    this.elements.sendBtn.disabled = true;
    this.saveState();
  }

  private clearInput(): void {
    this.elements.inputEl.innerHTML = "";
    this.adjustHeight();
    this.elements.inputEl.focus();
    this.hideAutocomplete();
    this.hideImagePreview();
    this.saveState();
    this.updateInputState();
  }

  getFilteredCommands(query: string): AvailableCommand[] {
    if (!query.startsWith("/")) return [];
    const search = query.slice(1).toLowerCase();
    return this.availableCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().startsWith(search) ||
        cmd.description?.toLowerCase().includes(search)
    );
  }

  private getGlobalCursorOffset(): number {
    const selection = this.win.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);

    // Support for test mocks where startContainer might not be a real Node
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(range.startContainer instanceof (this.win as any).Node)) {
      return range.startOffset;
    }

    try {
      const preRange = range.cloneRange();
      preRange.selectNodeContents(this.elements.inputEl);
      preRange.setEnd(range.startContainer, range.startOffset);
      return preRange.toString().length;
    } catch {
      // Fallback for edge cases or complex DOM structures
      return range.startOffset;
    }
  }

  private getNodeAtOffset(
    parent: Node,
    offset: number
  ): { node: Node; offset: number } {
    const walker = this.doc.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.textContent?.length || 0;
      if (currentOffset + length >= offset) {
        return { node, offset: offset - currentOffset };
      }
      currentOffset += length;
    }
    return { node: parent, offset: 0 };
  }

  private updateAutocomplete(): void {
    const selection = this.win.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const useMockFallback =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !(range.startContainer instanceof (this.win as any).Node) &&
      typeof range.startContainer.textContent === "string";

    const fullText = this.elements.inputEl.textContent || "";
    const globalOffset = this.getGlobalCursorOffset();

    const textBefore = useMockFallback
      ? range.startContainer.textContent!.slice(0, range.startOffset)
      : fullText.slice(0, globalOffset);

    const lastSlashIdx = textBefore.lastIndexOf("/");
    const lastAtIdx = textBefore.lastIndexOf("@");

    // 触发条件：必须是起始位置或者前面是空格
    const isSlashTrigger =
      lastSlashIdx >= 0 &&
      (lastSlashIdx === 0 || textBefore[lastSlashIdx - 1] === " ");
    const isAtTrigger =
      lastAtIdx >= 0 && (lastAtIdx === 0 || textBefore[lastAtIdx - 1] === " ");

    if (
      isSlashTrigger &&
      lastSlashIdx >= lastAtIdx &&
      !textBefore.slice(lastSlashIdx).includes(" ")
    ) {
      this.autocompleteMode = "command";
      this.autocompleteTriggerPos = lastSlashIdx;

      const query = textBefore.slice(lastSlashIdx);
      const filtered = this.getFilteredCommands(query);
      this.selectedIndex = filtered.length > 0 ? 0 : -1;
      this.renderAutocomplete();
    } else if (isAtTrigger && !textBefore.slice(lastAtIdx).includes(" ")) {
      this.autocompleteMode = "file";
      this.autocompleteTriggerPos = lastAtIdx;
      const query = textBefore.slice(lastAtIdx + 1);
      this.selectedIndex = 0;
      this.vscode.postMessage({ type: "searchFiles", text: query });
    } else {
      this.hideAutocomplete();
    }
  }

  private renderAutocomplete(): void {
    const { commandAutocomplete } = this.elements;

    let itemsHtml = "";
    if (this.autocompleteMode === "command") {
      const text = this.elements.inputEl.textContent || "";
      const query = text.slice(this.autocompleteTriggerPos).split(/\s/)[0];
      const commands = this.getFilteredCommands(query);
      if (commands.length === 0) {
        this.hideAutocomplete();
        return;
      }
      itemsHtml = commands
        .map((cmd, i) => this.renderCommandItem(cmd, i))
        .join("");
    } else if (this.autocompleteMode === "file") {
      if (this.fileResults.length === 0) {
        this.hideAutocomplete();
        return;
      }
      itemsHtml = this.fileResults
        .map((file, i) => this.renderFileItem(file, i))
        .join("");
    }

    if (itemsHtml) {
      commandAutocomplete.innerHTML = itemsHtml;
      commandAutocomplete.classList.add("visible");
      this.elements.inputEl.setAttribute("aria-expanded", "true");
    } else {
      this.hideAutocomplete();
    }
  }

  private renderCommandItem(cmd: AvailableCommand, i: number): string {
    const hint = cmd.input?.hint
      ? '<div class="command-hint">' + escapeHtml(cmd.input.hint) + "</div>"
      : "";
    return `
      <div class="command-item ${i === this.selectedIndex ? "selected" : ""}" data-index="${i}" role="option" aria-selected="${i === this.selectedIndex}">
        <div class="command-content">
          <div class="command-name"><span class="trigger-char">/</span>${escapeHtml(cmd.name)}</div>
          ${cmd.description ? '<div class="command-description">' + escapeHtml(cmd.description) + "</div>" : ""}
          ${hint}
        </div>
      </div>
    `;
  }

  private renderFileItem(
    file: {
      name: string;
      path: string;
      dir: string;
      type: "file" | "folder";
      fsPath: string;
    },
    i: number
  ): string {
    const isFolder = file.type === "folder";
    const iconHtml = isFolder
      ? getFolderIconHtml(file.name)
      : getFileIconHtml(file.name);

    // 单行显示：文件名 + 路径
    const displayPath = file.dir ? escapeHtml(file.dir + "/") : "";

    return `
      <div class="command-item ${i === this.selectedIndex ? "selected" : ""}" data-index="${i}" role="option" aria-selected="${i === this.selectedIndex}" data-fspath="${escapeHtml(file.fsPath)}">
        <div class="command-icon">${iconHtml}</div>
        <div class="command-content">
          <div class="command-name">
            <span class="file-name">${escapeHtml(file.name)}</span>
            ${displayPath ? '<span class="file-path">' + displayPath + "</span>" : ""}
          </div>
        </div>
      </div>
    `;
  }

  private scrollSelectedIntoView(): void {
    const { commandAutocomplete } = this.elements;
    const selectedItem = commandAutocomplete.querySelector(
      ".command-item.selected"
    );
    if (selectedItem && typeof selectedItem.scrollIntoView === "function") {
      selectedItem.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  private updateAutocompleteSelection(): void {
    const { commandAutocomplete } = this.elements;
    const items = commandAutocomplete.querySelectorAll(".command-item");
    items.forEach((item, i) => {
      if (i === this.selectedIndex) {
        item.classList.add("selected");
        item.setAttribute("aria-selected", "true");
      } else {
        item.classList.remove("selected");
        item.setAttribute("aria-selected", "false");
      }
    });
  }

  hideAutocomplete(): void {
    const { commandAutocomplete, inputEl } = this.elements;
    commandAutocomplete.classList.remove("visible");
    commandAutocomplete.innerHTML = "";
    this.selectedIndex = -1;
    this.autocompleteMode = "none";
    inputEl.setAttribute("aria-expanded", "false");
  }

  private selectAutocomplete(index: number): void {
    if (this.autocompleteMode === "command") {
      const text = this.elements.inputEl.textContent || "";
      const query = text.slice(this.autocompleteTriggerPos).split(/\s/)[0];
      const commands = this.getFilteredCommands(query);
      if (index >= 0 && index < commands.length) {
        const cmd = commands[index];
        this.insertCommandChip("/" + cmd.name, cmd.description);
      }
    } else if (this.autocompleteMode === "file") {
      if (index >= 0 && index < this.fileResults.length) {
        const file = this.fileResults[index];
        this.insertMentionChip({
          name: file.name,
          path: file.fsPath,
          type: file.type,
        });
      }
    }
    this.hideAutocomplete();
  }

  private replaceTriggerWithText(newText: string): void {
    const selection = this.win.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const useMockFallback = !(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (range.startContainer instanceof (this.win as any).Node)
    );

    if (!useMockFallback) {
      const { node, offset } = this.getNodeAtOffset(
        this.elements.inputEl,
        this.autocompleteTriggerPos
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (node.nodeType === (this.win as any).Node.TEXT_NODE) {
        range.setStart(node, offset);
        range.deleteContents();
        const textNode = this.doc.createTextNode(newText);
        range.insertNode(textNode);

        if (typeof range.setStart === "function") {
          range.setStart(textNode, textNode.length);
          range.collapse(true);
        }

        if (typeof selection.removeAllRanges === "function") {
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (typeof selection.collapseToEnd === "function") {
          selection.collapseToEnd();
        }
      } else {
        console.warn(
          "Could not find text node for autocomplete replacement at offset",
          this.autocompleteTriggerPos
        );
      }
    } else {
      // Fallback for test mocks
      range.setStart(range.startContainer, this.autocompleteTriggerPos);
      range.deleteContents();
      range.insertNode(this.doc.createTextNode(newText));
      selection.collapseToEnd();
    }

    this.elements.inputEl.focus();
    this.adjustHeight();
  }

  private renderMentionChip(mention: Mention, readonly = false): HTMLElement {
    const chip = this.doc.createElement("span");
    chip.className = "mention-chip" + (readonly ? " readonly" : "");
    chip.contentEditable = "false";

    chip.dataset.name = mention.name;
    if (mention.path) chip.dataset.path = mention.path;
    chip.dataset.type = mention.type || "file";
    if (mention.content) chip.dataset.content = mention.content;
    if (mention.range)
      chip.dataset.range = `${mention.range.startLine}-${mention.range.endLine}`;
    if (mention.dataUrl) chip.dataset.dataUrl = mention.dataUrl;

    const mentionType = mention.type || "file";
    const filename = mention.path
      ? mention.path.split(/[/\\]/).pop() || mention.name
      : mention.name.split(/[/\\]/).pop() || mention.name;

    let displayLabel = filename;
    if (mention.range) {
      displayLabel += `:${mention.range.startLine}-${mention.range.endLine}`;
    }

    const typeConfigs: Record<
      string,
      {
        iconHtml: string;
        onClick?: (e: MouseEvent) => void;
        onHover?: (e: MouseEvent) => void;
      }
    > = {
      file: {
        iconHtml: getFileIconHtml(filename),
        onClick: (e) => {
          if (mention.path) {
            e.stopPropagation();
            this.vscode.postMessage({
              type: "openFile",
              path: mention.path,
              range: mention.range,
            });
          }
        },
      },
      folder: {
        iconHtml: getFolderIconHtml(filename),
        onClick: (e) => {
          if (mention.path) {
            e.stopPropagation();
            this.vscode.postMessage({ type: "openFile", path: mention.path });
          }
        },
      },
      selection: {
        iconHtml: getFileIconHtml(filename),
        onClick: (e) => {
          if (mention.path) {
            e.stopPropagation();
            this.vscode.postMessage({
              type: "openFile",
              path: mention.path,
              range: mention.range,
            });
          }
        },
      },
      terminal: {
        iconHtml: `<span class="codicon codicon-terminal"></span>`,
      },
      image: {
        iconHtml: getFileIconHtml(filename),
        onHover: (e) => {
          if (mention.dataUrl) {
            if (!readonly) this.hoveredImageChip = chip;
            this.showImagePreview(mention.dataUrl, e);
          }
        },
      },
    };

    const config = typeConfigs[mentionType] || typeConfigs.file;

    chip.innerHTML = `<span class="chip-icon">${config.iconHtml}</span><span class="chip-label">${escapeHtml(displayLabel)}</span>`;

    if (config.onClick) {
      chip.addEventListener("click", config.onClick);
    }

    if (config.onHover) {
      chip.addEventListener("mouseenter", (e) => config.onHover!(e));
      chip.addEventListener("mouseleave", (e) => {
        if (!readonly) {
          // Don't hide if moving to a child element (like the delete button)
          if (
            e.relatedTarget instanceof Node &&
            chip.contains(e.relatedTarget as Node)
          ) {
            return;
          }
          this.hoveredImageChip = null;
        }
        this.hideImagePreview();
      });
    }

    return chip;
  }
  private renderCommandChip(
    command: string,
    description?: string,
    readonly = false
  ): HTMLElement {
    const chip = this.doc.createElement("span");
    chip.className = "command-chip" + (readonly ? " readonly" : "");
    chip.contentEditable = "false";
    chip.dataset.command = command;
    if (description) chip.setAttribute("acp-title", description);

    const displayLabel = command.startsWith("/")
      ? command.substring(1)
      : command;
    chip.innerHTML = `<span class="chip-prefix">/</span><span class="chip-label">${escapeHtml(
      displayLabel
    )}</span>`;

    return chip;
  }

  private insertCommandChip(command: string, description?: string): void {
    const selection = this.win.getSelection();
    if (!selection) return;

    let range: Range;
    if (this.autocompleteMode !== "none" && selection.rangeCount > 0) {
      range = selection.getRangeAt(0);

      const useMockFallback = !(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (range.startContainer instanceof (this.win as any).Node)
      );

      if (!useMockFallback) {
        const { node, offset } = this.getNodeAtOffset(
          this.elements.inputEl,
          this.autocompleteTriggerPos
        );
        range.setStart(node, offset);
      } else {
        range.setStart(range.startContainer, this.autocompleteTriggerPos);
      }
      range.deleteContents();
    } else {
      this.elements.inputEl.focus();
      const currentSelection = this.win.getSelection();
      if (!currentSelection || currentSelection.rangeCount === 0) {
        range = this.doc.createRange();
        range.selectNodeContents(this.elements.inputEl);
        range.collapse(false);
      } else {
        range = currentSelection.getRangeAt(0);
      }
    }

    const chip = this.renderCommandChip(command, description, false);
    range.insertNode(chip);

    const space = this.doc.createTextNode(" ");
    range.setStartAfter(chip);
    range.insertNode(space);

    const selectionAfter = this.win.getSelection();
    if (selectionAfter) {
      selectionAfter.removeAllRanges();
      const newRange = this.doc.createRange();
      newRange.setStart(space, space.length);
      newRange.collapse(true);
      selectionAfter.addRange(newRange);
    }

    this.elements.inputEl.focus();
    this.saveState();
    this.updateInputState();
  }

  private insertMentionChip(mention: Mention): void {
    const selection = this.win.getSelection();
    if (!selection) return;

    let range: Range;
    if (this.autocompleteMode !== "none" && selection.rangeCount > 0) {
      range = selection.getRangeAt(0);

      const useMockFallback = !(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (range.startContainer instanceof (this.win as any).Node)
      );

      if (!useMockFallback) {
        const { node, offset } = this.getNodeAtOffset(
          this.elements.inputEl,
          this.autocompleteTriggerPos
        );
        range.setStart(node, offset);
      } else {
        range.setStart(range.startContainer, this.autocompleteTriggerPos);
      }
      range.deleteContents();
    } else {
      this.elements.inputEl.focus();
      const currentSelection = this.win.getSelection();
      if (!currentSelection || currentSelection.rangeCount === 0) {
        // If no range, insert at end
        range = this.doc.createRange();
        range.selectNodeContents(this.elements.inputEl);
        range.collapse(false);
      } else {
        range = currentSelection.getRangeAt(0);
      }
    }

    const chip = this.renderMentionChip(mention, false);

    range.insertNode(chip);

    // After inserting the chip, insert a space and move the cursor
    const space = this.doc.createTextNode(" ");
    range.setStartAfter(chip);
    range.insertNode(space);

    const selectionAfter = this.win.getSelection();
    if (selectionAfter) {
      selectionAfter.removeAllRanges();
      const newRange = this.doc.createRange();
      newRange.setStart(space, space.length);
      newRange.collapse(true);
      selectionAfter.addRange(newRange);
    }

    this.elements.inputEl.focus();
    this.saveState();
    this.updateInputState();
    this.adjustHeight();
  }

  private renderActionButtons(messageEl: HTMLElement): void {
    if (!messageEl || messageEl.querySelector(".message-actions")) {
      return;
    }

    const actionsContainer = this.doc.createElement("div");
    actionsContainer.className = "message-actions";

    const createBtn = (
      icon: string,
      title: string,
      onClick: (btn: HTMLElement, iconEl: HTMLElement) => void
    ) => {
      const btn = this.doc.createElement("button");
      btn.className = "action-btn";
      btn.setAttribute("acp-title", title);
      const iconEl = this.doc.createElement("span");
      iconEl.className = `codicon codicon-${icon}`;
      btn.appendChild(iconEl);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(btn, iconEl);
      });
      return btn;
    };

    const getFinalText = () => {
      const textBlocks = messageEl.querySelectorAll(".block-text");
      if (textBlocks.length > 0) {
        const lastBlock = textBlocks[textBlocks.length - 1] as HTMLElement;
        return (
          lastBlock.getAttribute("data-raw-content") ||
          lastBlock.innerText ||
          ""
        );
      }
      const textEl = messageEl.querySelector(
        ".message-content-text"
      ) as HTMLElement;
      return textEl?.innerText || "";
    };

    // Copy Button
    const copyBtn = createBtn("copy", "Copy response", async (btn, iconEl) => {
      const text = getFinalText();
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
          const originalClass = iconEl.className;
          iconEl.className = "codicon codicon-check";
          setTimeout(() => {
            iconEl.className = originalClass;
          }, 1500);
        } catch (err) {
          console.error("Failed to copy:", err);
        }
      }
    });

    // Paste to Input Button
    const pasteBtn = createBtn("edit", "Copy to input", () => {
      const text = getFinalText();
      if (text) {
        this.elements.inputEl.textContent = text;
        this.adjustHeight();
        this.saveState();
        this.updateInputState();
        this.elements.inputEl.focus();

        const range = this.doc.createRange();
        const sel = this.win.getSelection();
        range.selectNodeContents(this.elements.inputEl);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });

    // Scroll to Top Button
    const topBtn = createBtn("arrow-up", "Scroll to top", () => {
      this.disableAutoScroll();
      this.elements.messagesEl.scrollTo({ top: 0, behavior: "smooth" });
    });

    // Scroll to Recent User Input Button
    const userBtn = createBtn("reply", "Scroll to user question", () => {
      this.disableAutoScroll();
      const allMessages = Array.from(
        this.elements.messagesEl.querySelectorAll(".message")
      );
      const currentIdx = allMessages.indexOf(messageEl);
      if (currentIdx > 0) {
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (allMessages[i].classList.contains("user")) {
            allMessages[i].scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
            break;
          }
        }
      }
    });

    actionsContainer.appendChild(copyBtn);
    actionsContainer.appendChild(pasteBtn);
    actionsContainer.appendChild(topBtn);
    actionsContainer.appendChild(userBtn);

    messageEl.appendChild(actionsContainer);
  }

  private setGenerating(isGenerating: boolean): void {
    this.isGenerating = isGenerating;
    const { typingIndicatorEl, messagesEl, sendBtn, stopBtn } = this.elements;
    if (isGenerating) {
      sendBtn.style.display = "none";
      stopBtn.style.display = "flex";
      typingIndicatorEl.classList.add("visible");
      // Move indicator to the end of the current assistant message if it exists,
      // otherwise to the end of the messages container
      if (this.currentAssistantMessage) {
        this.currentAssistantMessage.appendChild(typingIndicatorEl);
      } else {
        messagesEl.appendChild(typingIndicatorEl);
      }
      this.scrollToBottom(true);
    } else {
      sendBtn.style.display = "flex";
      stopBtn.style.display = "none";
      typingIndicatorEl.classList.remove("visible");
      this.updateInputState();
    }
  }

  private updateContextUsageRing(msg: ExtensionMessage): void {
    updateContextUsageRing(this.elements.contextUsageRing, {
      used: msg.used,
      size: msg.size,
      cost: msg.cost,
    });
  }

  async handleMessage(msg: ExtensionMessage): Promise<void> {
    switch (msg.type) {
      case "fileSearchResults":
        if (msg.results) {
          this.fileResults = msg.results;
          this.selectedIndex = this.fileResults.length > 0 ? 0 : -1;
          this.renderAutocomplete();
        }
        break;
      case "userMessage":
        // Always reset assistant state before a new turn, regardless of content
        // This ensures subsequent streamChunk creates a new assistant message and prevents turn merging
        this.currentAssistantMessage = null;
        this.resetActiveBlockTracking();

        if (msg.text || (msg.images && msg.images.length > 0)) {
          this.addMessage(msg.text || "", "user", msg.mentions);
        }
        break;
      case "addMention":
        if (msg.mention) {
          this.insertMentionChip(msg.mention);
        }
        break;
      case "streamStart":
        this.currentAssistantMessage = null;
        this.resetRenderedBlockTracking();
        this.setGenerating(true);
        break;
      case "streamChunk":
        if (msg.text) {
          const block = this.ensureBlock("text");
          block.content += msg.text;
          block.contentEl.innerHTML = marked.parse(block.content) as string;
          // Store raw content on the element for reliable retrieval by action buttons
          block.element.setAttribute("data-raw-content", block.content);
          this.scrollToBottom();
        }
        break;

      case "thoughtChunk":
        if (msg.text) {
          const block = this.ensureBlock("thought");
          block.content += msg.text;
          block.contentEl.innerHTML = marked.parse(block.content) as string;
          this.scrollToBottom();
        }
        break;
      case "streamEnd":
        this.clearStaleRunningToolIndicators();
        this.finalizeBlocks();
        this.setGenerating(false);
        if (this.currentAssistantMessage) {
          this.renderActionButtons(this.currentAssistantMessage);
          this.currentAssistantMessage = null; // Clear to ensure next turn starts a new message
        }
        this.elements.inputEl.focus();
        this.scrollToBottom();
        break;
      case "toolCallStart":
        if (msg.toolCallId && msg.name) {
          const block = this.ensureToolBlock(msg.toolCallId);
          if (block) {
            if (msg.kind) block.kind = msg.kind;
            if (msg.name) block.title = msg.name;

            const summary = block.element.querySelector("summary");
            if (summary) {
              const summaryContent = summary.querySelector(
                ".tool-summary-content"
              );
              if (summaryContent) {
                const summaryHtml = renderToolSummary({
                  toolCallId: msg.toolCallId,
                  title: msg.name || block.title || "Tool",
                  kind: msg.kind || block.kind,
                  status: "in_progress",
                  rawInput: msg.rawInput,
                });
                summaryContent.innerHTML = summaryHtml;
              }
            }
          }
          this.scrollToBottom();
        }
        break;
      case "toolCallComplete":
        if (msg.toolCallId) {
          const block = this.ensureToolBlock(msg.toolCallId);
          if (block) {
            // Update metadata from completion message
            if (msg.kind) block.kind = msg.kind;
            if (msg.title) block.title = msg.title;
            if (msg.status) block.status = msg.status;

            const finalTitle =
              msg.title || block.title || block.toolId || "Tool";
            const summary = block.element.querySelector("summary");
            if (summary) {
              // Remove spinner on completion
              summary.querySelector(".tool-status.running")?.remove();

              const summaryContent = summary.querySelector(
                ".tool-summary-content"
              );
              if (summaryContent) {
                const summaryHtml = renderToolSummary({
                  toolCallId: msg.toolCallId,
                  title: finalTitle,
                  kind: msg.kind || block.kind,
                  status: msg.status || "completed",
                  locations: msg.locations,
                  rawInput: msg.rawInput,
                  duration: msg.duration,
                });
                summaryContent.innerHTML = summaryHtml;
              }

              summary.querySelector(".tool-status.failed")?.remove();
              if (msg.status === "failed") {
                const failIcon = this.doc.createElement("span");
                failIcon.className = "tool-status failed";
                failIcon.innerHTML =
                  '<span class="codicon codicon-close"></span>';
                summary.appendChild(failIcon);
              }
            }

            // Update tool-item class based on status
            const toolItem = block.element.querySelector(".tool-item");
            if (toolItem) {
              toolItem.classList.remove("tool-failed");
              if (msg.status === "failed") {
                toolItem.classList.add("tool-failed");
              }
            }

            const detailsHtml = renderToolDetails({
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
            });
            block.contentEl.innerHTML = detailsHtml;

            this.finalizeBlock(block);
            this.scrollToBottom();
          }
        }
        break;
      case "error":
        if (msg.text) this.addMessage(msg.text, "error");
        this.setGenerating(false);
        this.elements.inputEl.focus();
        break;
      case "agentError":
        if (msg.text) this.addMessage(msg.text, "error");
        break;
      case "system":
        if (msg.text) this.addMessage(msg.text, "system");
        break;
      case "connectionState":
        if (msg.state) {
          this.updateStatus(msg.state);
        }
        break;
      case "agentChanged":
        if (msg.agentName) {
          this.updatePlaceholder(msg.agentName);
        }
        this.diffSummary.clear();
      // fallthrough
      case "chatCleared":
        this.elements.messagesEl.innerHTML = "";
        this.currentAssistantMessage = null;
        this.resetRenderedBlockTracking();
        this.hideAutocomplete();
        this.planView.hide();
        this.diffSummary.clear();
        this.updateViewState();
        break;
      case "triggerNewChat":
        this.vscode.postMessage({ type: "newChat" });
        break;
      case "triggerClearChat":
        this.vscode.postMessage({ type: "clearChat" });
        break;
      case "confirmAction": {
        const actionLabel = msg.actionLabel || msg.action || "this action";
        const confirmed = await this.showConfirmDialog(actionLabel);
        this.vscode.postMessage({
          type: "confirmActionResponse",
          requestId: msg.requestId,
          confirmed,
        });
        break;
      }
      case "sessionMetadata": {
        const hasModes =
          msg.modes &&
          msg.modes.availableModes &&
          msg.modes.availableModes.length > 0;
        const hasModels =
          msg.models &&
          msg.models.availableModels &&
          msg.models.availableModels.length > 0;

        if (Array.isArray(msg.starredModels)) {
          this.starredModels = new Set(msg.starredModels);
        }

        if (hasModes && msg.modes) {
          this.elements.modeDropdown.style.display = "flex";
          this.modeDropdown.setOptions(
            msg.modes.availableModes.map((m) => ({
              id: m.id,
              name: m.name || m.id,
            })),
            msg.modes.currentModeId
          );
        } else {
          this.elements.modeDropdown.style.display = "none";
        }

        if (hasModels && msg.models) {
          this.elements.modelDropdown.style.display = "flex";
          this.lastModelsMsg = msg.models;
          this.updateModelDropdown(msg.models);
        } else {
          this.elements.modelDropdown.style.display = "none";
          this.lastModelsMsg = null;
        }

        this.renderGenericConfigOptions(msg.genericConfigOptions ?? []);

        if (msg.commands && Array.isArray(msg.commands)) {
          this.availableCommands = msg.commands;
        }
        break;
      }
      case "modeUpdate":
        if (msg.modeId) {
          this.modeDropdown.setValue(msg.modeId);
        }
        break;
      case "modelUpdate":
        if (msg.modelId) {
          this.modelDropdown.setValue(msg.modelId);
        }
        break;
      case "availableCommands":
        if (msg.commands && Array.isArray(msg.commands)) {
          this.availableCommands = msg.commands;
        }
        break;
      case "plan":
        if (msg.plan && msg.plan.entries) {
          this.planView.show(msg.plan.entries);
        }
        break;
      case "planComplete":
        this.planView.hide();
        break;
      case "diffSummary":
        if (msg.changes) {
          this.diffSummary.setChanges(msg.changes);
          this.saveState();
        }
        break;
      case "contextUsage":
        this.updateContextUsageRing(msg);
        break;
      case "permissionRequest":
        if (msg.requestId && msg.toolCall && msg.options) {
          this.permissionDialog.show(
            msg.requestId,
            msg.toolCall,
            msg.options,
            msg.toolCallId
          );
        }
        break;
    }
  }

  private updateModelDropdown(
    modelsMsg: NonNullable<ExtensionMessage["models"]>
  ): void {
    const options: DropdownOption[] = [];
    const availableModels = modelsMsg.availableModels || [];

    const starred = availableModels.filter((m) =>
      this.starredModels.has(m.modelId)
    );

    if (starred.length > 0) {
      options.push({ id: "header-starred", name: "Starred", type: "header" });
      starred.forEach((m) => {
        options.push({
          id: m.modelId,
          name: m.name || m.modelId,
          isStarred: true,
          canStar: true,
        });
      });
      options.push({ id: "divider-1", name: "", type: "divider" });
      options.push({ id: "header-all", name: "All Models", type: "header" });
    }

    availableModels.forEach((m) => {
      options.push({
        id: m.modelId,
        name: m.name || m.modelId,
        isStarred: this.starredModels.has(m.modelId),
        canStar: true,
      });
    });

    this.modelDropdown.setOptions(options, modelsMsg.currentModelId);
  }

  private renderGenericConfigOptions(
    options: NonNullable<ExtensionMessage["genericConfigOptions"]>
  ): void {
    const container = this.elements.configOptionsContainer;
    const incomingIds = new Set(options.map((o) => o.id));

    for (const id of this.configOptionDropdowns.keys()) {
      if (!incomingIds.has(id)) {
        const el = container.querySelector<HTMLElement>(
          `[data-config-id="${cssEscapeAttr(id)}"]`
        );
        if (el) el.remove();
        this.configOptionDropdowns.delete(id);
      }
    }

    for (const opt of options) {
      const safeId = opt.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      let wrapper = container.querySelector<HTMLElement>(
        `[data-config-id="${cssEscapeAttr(opt.id)}"]`
      );

      if (!wrapper) {
        wrapper = this.createGenericConfigOptionElement(opt, safeId);
        container.appendChild(wrapper);
      }

      const dropdown = this.ensureConfigOptionDropdown(opt.id, wrapper);
      const titleText = opt.description
        ? `${opt.name}\n${opt.description}`
        : opt.name;
      dropdown.setCustomTitle(titleText);
      dropdown.setOptions(
        opt.options.map((o) => ({ id: o.value, name: o.name || o.value })),
        opt.currentValue
      );
    }
  }

  private createGenericConfigOptionElement(
    opt: NonNullable<ExtensionMessage["genericConfigOptions"]>[number],
    safeId: string
  ): HTMLElement {
    const wrapper = this.doc.createElement("div");
    wrapper.className = "custom-dropdown";
    wrapper.setAttribute("data-config-id", opt.id);
    wrapper.id = `config-option-${safeId}`;
    wrapper.style.display = "flex";

    const trigger = this.doc.createElement("div");
    trigger.className = "dropdown-trigger";

    const iconClass = opt.category ? CATEGORY_ICONS[opt.category] : undefined;
    if (iconClass) {
      const icon = this.doc.createElement("span");
      icon.className = `dropdown-icon codicon ${iconClass}`;
      icon.setAttribute("aria-hidden", "true");
      trigger.appendChild(icon);
    }

    const label = this.doc.createElement("span");
    label.className = "selected-label";
    label.textContent = opt.name || opt.id;
    trigger.appendChild(label);

    const chevron = this.doc.createElement("span");
    chevron.className = "dropdown-chevron";
    const chevronIcon = this.doc.createElement("span");
    chevronIcon.className = "codicon codicon-chevron-down";
    chevron.appendChild(chevronIcon);
    trigger.appendChild(chevron);

    const popover = this.doc.createElement("div");
    popover.className = "dropdown-popover";

    wrapper.appendChild(trigger);
    wrapper.appendChild(popover);
    return wrapper;
  }

  private ensureConfigOptionDropdown(
    configId: string,
    wrapper: HTMLElement
  ): Dropdown {
    const existing = this.configOptionDropdowns.get(configId);
    if (existing) return existing;
    const dropdown = new Dropdown(wrapper, (value) => {
      this.vscode.postMessage({
        type: "selectConfigOption",
        configId,
        value,
      });
    });
    this.configOptionDropdowns.set(configId, dropdown);
    return dropdown;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}

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
