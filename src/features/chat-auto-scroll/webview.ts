import type { WebviewController } from "../../views/webview/main";
import type {
  ExtensionMessage,
  MessageScrollPosition,
} from "../../views/webview/types";
import { CHAT_AUTO_SCROLL_STYLES } from "./styles";
import {
  CHAT_AUTO_SCROLL_MESSAGE_TYPE,
  isChatAutoScrollSettingsMessage,
  normalizeChatAutoScrollSettings,
} from "./types";

export class ChatAutoScrollWebviewController {
  private readonly doc: Document;
  private readonly jumpButton: HTMLButtonElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly scrollPositionSubscription: { dispose(): void };

  constructor(private readonly controller: WebviewController) {
    this.doc = controller.getDocument();
    this.styleEl = this.injectStyles();
    this.jumpButton = this.createJumpButton();
    this.attachJumpButton();
    this.scrollPositionSubscription =
      controller.messageList.onScrollPositionChange((position) =>
        this.renderJumpButton(position)
      );
  }

  handleMessage(msg: ExtensionMessage): boolean | void {
    if (msg.type !== CHAT_AUTO_SCROLL_MESSAGE_TYPE) return;
    if (!isChatAutoScrollSettingsMessage(msg)) return true;

    const settings = normalizeChatAutoScrollSettings(msg.settings);
    this.controller.messageList.applyAutoScrollSettings(settings);
    return true;
  }

  dispose(): void {
    this.scrollPositionSubscription.dispose();
    this.jumpButton.remove();
    this.styleEl.remove();
  }

  private createJumpButton(): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = "chat-auto-scroll-jump-button";
    button.hidden = true;
    button.setAttribute("aria-label", "Scroll to latest message");
    button.setAttribute("acp-title", "Scroll to latest message");

    const iconEl = this.doc.createElement("span");
    iconEl.className = "codicon codicon-arrow-down";
    iconEl.setAttribute("aria-hidden", "true");
    button.appendChild(iconEl);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.controller.messageList.scrollToBottom(true);
    });

    return button;
  }

  private attachJumpButton(): void {
    const composerEl = this.doc.getElementById("chat-input-area");
    if (!composerEl) {
      throw new Error("Chat auto-scroll jump button requires the chat composer");
    }
    composerEl.appendChild(this.jumpButton);
  }

  private renderJumpButton(position: MessageScrollPosition): void {
    this.jumpButton.hidden = position.isNearBottom;
  }

  private injectStyles(): HTMLStyleElement {
    const style = this.doc.createElement("style");
    style.dataset.feature = "chat-auto-scroll";
    style.textContent = CHAT_AUTO_SCROLL_STYLES;
    this.doc.head.append(style);
    return style;
  }
}

export function registerChatAutoScrollWebviewFeature(
  controller: WebviewController
): ChatAutoScrollWebviewController {
  return new ChatAutoScrollWebviewController(controller);
}
