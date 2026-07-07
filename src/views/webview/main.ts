import { marked } from "./marked-config";
import { renderToolSummary, renderToolDetails } from "./tool-render";
import { escapeHtml } from "./html-utils";
import { AsyncSerialQueue } from "../../utils/async-queue";
import { getFileIconHtml, getFolderIconHtml } from "./file-icon";
import { TooltipManager } from "./widget/tooltip";
import { showConfirmDialog } from "./widget/confirm-dialog";
import { PermissionDialog } from "./widget/permission-dialog";
import { AuxiliaryPanelsComponent } from "./component/auxiliary-panels";
import { InputPanelComponent } from "./component/input-panel";
import { MessageListComponent } from "./component/message-list";
import { SessionToolbarComponent } from "./component/session-toolbar";
import { createWebviewRoot } from "./component/webview-root";
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
  WebviewElements,
} from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

export function updateSelectLabel(select: HTMLSelectElement): void {
  Array.from(select.options).forEach((opt) => {
    opt.textContent = opt.dataset.label || opt.textContent;
  });
}

export function getElements(doc: Document): WebviewElements {
  return createWebviewRoot(doc);
}

/**
 * Coordinates ACP messages and streaming block state, while component classes
 * own DOM behavior for the message list, input panel, toolbar, and side panels.
 */
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

  private messageList: MessageListComponent;
  private inputPanel: InputPanelComponent;
  private sessionToolbar: SessionToolbarComponent;
  private auxiliaryPanels: AuxiliaryPanelsComponent;
  private isGenerating = false;
  private hoveredImageChip: HTMLElement | null = null;
  private permissionDialog: PermissionDialog;
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

    this.messageList = new MessageListComponent(this.doc, {
      elements: this.elements.messageList,
      win: this.win,
    });
    this.inputPanel = new InputPanelComponent(this.doc, {
      elements: this.elements.inputPanel,
      win: this.win,
    });
    this.sessionToolbar = new SessionToolbarComponent(this.doc, {
      elements: this.elements.sessionToolbar,
      vscode: this.vscode,
    });
    this.auxiliaryPanels = new AuxiliaryPanelsComponent(this.doc, {
      elements: this.elements.auxiliaryPanels,
      vscode: this.vscode,
      onSaveState: () => this.saveState(),
    });

    // Permission decisions can change generation state and scroll position, so
    // this dialog stays wired to controller-level streaming state for now.
    this.permissionDialog = new PermissionDialog({
      doc: this.doc,
      vscode: this.vscode,
      getIsGenerating: () => this.isGenerating,
      setGenerating: (v) => this.setGenerating(v),
      scrollToBottom: () => this.scrollToBottom(),
      findToolBlock: (id) =>
        this.blocks.find((b) => b.type === "tool" && b.toolId === id),
    });

    this.restoreState();
    this.setupEventListeners();
    this.updateViewState();
    this.adjustHeight();
    this.updateInputState();
    this.vscode.postMessage({ type: "ready" });
    new TooltipManager(this.doc, this.win).setup();
    // Delegated message-list handlers are installed after state restoration so
    // restored DOM chips and subsequent streamed content share one listener set.
    this.messageList.setupCodeCopyHandler();
    this.messageList.setupFileLinkHandler(this.vscode);
    this.messageList.setupDiffHeaderClickHandler(this.vscode);
    this.messageList.setupScrollEventListeners(this.win);
  }

  private showConfirmDialog(actionLabel: string): Promise<boolean> {
    return showConfirmDialog(this.doc, actionLabel);
  }

  private updateInputState(): void {
    this.hoveredImageChip = this.inputPanel.updateInputState(
      this.isGenerating,
      this.hoveredImageChip
    );
  }

  private updatePlaceholder(agentName: string): void {
    this.inputPanel.setPlaceholder(agentName);
  }

  private adjustHeight(): void {
    this.inputPanel.adjustHeight();
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
        this.auxiliaryPanels.setDiffChanges(previousState.diffChanges);
      }
    }
  }

  private saveState(): void {
    this.vscode.setState<WebviewState>({
      isConnected: this.isConnected,
      inputValue: this.elements.inputEl.innerHTML || "",
      diffChanges: this.auxiliaryPanels.getDiffChanges(),
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
    const insertedText = this.inputPanel.handlePaste(e, (file) =>
      this.handleImageAttachment(file)
    );
    if (!insertedText) {
      return;
    }

    this.updateAutocomplete();
    this.saveState();
    this.updateInputState();
  }

  private setupEventListeners(): void {
    const { sendBtn, stopBtn, inputEl } = this.elements;

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

    this.inputPanel.setupAttachImageButton((file) =>
      this.handleImageAttachment(file)
    );

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
    this.inputPanel.handleImageAttachment(file, (mention) =>
      this.insertMentionChip(mention)
    );
  }

  private showImagePreview(base64: string, event: MouseEvent): void {
    this.inputPanel.showImagePreview(base64, event);
  }

  private hideImagePreview(): void {
    this.inputPanel.hideImagePreview();
  }

  private scrollToBottom(force = false): void {
    this.messageList.scrollToBottom(force);
  }

  public addMessage(
    text: string,
    type: "user" | "assistant" | "error" | "system",
    mentions?: Mention[]
  ): HTMLElement {
    return this.messageList.addMessage(text, type, {
      mentions,
      availableCommands: this.availableCommands,
      renderMentionChip: (mention, readonly) =>
        this.renderMentionChip(mention, readonly),
      renderCommandChip: (command, description, readonly) =>
        this.renderCommandChip(command, description, readonly),
    });
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
    this.messageList.updateViewState();
  }

  showPlan(entries: PlanEntry[]): void {
    this.auxiliaryPanels.showPlan(entries);
  }

  hidePlan(): void {
    this.auxiliaryPanels.hidePlan();
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
    this.updateInputState();
    this.saveState();
  }

  private clearInput(): void {
    this.inputPanel.clearInput();
    this.hideAutocomplete();
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
      range.startContainer instanceof (this.win as any).Node
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
        range.startContainer instanceof (this.win as any).Node
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
      const newRange = this.doc.createRange();
      newRange.setStart(space, space.length);
      newRange.collapse(true);
      if (typeof selectionAfter.removeAllRanges === "function") {
        selectionAfter.removeAllRanges();
        selectionAfter.addRange(newRange);
      } else if (typeof selectionAfter.collapseToEnd === "function") {
        selectionAfter.collapseToEnd();
      }
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
        range.startContainer instanceof (this.win as any).Node
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
      const newRange = this.doc.createRange();
      newRange.setStart(space, space.length);
      newRange.collapse(true);
      if (typeof selectionAfter.removeAllRanges === "function") {
        selectionAfter.removeAllRanges();
        selectionAfter.addRange(newRange);
      } else if (typeof selectionAfter.collapseToEnd === "function") {
        selectionAfter.collapseToEnd();
      }
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
        this.inputPanel.setTextAndFocus(text);
        this.saveState();
        this.updateInputState();
      }
    });

    // Scroll to Top Button
    const topBtn = createBtn("arrow-up", "Scroll to top", () => {
      this.messageList.scrollToTop();
    });

    // Scroll to Recent User Input Button
    const userBtn = createBtn("reply", "Scroll to user question", () => {
      this.messageList.scrollToPreviousUserMessage(messageEl);
    });

    actionsContainer.appendChild(copyBtn);
    actionsContainer.appendChild(pasteBtn);
    actionsContainer.appendChild(topBtn);
    actionsContainer.appendChild(userBtn);

    messageEl.appendChild(actionsContainer);
  }

  private setGenerating(isGenerating: boolean): void {
    this.isGenerating = isGenerating;
    this.inputPanel.setGenerating(isGenerating);
    if (isGenerating) {
      this.messageList.showTypingIndicator(this.currentAssistantMessage);
      this.scrollToBottom(true);
    } else {
      this.messageList.hideTypingIndicator();
      this.updateInputState();
    }
  }

  private updateContextUsageRing(msg: ExtensionMessage): void {
    this.sessionToolbar.updateContextUsage(msg);
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
        this.inputPanel.focus();
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
        this.inputPanel.focus();
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
        this.auxiliaryPanels.clearDiff();
      // fallthrough
      case "chatCleared":
        this.messageList.clear();
        this.currentAssistantMessage = null;
        this.resetRenderedBlockTracking();
        this.hideAutocomplete();
        this.auxiliaryPanels.hidePlan();
        this.auxiliaryPanels.clearDiff();
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
        this.sessionToolbar.updateMetadata(msg);

        if (msg.commands && Array.isArray(msg.commands)) {
          this.availableCommands = msg.commands;
        }
        break;
      }
      case "modeUpdate":
        if (msg.modeId) {
          this.sessionToolbar.setModeValue(msg.modeId);
        }
        break;
      case "modelUpdate":
        if (msg.modelId) {
          this.sessionToolbar.setModelValue(msg.modelId);
        }
        break;
      case "availableCommands":
        if (msg.commands && Array.isArray(msg.commands)) {
          this.availableCommands = msg.commands;
        }
        break;
      case "plan":
        if (msg.plan && msg.plan.entries) {
          this.auxiliaryPanels.showPlan(msg.plan.entries);
        }
        break;
      case "planComplete":
        this.auxiliaryPanels.hidePlan();
        break;
      case "diffSummary":
        if (msg.changes) {
          this.auxiliaryPanels.setDiffChanges(msg.changes);
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
