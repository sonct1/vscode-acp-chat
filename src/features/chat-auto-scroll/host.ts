import * as vscode from "vscode";
import {
  CHAT_AUTO_SCROLL_CONFIG_SECTION,
  CHAT_AUTO_SCROLL_CONFIG_BOTTOM_THRESHOLD_KEY,
  CHAT_AUTO_SCROLL_CONFIG_SETTLE_FRAMES_KEY,
  CHAT_AUTO_SCROLL_FULL_BOTTOM_THRESHOLD_KEY,
  CHAT_AUTO_SCROLL_FULL_SETTLE_FRAMES_KEY,
  CHAT_AUTO_SCROLL_MESSAGE_TYPE,
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT,
  CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT,
  normalizeChatAutoScrollSettings,
} from "./types";

export interface ChatAutoScrollHostOptions {
  postMessage: (message: Record<string, unknown>) => void;
}

export class ChatAutoScrollHostController implements vscode.Disposable {
  private readonly configListener: vscode.Disposable;

  constructor(private readonly options: ChatAutoScrollHostOptions) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(
          CHAT_AUTO_SCROLL_FULL_BOTTOM_THRESHOLD_KEY
        ) ||
        event.affectsConfiguration(CHAT_AUTO_SCROLL_FULL_SETTLE_FRAMES_KEY)
      ) {
        this.sendSettings();
      }
    });
  }

  sendSettings(): void {
    const config = vscode.workspace.getConfiguration(
      CHAT_AUTO_SCROLL_CONFIG_SECTION
    );
    const rawBottomThreshold = config.get<number>(
      CHAT_AUTO_SCROLL_CONFIG_BOTTOM_THRESHOLD_KEY,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT
    );
    const rawSettleFrames = config.get<number>(
      CHAT_AUTO_SCROLL_CONFIG_SETTLE_FRAMES_KEY,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT
    );

    const settings = normalizeChatAutoScrollSettings({
      bottomThresholdPx: rawBottomThreshold,
      settleFrames: rawSettleFrames,
    });

    this.options.postMessage({
      type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
      settings,
    });
  }

  dispose(): void {
    this.configListener.dispose();
  }
}

export function registerChatAutoScrollHostFeature(
  options: ChatAutoScrollHostOptions
): ChatAutoScrollHostController {
  return new ChatAutoScrollHostController(options);
}
