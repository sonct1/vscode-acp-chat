import type { BlockType, ToolKind } from "../types";
import type { WebviewContext } from "../context";

/**
 * Abstract base class for streaming content blocks (text, thought, tool).
 *
 * Each block owns a DOM subtree that is appended to the current assistant
 * message. Subclasses implement appendContent() and finalize() for their
 * specific rendering semantics.
 */
export abstract class BlockWidget {
  readonly element: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly blockKey: string;
  readonly blockType: BlockType;

  toolId?: string;
  kind?: ToolKind;
  title?: string;
  status?: string;

  constructor(
    protected ctx: WebviewContext,
    element: HTMLElement,
    contentEl: HTMLElement,
    blockKey: string,
    blockType: BlockType
  ) {
    this.element = element;
    this.contentEl = contentEl;
    this.blockKey = blockKey;
    this.blockType = blockType;
  }

  /**
   * Append streamed text to this block. The meaning of "text" depends on
   * the concrete subclass (markdown for text/thought, structured data for tool).
   */
  abstract appendContent(text: string): void;

  /**
   * Called when the stream moves to a new block or the stream ends.
   * Subclasses may collapse UI, remove spinners, etc.
   */
  abstract finalize(): void;

  /**
   * Insert this block's DOM element into the given parent, optionally
   * before a reference node (e.g. the typing indicator).
   */
  attachTo(parent: HTMLElement, before?: HTMLElement | null): void {
    if (before && before.parentNode === parent) {
      parent.insertBefore(this.element, before);
    } else {
      parent.appendChild(this.element);
    }
  }
}
