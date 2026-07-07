import { BlockWidget } from "./block-widget";
import type { WebviewContext } from "../context";

/**
 * Streaming text block. Accumulates markdown content and renders it via
 * the context's renderMarkdown helper.
 */
export class TextBlock extends BlockWidget {
  private rawContent = "";

  constructor(
    ctx: WebviewContext,
    element: HTMLElement,
    contentEl: HTMLElement
  ) {
    super(ctx, element, contentEl, "text:main", "text");
  }

  static create(ctx: WebviewContext): TextBlock {
    const blockEl = ctx.doc.createElement("div");
    blockEl.className = "block block-text";
    return new TextBlock(ctx, blockEl, blockEl);
  }

  appendContent(text: string): void {
    this.rawContent += text;
    this.contentEl.innerHTML = this.ctx.renderMarkdown(this.rawContent);
    this.element.setAttribute("data-raw-content", this.rawContent);
  }

  finalize(): void {
    // Text blocks have no collapse/finalize behavior.
  }

  getRawContent(): string {
    return this.rawContent;
  }
}
