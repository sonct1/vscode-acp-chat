import { TABLE_COPY_METADATA_TOKEN } from "../../views/webview/marked-config";
import type { WebviewController } from "../../views/webview/main";
import type { WebviewEventMap } from "../../views/webview/types";
import type { EventBus } from "../../views/webview/event-bus";
import type {
  TableClipboard,
  TableCopyFeedbackOptions,
  TableCopyFormat,
} from "./types";
import { TABLE_COPY_STYLES } from "./styles";

const SOURCE_SELECTOR = "template.table-copy-source";
const WRAPPER_SELECTOR = ".table-copy-wrapper";
const FEEDBACK_DURATION_MS = 1500;

const FORMAT_LABELS: Record<TableCopyFormat, string> = {
  markdown: "Markdown",
  html: "HTML",
  "displayed-text": "displayed text",
};

export class TableCopyWebviewController {
  private readonly clipboard: TableClipboard;
  private readonly feedbackDurationMs: number;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly messagesEl: HTMLElement,
    private readonly eventBus: EventBus<WebviewEventMap>,
    clipboard?: TableClipboard,
    options: TableCopyFeedbackOptions = {}
  ) {
    this.clipboard = clipboard ?? createBrowserTableClipboard(win);
    this.feedbackDurationMs =
      options.feedbackDurationMs ?? FEEDBACK_DURATION_MS;
    this.injectStyles();
    this.eventBus.on("markdownRendered", ({ root, kind }) => {
      if (kind !== "text") return;
      this.enhanceTables(root);
    });
    this.setupDelegatedEvents();
  }

  enhanceTables(root: HTMLElement): void {
    const sources = Array.from(
      root.querySelectorAll<HTMLTemplateElement>(SOURCE_SELECTOR)
    );

    for (const source of sources) {
      if (source.closest(WRAPPER_SELECTOR)) continue;
      if (source.dataset.tableCopyToken !== TABLE_COPY_METADATA_TOKEN) continue;

      const table = source.nextElementSibling as HTMLTableElement | null;
      if (!table || table.tagName.toLowerCase() !== "table") continue;

      const wrapper = this.doc.createElement("div");
      wrapper.className = "table-copy-wrapper";
      wrapper.dataset.tableCopyEnhanced = "true";

      const parent = table.parentElement;
      if (!parent) continue;
      const tableScroll = this.doc.createElement("div");
      tableScroll.className = "table-copy-table-scroll";

      parent.insertBefore(wrapper, source);
      tableScroll.append(table);
      wrapper.append(source, this.createToolbar(), tableScroll);
    }
  }

  private createToolbar(): HTMLElement {
    const toolbar = this.doc.createElement("div");
    toolbar.className = "table-copy-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Table copy controls");

    const split = this.doc.createElement("div");
    split.className = "table-copy-split";

    const primary = this.doc.createElement("button");
    primary.type = "button";
    primary.className = "table-copy-button table-copy-primary";
    primary.dataset.tableCopyAction = "copy";
    primary.dataset.tableCopyFormat = "markdown";
    primary.setAttribute("aria-label", "Copy table as Markdown");
    primary.setAttribute("acp-title", "Copy table as Markdown");
    primary.append(createCodicon(this.doc, "copy"));

    const toggle = this.doc.createElement("button");
    toggle.type = "button";
    toggle.className = "table-copy-button table-copy-menu-toggle";
    toggle.dataset.tableCopyAction = "toggle-menu";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Choose table copy format");
    toggle.setAttribute("acp-title", "More copy formats");
    toggle.append(createCodicon(this.doc, "chevron-down"));

    split.append(primary, toggle);
    toolbar.append(split, this.createMenu());
    return toolbar;
  }

  private createMenu(): HTMLElement {
    const menu = this.doc.createElement("div");
    menu.className = "table-copy-menu";
    menu.setAttribute("aria-label", "Table copy formats");
    menu.hidden = true;

    const items: Array<{ format: TableCopyFormat; label: string; icon: string }> = [
      { format: "markdown", label: "Copy as Markdown", icon: "markdown" },
      { format: "html", label: "Copy as HTML", icon: "code" },
      {
        format: "displayed-text",
        label: "Copy displayed text",
        icon: "list-flat",
      },
    ];

    for (const item of items) {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "table-copy-menu-item";
      button.dataset.tableCopyAction = "copy";
      button.dataset.tableCopyFormat = item.format;
      button.append(createCodicon(this.doc, item.icon));
      const label = this.doc.createElement("span");
      label.textContent = item.label;
      button.append(label);
      menu.append(button);
    }

    return menu;
  }

  private setupDelegatedEvents(): void {
    this.messagesEl.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest(
        "[data-table-copy-action]"
      ) as HTMLButtonElement | null;

      if (button && this.messagesEl.contains(button)) {
        event.preventDefault();
        event.stopPropagation();
        void this.handleButtonClick(button);
        return;
      }

      if (!target.closest(WRAPPER_SELECTOR)) {
        this.closeAllMenus();
      }
    });

    this.doc.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest(WRAPPER_SELECTOR)) return;
      this.closeAllMenus();
    });

    this.doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      this.closeAllMenus();
    });
  }

  private async handleButtonClick(button: HTMLButtonElement): Promise<void> {
    const wrapper = button.closest(WRAPPER_SELECTOR) as HTMLElement | null;
    if (!wrapper) return;

    const action = button.dataset.tableCopyAction;
    if (action === "toggle-menu") {
      this.toggleMenu(wrapper);
      return;
    }

    const format = button.dataset.tableCopyFormat as TableCopyFormat | undefined;
    if (!format) return;

    this.closeMenu(wrapper);
    await this.copyTable(wrapper, format);
  }

  private async copyTable(
    wrapper: HTMLElement,
    format: TableCopyFormat
  ): Promise<void> {
    const table = wrapper.querySelector("table") as HTMLTableElement | null;
    if (!table) return;

    try {
      if (format === "html") {
        const html = serializeTableAsHtml(table);
        const displayedText = serializeTableAsDisplayedText(table);
        if (this.clipboard.writeHtml) {
          await this.clipboard.writeHtml(html, displayedText);
        } else {
          await this.clipboard.writeText(html);
        }
      } else if (format === "displayed-text") {
        await this.clipboard.writeText(serializeTableAsDisplayedText(table));
      } else {
        await this.clipboard.writeText(serializeTableAsMarkdown(wrapper));
      }

      this.flashCopied(wrapper, format);
    } catch (error) {
      console.error(`[TableCopy] Failed to copy table as ${format}:`, error);
    }
  }

  private toggleMenu(wrapper: HTMLElement): void {
    const menu = getMenu(wrapper);
    const willOpen = !menu || menu.hidden;
    this.closeAllMenus();
    if (willOpen) this.openMenu(wrapper);
  }

  private openMenu(wrapper: HTMLElement): void {
    const menu = getMenu(wrapper);
    const toggle = getMenuToggle(wrapper);
    if (!menu || !toggle) return;
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  }

  private closeMenu(wrapper: HTMLElement): void {
    const menu = getMenu(wrapper);
    const toggle = getMenuToggle(wrapper);
    if (!menu || !toggle) return;
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  private closeAllMenus(): void {
    for (const wrapper of Array.from(
      this.messagesEl.querySelectorAll<HTMLElement>(WRAPPER_SELECTOR)
    )) {
      this.closeMenu(wrapper);
    }
  }

  private flashCopied(wrapper: HTMLElement, format: TableCopyFormat): void {
    const button = wrapper.querySelector(
      ".table-copy-primary"
    ) as HTMLButtonElement | null;
    if (!button) return;

    const icon = button.querySelector(".codicon") as HTMLElement | null;
    if (!icon) return;

    icon.className = "codicon codicon-check";
    button.classList.add("copied");
    button.setAttribute("acp-title", `Copied as ${FORMAT_LABELS[format]}`);

    this.win.setTimeout(() => {
      if (!button.isConnected) return;
      icon.className = "codicon codicon-copy";
      button.classList.remove("copied");
      button.setAttribute("acp-title", "Copy table as Markdown");
    }, this.feedbackDurationMs);
  }

  private injectStyles(): void {
    if (this.doc.getElementById("table-copy-styles")) return;
    const style = this.doc.createElement("style");
    style.id = "table-copy-styles";
    style.textContent = TABLE_COPY_STYLES;
    this.doc.head.append(style);
  }
}

export function serializeTableAsMarkdown(wrapper: HTMLElement): string {
  const source = wrapper.querySelector<HTMLTemplateElement>(SOURCE_SELECTOR);
  const encoded = source?.dataset.markdown ?? "";
  const markdown = safeDecodeURIComponent(encoded);
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

export function serializeTableAsHtml(table: HTMLTableElement): string {
  return table.outerHTML;
}

export function serializeTableAsDisplayedText(table: HTMLTableElement): string {
  return Array.from(table.rows)
    .filter((row) => row.closest("table") === table)
    .map((row) =>
      Array.from(row.cells)
        .map((cell) => normalizeCellText(cell))
        .join("\t")
    )
    .join("\n");
}

export function createBrowserTableClipboard(win: Window): TableClipboard {
  const clipboard = win.navigator.clipboard;
  const browserWindow = win as Window & {
    Blob?: typeof Blob;
    ClipboardItem?: typeof ClipboardItem;
  };

  return {
    writeText: (value) => clipboard.writeText(value),
    writeHtml: async (html, plainText) => {
      const ClipboardItemCtor = browserWindow.ClipboardItem;
      const BlobCtor = browserWindow.Blob ?? Blob;
      if (typeof clipboard.write !== "function" || !ClipboardItemCtor) {
        await clipboard.writeText(html);
        return;
      }

      try {
        const item = new ClipboardItemCtor({
          "text/html": new BlobCtor([html], { type: "text/html" }),
          "text/plain": new BlobCtor([plainText], { type: "text/plain" }),
        });
        await clipboard.write([item]);
      } catch {
        await clipboard.writeText(html);
      }
    },
  };
}

function normalizeCellText(cell: HTMLElement): string {
  const value = cell.innerText ?? cell.textContent ?? "";
  return value.replace(/\s+/g, " ").trim();
}

function getMenu(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector(".table-copy-menu");
}

function getMenuToggle(wrapper: HTMLElement): HTMLButtonElement | null {
  return wrapper.querySelector(".table-copy-menu-toggle");
}

function createCodicon(doc: Document, icon: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = `codicon codicon-${icon}`;
  el.setAttribute("aria-hidden", "true");
  return el;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function registerTableCopyWebviewFeature(
  controller: WebviewController
): TableCopyWebviewController {
  return new TableCopyWebviewController(
    controller.getDocument(),
    controller.getWindow(),
    controller.messageList.elements.messagesEl,
    controller.getEventBus()
  );
}
