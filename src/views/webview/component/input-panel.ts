import type { InputPanelElements, Mention } from "../types";
import { getRequiredElement } from "../widget/dom";
import { SessionToolbarComponent } from "./session-toolbar";

type PasteEventLike = {
  clipboardData?: {
    items: Array<{ type: string; getAsFile?: () => File | null }>;
    getData: (type: string) => string;
  };
  preventDefault: () => void;
};

/**
 * Owns the rich input surface and nearby controls. Autocomplete state remains
 * in the controller for now because it coordinates extension file search
 * requests with command/mention chip insertion.
 */
export class InputPanelComponent {
  readonly toolbar: SessionToolbarComponent;
  readonly elements: InputPanelElements;
  private doc: Document;
  private win?: Window;

  constructor(
    doc: Document,
    options?: {
      elements?: InputPanelElements;
      win?: Window;
    }
  ) {
    this.doc = doc;
    this.win = options?.win;
    this.toolbar = new SessionToolbarComponent(doc, {
      elements: options?.elements?.toolbar,
    });
    this.elements = options?.elements ?? {
      inputEl: getRequiredElement(doc, "input"),
      commandAutocomplete: getRequiredElement(doc, "command-autocomplete"),
      attachImageBtn: getRequiredElement<HTMLButtonElement>(
        doc,
        "attach-image"
      ),
      imagePreviewPopover: getRequiredElement(doc, "image-preview-popover"),
      sendBtn: getRequiredElement<HTMLButtonElement>(doc, "send"),
      stopBtn: getRequiredElement<HTMLButtonElement>(doc, "stop"),
      toolbar: this.toolbar.elements,
    };
  }

  attachWindow(win: Window): void {
    this.win = win;
  }

  setupAttachImageButton(onFile: (file: File) => void): void {
    this.elements.attachImageBtn.addEventListener("click", () => {
      const input = this.doc.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => {
        if (input.files) {
          Array.from(input.files).forEach((file) => onFile(file));
        }
      };
      input.click();
    });
  }

  updateInputState(
    isGenerating: boolean,
    hoveredImageChip: HTMLElement | null
  ): HTMLElement | null {
    const text = this.elements.inputEl.textContent?.trim() || "";
    const hasMentions =
      this.elements.inputEl.querySelectorAll(".mention-chip").length > 0;
    let nextHoveredImageChip = hoveredImageChip;

    if (
      nextHoveredImageChip &&
      !this.elements.inputEl.contains(nextHoveredImageChip)
    ) {
      nextHoveredImageChip = null;
      this.hideImagePreview();
    }

    // Preserve the CSS :empty placeholder behavior after chips/text are
    // removed; contenteditable often leaves inert markup behind.
    if (!text && !hasMentions && this.elements.inputEl.innerHTML !== "") {
      this.elements.inputEl.innerHTML = "";
    }

    this.elements.sendBtn.disabled = (!text && !hasMentions) || isGenerating;
    return nextHoveredImageChip;
  }

  setPlaceholder(agentName: string): void {
    const placeholder = `Ask ${agentName.toLowerCase()}... (type / for commands, @ for files)`;
    this.elements.inputEl.setAttribute("data-placeholder", placeholder);
  }

  adjustHeight(): void {
    const { inputEl } = this.elements;
    const scrollTop = inputEl.scrollTop;
    inputEl.style.height = "auto";
    const maxHeight = (this.win?.innerHeight ?? window.innerHeight) / 3;
    const scrollHeight = inputEl.scrollHeight;
    const newHeight = Math.max(52, Math.min(scrollHeight, maxHeight));
    inputEl.style.height = newHeight + "px";
    inputEl.style.overflowY =
      scrollHeight > maxHeight - 1 ? "overlay" : "hidden";
    inputEl.scrollTop = scrollTop;
  }

  handlePaste(event: PasteEventLike, onImage: (file: File) => void): boolean {
    const items = event.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          event.preventDefault();
          const blob = item.getAsFile?.();
          if (blob) onImage(blob);
          return false;
        }
      }
    }

    // Always paste plain text into the rich editor. This avoids layout drift
    // from foreign HTML and prevents script/style markup from entering state.
    event.preventDefault();
    const plainText = event.clipboardData?.getData("text/plain") ?? "";
    const selection = this.win?.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
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
    return true;
  }

  handleImageAttachment(
    file: File,
    onMentionReady: (mention: Mention) => void
  ): void {
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      onMentionReady({
        name: file.name,
        type: "image",
        dataUrl: base64,
      });
    };
    reader.readAsDataURL(file);
  }

  setGenerating(isGenerating: boolean): void {
    this.elements.sendBtn.style.display = isGenerating ? "none" : "flex";
    this.elements.stopBtn.style.display = isGenerating ? "flex" : "none";
  }

  clearInput(): void {
    this.elements.inputEl.innerHTML = "";
    this.adjustHeight();
    this.focus();
    this.hideImagePreview();
  }

  setTextAndFocus(text: string): void {
    this.elements.inputEl.textContent = text;
    this.adjustHeight();
    this.focus();

    // Action buttons copy prior assistant output back into the editor; place
    // the caret at the end so Enter sends the restored text immediately.
    const range = this.doc.createRange();
    const selection = this.win?.getSelection();
    range.selectNodeContents(this.elements.inputEl);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  focus(): void {
    this.elements.inputEl.focus();
  }

  showImagePreview(base64: string, event: MouseEvent): void {
    const { imagePreviewPopover } = this.elements;
    const img = imagePreviewPopover.querySelector("img")!;
    img.src = base64;
    imagePreviewPopover.style.display = "block";

    const innerWidth = this.win?.innerWidth ?? window.innerWidth;
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
    this.elements.imagePreviewPopover.style.display = "none";
  }
}
