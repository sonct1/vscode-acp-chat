/**
 * Reusable dropdown widget for the webview.
 *
 * Renders a trigger + popover pair inside a container element.  Supports
 * grouped options (headers / dividers), keyboard-less selection, optional
 * search filtering, and an optional star-toggle action used by the model
 * picker.
 */

import { escapeHtml } from "../html-utils";
import type { DropdownOption } from "../types";

export interface DropdownConfig {
  searchable?: boolean;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  emptyMessage?: string;
}

interface DropdownSection {
  dividersBefore: DropdownOption[];
  header?: DropdownOption;
  items: DropdownOption[];
}

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
  private searchQuery = "";
  private searchInput?: HTMLInputElement;
  private optionsList?: HTMLElement;

  constructor(
    element: HTMLElement,
    onChange?: (id: string) => void,
    onStarToggle?: (id: string, isStarred: boolean) => void,
    private config: DropdownConfig = {}
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
    if (this.config.searchable) {
      this.clearSearchQuery();
    }

    this.isOpen = true;
    this.element.classList.add("open");
    this.adjustPosition();
    this.searchInput?.focus();
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

  private clearSearchQuery(): void {
    if (!this.searchQuery && !this.searchInput?.value) return;

    this.searchQuery = "";
    if (this.searchInput) {
      this.searchInput.value = "";
    }
    this.renderOptions();
  }

  private getOptionsHost(): HTMLElement {
    if (!this.config.searchable) {
      return this.popover;
    }

    if (!this.optionsList) {
      this.popover.innerHTML = "";

      const searchWrapper = this.element.ownerDocument.createElement("div");
      searchWrapper.className = "dropdown-search";

      this.searchInput = this.element.ownerDocument.createElement("input");
      this.searchInput.className = "dropdown-search-input";
      this.searchInput.type = "search";
      this.searchInput.placeholder =
        this.config.searchPlaceholder ?? "Search options...";
      this.searchInput.setAttribute(
        "aria-label",
        this.config.searchAriaLabel ?? this.searchInput.placeholder
      );
      this.searchInput.addEventListener("input", () => {
        this.searchQuery = this.searchInput?.value ?? "";
        this.renderOptions();
      });
      this.searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          this.close();
        }
      });

      searchWrapper.appendChild(this.searchInput);
      this.optionsList = this.element.ownerDocument.createElement("div");
      this.optionsList.className = "dropdown-options-list";

      this.popover.appendChild(searchWrapper);
      this.popover.appendChild(this.optionsList);
    }

    return this.optionsList;
  }

  /**
   * Rebuild the popover DOM from `this.options`.
   * Renders headers, dividers, and selectable items (with optional star).
   */
  private renderOptions(): void {
    const optionsHost = this.getOptionsHost();
    optionsHost.innerHTML = "";

    const options = this.getRenderableOptions();
    if (options.length === 0 && this.hasSearchQuery()) {
      const empty = this.element.ownerDocument.createElement("div");
      empty.className = "dropdown-empty";
      empty.textContent = this.config.emptyMessage ?? "No results found";
      optionsHost.appendChild(empty);
      return;
    }

    options.forEach((opt) => {
      if (opt.type === "divider") {
        const divider = this.element.ownerDocument.createElement("div");
        divider.className = "dropdown-divider";
        optionsHost.appendChild(divider);
        return;
      }

      if (opt.type === "header") {
        const header = this.element.ownerDocument.createElement("div");
        header.className = "dropdown-header";
        header.textContent = opt.name;
        optionsHost.appendChild(header);
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

      optionsHost.appendChild(item);
    });
  }

  private getRenderableOptions(): DropdownOption[] {
    if (!this.hasSearchQuery()) {
      return this.options;
    }

    const sections = this.getSections();
    const visibleSections = sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => this.matchesSearch(item)),
      }))
      .filter((section) => section.items.length > 0);

    const result: DropdownOption[] = [];
    visibleSections.forEach((section, index) => {
      if (index > 0) {
        result.push(...section.dividersBefore);
      }
      if (section.header) {
        result.push(section.header);
      }
      result.push(...section.items);
    });

    return result;
  }

  private getSections(): DropdownSection[] {
    const sections: DropdownSection[] = [];
    let current: DropdownSection = { dividersBefore: [], items: [] };
    let pendingDividers: DropdownOption[] = [];

    const pushCurrent = () => {
      if (current.header || current.items.length > 0) {
        sections.push(current);
      }
    };

    for (const option of this.options) {
      if (option.type === "divider") {
        pendingDividers.push(option);
        continue;
      }

      if (option.type === "header") {
        pushCurrent();
        current = {
          dividersBefore: pendingDividers,
          header: option,
          items: [],
        };
        pendingDividers = [];
        continue;
      }

      if (!current.header && current.items.length === 0) {
        current.dividersBefore = pendingDividers;
        pendingDividers = [];
      }
      current.items.push(option);
    }

    pushCurrent();
    return sections;
  }

  private hasSearchQuery(): boolean {
    return this.config.searchable === true && this.searchQuery.trim() !== "";
  }

  private matchesSearch(option: DropdownOption): boolean {
    const query = this.searchQuery.trim().toLocaleLowerCase();
    const haystack = [option.name, option.id, option.searchText]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLocaleLowerCase();

    return haystack.includes(query);
  }
}
