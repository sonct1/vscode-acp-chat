import type { EventBus } from "../../views/webview/event-bus";
import type { WebviewController } from "../../views/webview/main";
import type { WebviewEventMap } from "../../views/webview/types";
import { detectExactResourceLink, detectResourceLinks } from "./detector";
import {
  OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE,
  type DetectedResourceLink,
} from "./types";

const SKIP_TEXT_NODE_ANCESTOR_SELECTOR = [
  "a",
  "pre",
  "button",
  "textarea",
  ".mention-chip",
  ".command-chip",
  ".code-block-wrapper",
  ".table-copy-wrapper",
  ".tool-item",
].join(",");

export class ClickableResourceLinksWebviewController {
  constructor(
    private readonly doc: Document,
    private readonly messagesEl: HTMLElement,
    private readonly eventBus: EventBus<WebviewEventMap>,
    private readonly postMessage: (message: unknown) => void
  ) {
    this.eventBus.on("markdownRendered", ({ root, kind }) => {
      if (kind !== "text") return;
      this.linkifyMarkdownRoot(root);
    });
    this.setupExternalLinkHandler();
  }

  linkifyMarkdownRoot(root: HTMLElement): void {
    this.linkifyInlineCode(root);
    this.linkifyTextNodes(root);
  }

  private linkifyInlineCode(root: HTMLElement): void {
    const codeNodes = Array.from(root.querySelectorAll("code"));
    for (const code of codeNodes) {
      if (!(code instanceof this.doc.defaultView!.HTMLElement)) continue;
      if (code.closest("pre")) continue;
      if (code.closest("a")) continue;

      const text = code.textContent ?? "";
      const link = detectExactResourceLink(text);
      if (!link) continue;

      const anchor = this.createAnchor(link);
      anchor.classList.add("acp-inline-code-link");
      anchor.textContent = "";
      code.replaceWith(anchor);
      anchor.append(code);
    }
  }

  private linkifyTextNodes(root: HTMLElement): void {
    const walker = this.doc.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.textContent || !node.textContent.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(SKIP_TEXT_NODE_ANCESTOR_SELECTOR)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }

    for (const textNode of textNodes) {
      this.linkifyTextNode(textNode);
    }
  }

  private linkifyTextNode(textNode: Text): void {
    const text = textNode.nodeValue ?? "";
    const links = detectResourceLinks(text);
    if (links.length === 0) return;

    const fragment = this.doc.createDocumentFragment();
    let cursor = 0;
    for (const link of links) {
      if (link.start > cursor) {
        fragment.append(this.doc.createTextNode(text.slice(cursor, link.start)));
      }
      fragment.append(this.createAnchor(link));
      cursor = link.end;
    }

    if (cursor < text.length) {
      fragment.append(this.doc.createTextNode(text.slice(cursor)));
    }

    textNode.replaceWith(fragment);
  }

  private createAnchor(link: DetectedResourceLink): HTMLAnchorElement {
    const anchor = this.doc.createElement("a");
    anchor.className = "acp-resource-link";
    anchor.dataset.acpResourceKind = link.kind;
    anchor.dataset.acpLinkified = "true";
    anchor.setAttribute("href", link.href);
    anchor.textContent = link.text;

    if (link.kind === "web") {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.title = `Open external link ${link.text}`;
      anchor.setAttribute("aria-label", `Open external link ${link.text}`);
    } else {
      anchor.dataset.acpCheckExists = "true";
      anchor.title = `Open file ${link.text}`;
      anchor.setAttribute("aria-label", `Open file ${link.text}`);
    }

    return anchor;
  }

  private setupExternalLinkHandler(): void {
    this.messagesEl.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest("a") as HTMLAnchorElement | null;
        if (!anchor || !this.messagesEl.contains(anchor)) return;

        const href = anchor.getAttribute("href");
        if (!href || href.startsWith("#")) return;

        if (!isSupportedExternalHref(href)) return;

        event.preventDefault();
        event.stopPropagation();
        this.postMessage({
          type: OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE,
          url: href,
        });
      },
      true
    );
  }
}

function isSupportedExternalHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerClickableResourceLinksWebviewFeature(
  controller: WebviewController
): ClickableResourceLinksWebviewController {
  return new ClickableResourceLinksWebviewController(
    controller.getDocument(),
    controller.messageList.elements.messagesEl,
    controller.getEventBus(),
    (message) => controller.getVsCodeApi().postMessage(message)
  );
}
