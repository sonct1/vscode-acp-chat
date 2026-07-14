export type PiHistoryLoadMode = "full" | "compacted";

export const DEFAULT_PI_HISTORY_LOAD_MODE: PiHistoryLoadMode = "full";

export function parsePiHistoryLoadMode(value: unknown): PiHistoryLoadMode {
  return value === "compacted" || value === "full"
    ? value
    : DEFAULT_PI_HISTORY_LOAD_MODE;
}
