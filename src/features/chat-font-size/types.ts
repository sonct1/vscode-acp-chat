export const CHAT_FONT_SIZE_CONFIG_SECTION = "vscode-acp-chat";
export const CHAT_FONT_SIZE_SETTING = "fontSize";
export const CHAT_FONT_SIZE_CONFIG_KEY = `${CHAT_FONT_SIZE_CONFIG_SECTION}.${CHAT_FONT_SIZE_SETTING}`;
export const CHAT_FONT_SIZE_MESSAGE_TYPE = "feature.chat-font-size.settings";

export const MIN_CHAT_FONT_SIZE = 8;
export const MAX_CHAT_FONT_SIZE = 40;

export interface ChatFontSizeSettingsMessage {
  type: typeof CHAT_FONT_SIZE_MESSAGE_TYPE;
  fontSize: number | null;
}

export function normalizeChatFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const rounded = Math.round(value);
  return Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, rounded));
}
