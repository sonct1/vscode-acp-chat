import type { WebviewContext } from "../context";

/**
 * Renders action buttons (copy, paste-to-input, scroll-to-top,
 * scroll-to-user) on completed assistant messages.
 *
 * Extracted from the controller's renderActionButtons method.
 */
export class ActionButtonsComponent {
  constructor(private ctx: WebviewContext) {}

  /**
   * Append action buttons to a completed assistant message element.
   * Skips if buttons are already present.
   */
  render(
    messageEl: HTMLElement,
    callbacks: {
      onCopyToInput: (text: string) => void;
      scrollToTop: () => void;
      scrollToPreviousUserMessage: (el: HTMLElement) => void;
    }
  ): void {
    if (!messageEl || messageEl.querySelector(".message-actions")) return;

    const { doc } = this.ctx;
    const actionsContainer = doc.createElement("div");
    actionsContainer.className = "message-actions";

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
    const copyBtn = this.createButton("copy", "Copy response", async () => {
      const text = getFinalText();
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
          this.flashCheck(copyBtn);
        } catch (err) {
          console.error("Failed to copy:", err);
        }
      }
    });

    // Paste to Input Button
    const pasteBtn = this.createButton("edit", "Copy to input", () => {
      const text = getFinalText();
      if (text) {
        callbacks.onCopyToInput(text);
      }
    });

    // Scroll to Top Button
    const topBtn = this.createButton("arrow-up", "Scroll to top", () => {
      callbacks.scrollToTop();
    });

    // Scroll to Recent User Input Button
    const userBtn = this.createButton(
      "reply",
      "Scroll to user question",
      () => {
        callbacks.scrollToPreviousUserMessage(messageEl);
      }
    );

    actionsContainer.appendChild(copyBtn);
    actionsContainer.appendChild(pasteBtn);
    actionsContainer.appendChild(topBtn);
    actionsContainer.appendChild(userBtn);

    messageEl.appendChild(actionsContainer);
  }

  private createButton(
    icon: string,
    title: string,
    onClick: () => void
  ): HTMLButtonElement {
    const { doc } = this.ctx;
    const btn = doc.createElement("button");
    btn.className = "action-btn";
    btn.setAttribute("acp-title", title);
    const iconEl = doc.createElement("span");
    iconEl.className = `codicon codicon-${icon}`;
    btn.appendChild(iconEl);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private flashCheck(btn: HTMLButtonElement): void {
    const iconEl = btn.querySelector(".codicon") as HTMLElement;
    if (!iconEl) return;
    const originalClass = iconEl.className;
    iconEl.className = "codicon codicon-check";
    setTimeout(() => {
      iconEl.className = originalClass;
    }, 1500);
  }
}
