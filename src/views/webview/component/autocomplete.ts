import type { WebviewContext } from "../context";
import type { MessageHandler } from "../message-router";
import type { AvailableCommand, ExtensionMessage, Mention } from "../types";
import { escapeHtml } from "../html-utils";
import { getFileIconHtml, getFolderIconHtml } from "../file-icon";

interface FileResult {
  name: string;
  path: string;
  dir: string;
  type: "file" | "folder";
  fsPath: string;
}

/**
 * Manages the command (/) and file (@) autocomplete popover.
 *
 * Registers itself with the MessageRouter for `fileSearchResults` messages.
 * Owns all autocomplete state (mode, trigger position, selection index,
 * file results) and rendering logic that was previously scattered across
 * the controller.
 */
export class AutocompleteComponent implements MessageHandler {
  private mode: "none" | "command" | "file" = "none";
  private triggerPos = -1;
  private pendingReplacementTriggerPos = -1;
  private selectedIndex = -1;
  private fileResults: FileResult[] = [];
  private availableCommands: AvailableCommand[] = [];

  constructor(
    private ctx: WebviewContext,
    private elements: {
      inputEl: HTMLElement;
      commandAutocomplete: HTMLElement;
    },
    private onSelect?: (result: string | Mention) => void
  ) {
    ctx.messageRouter.register("fileSearchResults", this);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const { commandAutocomplete } = this.elements;

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
        const result = this.selectAt(index);
        if (result && this.onSelect) {
          this.onSelect(result);
        }
      }
    });

    commandAutocomplete.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        this.selectedIndex = index;
        this.updateSelection();
      }
    });
  }

  // -------------------------------------------------------------------
  // MessageHandler
  // -------------------------------------------------------------------

  handleMessage(msg: ExtensionMessage): boolean | void {
    if (msg.type === "fileSearchResults" && msg.results) {
      this.fileResults = msg.results;
      this.selectedIndex = this.fileResults.length > 0 ? 0 : -1;
      this.render();
      return;
    }
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /** Update the available commands list (called from session metadata). */
  setAvailableCommands(commands: AvailableCommand[]): void {
    this.availableCommands = commands;
  }

  /** Return whether the autocomplete popover is currently visible. */
  isActive(): boolean {
    return this.mode !== "none";
  }

  /**
   * Analyse the current cursor position and show/hide the autocomplete
   * popover accordingly. Call this on every input event.
   */
  update(): void {
    const { win } = this.ctx;
    const selection = win.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const useMockFallback =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !(range.startContainer instanceof (win as any).Node) &&
      typeof range.startContainer.textContent === "string";

    const fullText = this.elements.inputEl.textContent || "";
    const globalOffset = this.getGlobalCursorOffset();

    const textBefore = useMockFallback
      ? range.startContainer.textContent!.slice(0, range.startOffset)
      : fullText.slice(0, globalOffset);

    const lastSlashIdx = textBefore.lastIndexOf("/");
    const lastAtIdx = textBefore.lastIndexOf("@");

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
      this.mode = "command";
      this.triggerPos = lastSlashIdx;

      const query = textBefore.slice(lastSlashIdx);
      const filtered = this.getFilteredCommands(query);
      this.selectedIndex = filtered.length > 0 ? 0 : -1;
      this.render();
    } else if (isAtTrigger && !textBefore.slice(lastAtIdx).includes(" ")) {
      this.mode = "file";
      this.triggerPos = lastAtIdx;
      const query = textBefore.slice(lastAtIdx + 1);
      this.selectedIndex = 0;
      this.ctx.vscode.postMessage({ type: "searchFiles", text: query });
    } else {
      this.hide();
    }
  }

  /**
   * Handle keydown events within the autocomplete popover.
   * Returns true if the event was consumed (caller should not process it).
   */
  handleKeyDown(e: KeyboardEvent): boolean {
    const isVisible =
      this.elements.commandAutocomplete.classList.contains("visible");
    if (!isVisible) return false;

    const count =
      this.elements.commandAutocomplete.querySelectorAll(
        ".command-item"
      ).length;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, count - 1);
      this.updateSelection();
      this.scrollSelectedIntoView();
      return true;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.updateSelection();
      this.scrollSelectedIntoView();
      return true;
    } else if (
      e.key === "Tab" ||
      (e.key === "Enter" && this.selectedIndex >= 0)
    ) {
      e.preventDefault();
      return true; // caller should call selectCurrent()
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
      return true;
    }

    return false;
  }

  /**
   * Select the current autocomplete item and return the chip to insert.
   * Returns null if nothing was selected.
   */
  selectCurrent(): Mention | string | null {
    if (this.selectedIndex < 0) {
      this.hide();
      return null;
    }

    let result: Mention | string | null = null;

    if (this.mode === "command") {
      const text = this.elements.inputEl.textContent || "";
      const query = text.slice(this.triggerPos).split(/\s/)[0];
      const commands = this.getFilteredCommands(query);
      if (this.selectedIndex < commands.length) {
        const cmd = commands[this.selectedIndex];
        result = "/" + cmd.name;
      }
    } else if (this.mode === "file") {
      if (this.selectedIndex < this.fileResults.length) {
        const file = this.fileResults[this.selectedIndex];
        result = {
          name: file.name,
          path: file.fsPath,
          type: file.type,
        };
      }
    }

    if (result !== null) {
      this.pendingReplacementTriggerPos = this.triggerPos;
    }

    this.hideInternal(result !== null);
    return result;
  }

  /**
   * Select an autocomplete item by index (used by mouse click).
   * Returns the chip to insert, or null.
   */
  selectAt(index: number): Mention | string | null {
    this.selectedIndex = index;
    return this.selectCurrent();
  }

  /** Hide the autocomplete popover and reset state. */
  hide(): void {
    this.hideInternal(false);
  }

  /** Return and clear the trigger position for the most recent selection. */
  consumeReplacementTriggerPos(): number {
    const triggerPos = this.pendingReplacementTriggerPos;
    this.pendingReplacementTriggerPos = -1;
    return triggerPos;
  }

  private hideInternal(preservePendingReplacement: boolean): void {
    const { commandAutocomplete, inputEl } = this.elements;
    commandAutocomplete.classList.remove("visible");
    commandAutocomplete.innerHTML = "";
    this.selectedIndex = -1;
    this.mode = "none";
    if (!preservePendingReplacement) {
      this.pendingReplacementTriggerPos = -1;
    }
    inputEl.setAttribute("aria-expanded", "false");
  }

  /** Return the current trigger position (for chip insertion). */
  getTriggerPos(): number {
    return this.triggerPos;
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

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
    const { win } = this.ctx;
    const selection = win.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(range.startContainer instanceof (win as any).Node)) {
      return range.startOffset;
    }

    try {
      const preRange = range.cloneRange();
      preRange.selectNodeContents(this.elements.inputEl);
      preRange.setEnd(range.startContainer, range.startOffset);
      return preRange.toString().length;
    } catch {
      return range.startOffset;
    }
  }

  private render(): void {
    const { commandAutocomplete } = this.elements;
    let itemsHtml = "";

    if (this.mode === "command") {
      const text = this.elements.inputEl.textContent || "";
      const query = text.slice(this.triggerPos).split(/\s/)[0];
      const commands = this.getFilteredCommands(query);
      if (commands.length === 0) {
        this.hide();
        return;
      }
      itemsHtml = commands
        .map((cmd, i) => this.renderCommandItem(cmd, i))
        .join("");
    } else if (this.mode === "file") {
      if (this.fileResults.length === 0) {
        this.hide();
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
      this.hide();
    }
  }

  renderCommandItem(cmd: AvailableCommand, i: number): string {
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

  private renderFileItem(file: FileResult, i: number): string {
    const isFolder = file.type === "folder";
    const iconHtml = isFolder
      ? getFolderIconHtml(file.name)
      : getFileIconHtml(file.name);

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

  private updateSelection(): void {
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

  private scrollSelectedIntoView(): void {
    const { commandAutocomplete } = this.elements;
    const selectedItem = commandAutocomplete.querySelector(
      ".command-item.selected"
    );
    if (selectedItem && typeof selectedItem.scrollIntoView === "function") {
      selectedItem.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }
}
