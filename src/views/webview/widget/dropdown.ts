/**
 * Reusable dropdown widget for the webview.
 *
 * Renders a trigger + popover pair inside a container element.  Supports
 * grouped options (headers / dividers), keyboard-less selection, and an
 * optional star-toggle action used by the model picker.
 */

import { escapeHtml } from "../html-utils";
import type { DropdownOption } from "../types";

export class Dropdown {
  private element: HTMLElement;
  private trigger: HTMLElement;
  private popover: HTMLElement;
  private labelEl: HTMLElement;
  private options: DropdownOption[] = [];
  private selectedId: string | null = null;
  private onChange?: (id: string) => void;
  private onStarToggle?: (id: string, isStarred: boolean) => void;
  private isOpen = false;
  private customTitle: string | null = null;

  constructor(
    element: HTMLElement,
    onChange?: (id: string) => void,
    onStarToggle?: (id: string, isStarred: boolean) => void
  ) {
    this.element = element;
    this.onChange = onChange;
    this.onStarToggle = onStarToggle;
    this.trigger = element.querySelector(".dropdown-trigger")!;
    this.popover = element.querySelector(".dropdown-popover")!;
    this.labelEl = element.querySelector(".selected-label")!;
    this.trigger.addEventListener("click", () => {
      this.toggle();
    });

    // Close the popover when clicking outside the dropdown.
    this.element.ownerDocument.addEventListener("click", (e) => {
      if (this.isOpen && !this.element.contains(e.target as Node)) {
        this.close();
      }
    });

    // Prevent clicks inside the popover from bubbling to the document handler.
    this.popover.addEventListener("click", (e) => e.stopPropagation());
  }

  /**
   * Override the tooltip text shown on the label element.
   * Pass `null` to revert to the default (selected option name).
   */
  setCustomTitle(title: string | null): void {
    this.customTitle = title;
    if (this.selectedId) {
      const option = this.options.find(
        (o) =>
          o.id === this.selectedId &&
          o.type !== "header" &&
          o.type !== "divider"
      );
      if (option) {
        this.labelEl.setAttribute("acp-title", this.customTitle || option.name);
      }
    }
  }

  /**
   * Replace all options and optionally pre-select one.
   */
  setOptions(options: DropdownOption[], selectedId?: string): void {
    this.options = options;
    this.renderOptions();
    if (selectedId !== undefined) {
      this.select(selectedId, false);
    }
  }

  /**
   * Select an option by id.
   * @param triggerChange  Whether to fire the `onChange` callback.
   */
  select(id: string, triggerChange = true): void {
    const option = this.options.find(
      (o) => o.id === id && o.type !== "header" && o.type !== "divider"
    );
    if (!option) return;

    this.selectedId = id;
    this.labelEl.textContent = option.name;
    this.labelEl.setAttribute("acp-title", this.customTitle || option.name);

    const items = this.popover.querySelectorAll(".dropdown-item");
    items.forEach((item) => {
      if (item.getAttribute("data-id") === id) {
        item.classList.add("selected");
      } else {
        item.classList.remove("selected");
      }
    });

    if (triggerChange && this.onChange) {
      this.onChange(id);
    }
  }

  /** Return the currently selected option id (or `null`). */
  getValue(): string | null {
    return this.selectedId;
  }

  /** Set the selected value without triggering `onChange`. */
  setValue(id: string): void {
    this.select(id, false);
  }

  /** Toggle the open / closed state. */
  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Open the popover and adjust its position. */
  open(): void {
    this.isOpen = true;
    this.element.classList.add("open");
    this.adjustPosition();
  }

  /** Close the popover. */
  close(): void {
    this.isOpen = false;
    this.element.classList.remove("open");
    this.popover.style.left = "";
  }

  /**
   * Nudge the popover horizontally so it stays within the viewport.
   * Uses `requestAnimationFrame` to measure after the `open` class is applied.
   */
  private adjustPosition(): void {
    const popover = this.popover;
    const rect = this.element.getBoundingClientRect();
    const windowWidth =
      this.element.ownerDocument.defaultView?.innerWidth || window.innerWidth;
    const padding = 12;

    // Reset styles first
    popover.style.left = "0";

    const requestFrame =
      typeof this.element.ownerDocument.defaultView?.requestAnimationFrame ===
      "function"
        ? this.element.ownerDocument.defaultView.requestAnimationFrame.bind(
            this.element.ownerDocument.defaultView
          )
        : (callback: FrameRequestCallback) =>
            this.element.ownerDocument.defaultView?.setTimeout(
              () => callback(Date.now()),
              0
            ) ?? setTimeout(() => callback(Date.now()), 0);

    // Wait for next frame to get accurate width after 'open' class is added.
    requestFrame(() => {
      const popoverRect = popover.getBoundingClientRect();
      const rightEdge = rect.left + popoverRect.width;

      if (rightEdge > windowWidth - padding) {
        const offset = rightEdge - (windowWidth - padding);
        popover.style.left = `-${offset}px`;
      }

      // Check if it overflows the left edge after adjustment
      const newRect = popover.getBoundingClientRect();
      if (newRect.left < padding) {
        popover.style.left = `-${rect.left - padding}px`;
      }
    });
  }

  /**
   * Rebuild the popover DOM from `this.options`.
   * Renders headers, dividers, and selectable items (with optional star).
   */
  private renderOptions(): void {
    this.popover.innerHTML = "";
    this.options.forEach((opt) => {
      if (opt.type === "divider") {
        const divider = this.element.ownerDocument.createElement("div");
        divider.className = "dropdown-divider";
        this.popover.appendChild(divider);
        return;
      }

      if (opt.type === "header") {
        const header = this.element.ownerDocument.createElement("div");
        header.className = "dropdown-header";
        header.textContent = opt.name;
        this.popover.appendChild(header);
        return;
      }

      const item = this.element.ownerDocument.createElement("div");
      item.className = "dropdown-item";
      if (opt.id === this.selectedId) item.classList.add("selected");
      item.setAttribute("data-id", opt.id);

      let starHtml = "";
      if (opt.canStar) {
        const starIcon = opt.isStarred ? "star-full" : "star-empty";
        starHtml = `<span class="dropdown-item-star codicon codicon-${starIcon}" acp-title="${
          opt.isStarred ? "Unstar" : "Star"
        }"></span>`;
      }

      item.innerHTML = `
        <span class="dropdown-item-check codicon codicon-check"></span>
        <span class="dropdown-item-label">${escapeHtml(opt.name)}</span>
        ${starHtml}
      `;

      item.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("dropdown-item-star")) {
          e.stopPropagation();
          if (this.onStarToggle) {
            this.onStarToggle(opt.id, !opt.isStarred);
          }
          return;
        }
        this.select(opt.id);
        this.close();
      });

      this.popover.appendChild(item);
    });
  }
}
