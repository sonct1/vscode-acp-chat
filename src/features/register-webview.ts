import type { WebviewController } from "../views/webview/main";
import { registerAssistantTurnNavigationWebviewFeature } from "./assistant-turn-navigation/webview";
import { registerChatFontSizeWebviewFeature } from "./chat-font-size/webview";
import { registerMultiSessionWebviewFeature } from "./multi-session/webview";
import { registerPromptHistoryNavigationWebviewFeature } from "./prompt-history-navigation/webview";
import { registerTableCopyWebviewFeature } from "./table-copy/webview";

export interface RegisteredWebviewFeatures {
  chatFontSize: ReturnType<typeof registerChatFontSizeWebviewFeature>;
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
    chatFontSize: registerChatFontSizeWebviewFeature(controller),
    multiSession: registerMultiSessionWebviewFeature(controller),
    promptHistoryNavigation:
      registerPromptHistoryNavigationWebviewFeature(controller),
    tableCopy: registerTableCopyWebviewFeature(controller),
    assistantTurnNavigation:
      registerAssistantTurnNavigationWebviewFeature(controller),
  };
}
