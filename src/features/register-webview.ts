import type { WebviewController } from "../views/webview/main";
import { registerAssistantTurnNavigationWebviewFeature } from "./assistant-turn-navigation/webview";
import { registerChatAutoScrollWebviewFeature } from "./chat-auto-scroll/webview";
import { registerChatFontSizeWebviewFeature } from "./chat-font-size/webview";
import { registerClickableResourceLinksWebviewFeature } from "./clickable-resource-links/webview";
import { registerLatestUserPromptTipWebviewFeature } from "./latest-user-prompt-tip/webview";
import { registerMessageQueueWebviewFeature } from "./message-queue/webview";
import { registerMultiSessionWebviewFeature } from "./multi-session/webview";
import { registerPromptHistoryNavigationWebviewFeature } from "./prompt-history-navigation/webview";
import { registerTableCopyWebviewFeature } from "./table-copy/webview";

export interface RegisteredWebviewFeatures {
  chatAutoScroll: ReturnType<typeof registerChatAutoScrollWebviewFeature>;
  chatFontSize: ReturnType<typeof registerChatFontSizeWebviewFeature>;
  clickableResourceLinks: ReturnType<
    typeof registerClickableResourceLinksWebviewFeature
  >;
  latestUserPromptTip: ReturnType<
    typeof registerLatestUserPromptTipWebviewFeature
  >;
  messageQueue: ReturnType<typeof registerMessageQueueWebviewFeature>;
  multiSession: ReturnType<typeof registerMultiSessionWebviewFeature>;
  promptHistoryNavigation: ReturnType<
    typeof registerPromptHistoryNavigationWebviewFeature
  >;
  tableCopy: ReturnType<typeof registerTableCopyWebviewFeature>;
  assistantTurnNavigation: ReturnType<
    typeof registerAssistantTurnNavigationWebviewFeature
  >;
}

export function registerWebviewFeatures(
  controller: WebviewController
): RegisteredWebviewFeatures {
  return {
    chatAutoScroll: registerChatAutoScrollWebviewFeature(controller),
    chatFontSize: registerChatFontSizeWebviewFeature(controller),
    clickableResourceLinks:
      registerClickableResourceLinksWebviewFeature(controller),
    latestUserPromptTip: registerLatestUserPromptTipWebviewFeature(controller),
    messageQueue: registerMessageQueueWebviewFeature(controller),
    multiSession: registerMultiSessionWebviewFeature(controller),
    promptHistoryNavigation:
      registerPromptHistoryNavigationWebviewFeature(controller),
    tableCopy: registerTableCopyWebviewFeature(controller),
    assistantTurnNavigation:
      registerAssistantTurnNavigationWebviewFeature(controller),
  };
}
