export const CHAT_AUTO_SCROLL_CONFIG_SECTION = "vscode-acp-chat";
export const CHAT_AUTO_SCROLL_CONFIG_BOTTOM_THRESHOLD_KEY =
  "autoScroll.bottomThreshold";
export const CHAT_AUTO_SCROLL_CONFIG_SETTLE_FRAMES_KEY =
  "autoScroll.settleFrames";
export const CHAT_AUTO_SCROLL_FULL_BOTTOM_THRESHOLD_KEY = `${CHAT_AUTO_SCROLL_CONFIG_SECTION}.${CHAT_AUTO_SCROLL_CONFIG_BOTTOM_THRESHOLD_KEY}`;
export const CHAT_AUTO_SCROLL_FULL_SETTLE_FRAMES_KEY = `${CHAT_AUTO_SCROLL_CONFIG_SECTION}.${CHAT_AUTO_SCROLL_CONFIG_SETTLE_FRAMES_KEY}`;

export const CHAT_AUTO_SCROLL_MESSAGE_TYPE =
  "feature.chat-auto-scroll.settings";

export const CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MIN = 0;
export const CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MAX = 500;
export const CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT = 100;
export const CHAT_AUTO_SCROLL_SETTLE_FRAMES_MIN = 1;
export const CHAT_AUTO_SCROLL_SETTLE_FRAMES_MAX = 20;
export const CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT = 3;

export interface ChatAutoScrollSettings {
  bottomThresholdPx: number;
  settleFrames: number;
}

export interface ChatAutoScrollSettingsMessage {
  type: typeof CHAT_AUTO_SCROLL_MESSAGE_TYPE;
  settings: ChatAutoScrollSettings;
}

function normalizeNumber(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeChatAutoScrollSettings(raw: {
  bottomThresholdPx: unknown;
  settleFrames: unknown;
}): ChatAutoScrollSettings {
  return {
    bottomThresholdPx: normalizeNumber(
      raw.bottomThresholdPx,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MIN,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MAX
    ),
    settleFrames: normalizeNumber(
      raw.settleFrames,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_MIN,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_MAX
    ),
  };
}

export function isChatAutoScrollSettingsMessage(
  message: unknown
): message is ChatAutoScrollSettingsMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ChatAutoScrollSettingsMessage>;
  if (candidate.type !== CHAT_AUTO_SCROLL_MESSAGE_TYPE) return false;
  if (!candidate.settings || typeof candidate.settings !== "object")
    return false;
  const s = candidate.settings as Partial<ChatAutoScrollSettings>;
  return (
    typeof s.bottomThresholdPx === "number" &&
    typeof s.settleFrames === "number"
  );
}
