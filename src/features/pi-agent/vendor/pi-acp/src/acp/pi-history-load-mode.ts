export type PiHistoryLoadMode = 'full' | 'compacted'

export const DEFAULT_PI_HISTORY_LOAD_MODE: PiHistoryLoadMode = 'full'

export function parsePiHistoryLoadMode(value: unknown): PiHistoryLoadMode {
  return value === 'compacted' || value === 'full' ? value : DEFAULT_PI_HISTORY_LOAD_MODE
}

export function getPiHistoryLoadModeFromEnv(env: NodeJS.ProcessEnv = process.env): PiHistoryLoadMode {
  return parsePiHistoryLoadMode(env.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE)
}
