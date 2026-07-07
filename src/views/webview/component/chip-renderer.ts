import type { WebviewContext } from "../context";
import type { Mention } from "../types";

/**
 * Renders mention chips (@file, @folder, @image, @terminal, @selection) and
 * command chips (/command) as non-editable spans inside the contenteditable
 * input or read-only message surfaces.
 *
 * Extracted from the controller's renderMentionChip / renderCommandChip
 * methods. All VS Code bridge interactions are mediated through the
 * {@link WebviewContext} callbacks.
 */
export class ChipRendererComponent {
  private hoveredImageChip: HTMLElement | null = null;

  constructor(private ctx: WebviewContext) {}

  /**
   * Return the currently hovered image chip (for input state tracking).
   */
  getHoveredImageChip(): HTMLElement | null {
    return this.hoveredImageChip;
  }

  /**
   * Clear the hovered image chip reference.
   */
  clearHoveredImageChip(): void {
    this.hoveredImageChip = null;
  }

  /**
   * Create a mention chip element. When readonly is false, image chips
   * track hover state for preview popover management.
   */
  renderMentionChip(mention: Mention, readonly = false): HTMLElement {
    const { doc } = this.ctx;
    const chip = doc.createElement("span");
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
        iconHtml: this.ctx.getFileIconHtml(filename),
        onClick: (e) => {
          if (mention.path) {
            e.stopPropagation();
            this.ctx.vscode.postMessage({
              type: "openFile",
              path: mention.path,
              range: mention.range,
            });
          }
        },
      },
      folder: {
        iconHtml: this.ctx.getFolderIconHtml(filename),
        onClick: (e) => {
          if (mention.path) {
            e.stopPropagation();
            this.ctx.vscode.postMessage({
              type: "openFile",
              path: mention.path,
            });
          }
        },
      },
      selection: {
        iconHtml: this.ctx.getFileIconHtml(filename),
        onClick: (e) => {
          if (mention.path) {
            e.stopPropagation();
            this.ctx.vscode.postMessage({
              type: "openFile",
              path: mention.path,
              range: mention.range,
            });
          }
        },
      },
      terminal: {
        iconHtml: '<span class="codicon codicon-terminal"></span>',
      },
      image: {
        iconHtml: this.ctx.getFileIconHtml(filename),
        onHover: (e) => {
          if (mention.dataUrl) {
            if (!readonly) this.hoveredImageChip = chip;
            this.showImagePreview(mention.dataUrl, e);
          }
        },
      },
    };

    const config = typeConfigs[mentionType] || typeConfigs.file;

    chip.innerHTML = `<span class="chip-icon">${config.iconHtml}</span><span class="chip-label">${this.ctx.escapeHtml(displayLabel)}</span>`;

    if (config.onClick) {
      chip.addEventListener("click", config.onClick);
    }

    if (config.onHover) {
      const onHover = config.onHover;
      chip.addEventListener("mouseenter", (e) => onHover(e));
      chip.addEventListener("mouseleave", (e) => {
        if (!readonly) {
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

  /**
   * Create a command chip element (e.g. /compact).
   */
  renderCommandChip(
    command: string,
    description?: string,
    readonly = false
  ): HTMLElement {
    const { doc } = this.ctx;
    const chip = doc.createElement("span");
    chip.className = "command-chip" + (readonly ? " readonly" : "");
    chip.contentEditable = "false";
    chip.dataset.command = command;
    if (description) chip.setAttribute("acp-title", description);

    const displayLabel = command.startsWith("/")
      ? command.substring(1)
      : command;
    chip.innerHTML = `<span class="chip-prefix">/</span><span class="chip-label">${this.ctx.escapeHtml(displayLabel)}</span>`;

    return chip;
  }

  private showImagePreview(base64: string, event: MouseEvent): void {
    const { doc, win } = this.ctx;
    const imagePreviewPopover = doc.getElementById("image-preview-popover");
    if (!imagePreviewPopover) return;

    const img = imagePreviewPopover.querySelector("img");
    if (!img) return;
    img.src = base64;
    imagePreviewPopover.style.display = "block";

    const innerWidth = win.innerWidth;
    const x = Math.min(
      event.clientX + 10,
      innerWidth - imagePreviewPopover.offsetWidth - 20
    );
    const y = Math.max(
      20,
      event.clientY - imagePreviewPopover.offsetHeight - 10
    );
    imagePreviewPopover.style.left = x + "px";
    imagePreviewPopover.style.top = y + "px";
  }

  hideImagePreview(): void {
    const imagePreviewPopover = this.ctx.doc.getElementById(
      "image-preview-popover"
    );
    if (imagePreviewPopover) {
      imagePreviewPopover.style.display = "none";
    }
  }
}
