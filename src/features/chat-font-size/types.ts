export const CHAT_FONT_SIZE_CONFIG_SECTION = "vscode-acp-chat";
export const CHAT_FONT_SIZE_CONFIG_KEY = "fontSize";
export const CHAT_FONT_SIZE_FULL_CONFIG_KEY = `${CHAT_FONT_SIZE_CONFIG_SECTION}.${CHAT_FONT_SIZE_CONFIG_KEY}`;

export const CHAT_FONT_SIZE_MESSAGE_TYPE = "feature.chat-font-size.settings";
export const CHAT_FONT_SIZE_MIN = 8;
export const CHAT_FONT_SIZE_MAX = 40;

export interface ChatFontSizeSettingsMessage {
  type: typeof CHAT_FONT_SIZE_MESSAGE_TYPE;
  fontSize: number | null;
}

export function normalizeChatFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(
    CHAT_FONT_SIZE_MAX,
    Math.max(CHAT_FONT_SIZE_MIN, Math.round(value))
  );
}

export function isChatFontSizeSettingsMessage(
  message: unknown
): message is ChatFontSizeSettingsMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ChatFontSizeSettingsMessage>;
  return (
    candidate.type === CHAT_FONT_SIZE_MESSAGE_TYPE &&
    (candidate.fontSize === null || typeof candidate.fontSize === "number")
  );
}
