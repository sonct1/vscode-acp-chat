import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage } from "../../views/webview/types";
import {
  CHAT_FONT_SIZE_MESSAGE_TYPE,
  isChatFontSizeSettingsMessage,
  normalizeChatFontSize,
} from "./types";

export class ChatFontSizeWebviewController {
  constructor(private readonly doc: Document) {}

  handleMessage(msg: ExtensionMessage): boolean | void {
    if (msg.type !== CHAT_FONT_SIZE_MESSAGE_TYPE) return;
    if (!isChatFontSizeSettingsMessage(msg)) return true;

    const fontSize = normalizeChatFontSize(msg.fontSize);
    if (fontSize === null) {
      this.doc.documentElement.style.removeProperty("--acp-chat-font-size");
    } else {
      this.doc.documentElement.style.setProperty(
        "--acp-chat-font-size",
        `${fontSize}px`
      );
    }

    return true;
  }

  dispose(): void {}
}

export function registerChatFontSizeWebviewFeature(
  controller: WebviewController
): ChatFontSizeWebviewController {
  return new ChatFontSizeWebviewController(controller.getDocument());
}
