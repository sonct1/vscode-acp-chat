import test from 'node:test'
import assert from 'node:assert/strict'

import { getPiHistoryLoadModeFromEnv, parsePiHistoryLoadMode } from '../../src/acp/pi-history-load-mode.js'

test('parsePiHistoryLoadMode defaults to full for missing or invalid values', () => {
  assert.equal(parsePiHistoryLoadMode(undefined), 'full')
  assert.equal(parsePiHistoryLoadMode(''), 'full')
  assert.equal(parsePiHistoryLoadMode('invalid'), 'full')
})

test('parsePiHistoryLoadMode accepts full and compacted', () => {
  assert.equal(parsePiHistoryLoadMode('full'), 'full')
  assert.equal(parsePiHistoryLoadMode('compacted'), 'compacted')
})

test('getPiHistoryLoadModeFromEnv reads VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE', () => {
  assert.equal(getPiHistoryLoadModeFromEnv({ VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE: 'compacted' }), 'compacted')
  assert.equal(getPiHistoryLoadModeFromEnv({ VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE: 'bad' }), 'full')
})
