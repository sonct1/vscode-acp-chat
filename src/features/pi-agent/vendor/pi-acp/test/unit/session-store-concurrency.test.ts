import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionStore } from '../../src/acp/session-store.js'

test('SessionStore merges mutations from multiple instances sharing one map file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-store-'))
  const mapPath = join(root, 'sessions.json')
  const first = new SessionStore(mapPath)
  const second = new SessionStore(mapPath)
  writeFileSync(join(root, 'a.jsonl'), '', 'utf8')
  writeFileSync(join(root, 'b.jsonl'), '', 'utf8')

  first.upsert({ sessionId: 'a', cwd: '/a', sessionFile: join(root, 'a.jsonl') })
  second.upsert({ sessionId: 'b', cwd: '/b', sessionFile: join(root, 'b.jsonl') })
  first.delete('a')

  const parsed = JSON.parse(readFileSync(mapPath, 'utf8')) as {
    sessions: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(parsed.sessions), ['b'])
})
