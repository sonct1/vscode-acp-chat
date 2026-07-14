import * as vscode from "vscode";
import {
  CHAT_FONT_SIZE_CONFIG_KEY,
  CHAT_FONT_SIZE_CONFIG_SECTION,
  CHAT_FONT_SIZE_FULL_CONFIG_KEY,
  CHAT_FONT_SIZE_MESSAGE_TYPE,
  normalizeChatFontSize,
} from "./types";

export interface ChatFontSizeHostOptions {
  postMessage: (message: Record<string, unknown>) => void;
}

export class ChatFontSizeHostController implements vscode.Disposable {
  private readonly configListener: vscode.Disposable;

  constructor(private readonly options: ChatFontSizeHostOptions) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CHAT_FONT_SIZE_FULL_CONFIG_KEY)) {
        this.sendSettings();
      }
    });
  }

  sendSettings(): void {
    const rawValue = vscode.workspace
      .getConfiguration(CHAT_FONT_SIZE_CONFIG_SECTION)
      .get<number>(CHAT_FONT_SIZE_CONFIG_KEY, 0);

    this.options.postMessage({
      type: CHAT_FONT_SIZE_MESSAGE_TYPE,
      fontSize: normalizeChatFontSize(rawValue),
    });
  }

  dispose(): void {
    this.configListener.dispose();
  }
}

export function registerChatFontSizeHostFeature(
  options: ChatFontSizeHostOptions
): ChatFontSizeHostController {
  return new ChatFontSizeHostController(options);
}
