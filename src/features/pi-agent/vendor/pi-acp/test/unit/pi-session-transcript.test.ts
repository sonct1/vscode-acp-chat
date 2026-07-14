import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPiSessionTranscript } from '../../src/acp/pi-session-transcript.js'

function writeJsonl(entries: Array<unknown> | string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-transcript-test-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(
    file,
    entries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n',
    'utf8'
  )
  return file
}

test('readPiSessionTranscript returns full active path across compaction metadata', async () => {
  const file = writeJsonl([
    { type: 'session', id: 'sess', cwd: '/tmp/project' },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'first prompt' } },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }
    },
    { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'second prompt' } },
    {
      type: 'message',
      id: 'a2',
      parentId: 'u2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] }
    },
    { type: 'compaction', id: 'c1', parentId: 'a2', firstKeptEntryId: 'u2' },
    { type: 'message', id: 'u3', parentId: 'c1', message: { role: 'user', content: 'after compact' } },
    {
      type: 'message',
      id: 'a3',
      parentId: 'u3',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }
    }
  ])

  const messages = await readPiSessionTranscript(file)
  assert.deepEqual(
    messages.map(message => (message.role === 'toolResult' ? message.role : message.content)),
    [
      'first prompt',
      [{ type: 'text', text: 'first answer' }],
      'second prompt',
      [{ type: 'text', text: 'second answer' }],
      'after compact',
      [{ type: 'text', text: 'final answer' }]
    ]
  )
})

test('readPiSessionTranscript follows active branch and skips abandoned branch entries', async () => {
  const file = writeJsonl([
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'root' } },
    {
      type: 'message',
      id: 'side',
      parentId: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] }
    },
    {
      type: 'message',
      id: 'main',
      parentId: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'active' }] }
    }
  ])

  const messages = await readPiSessionTranscript(file)
  assert.deepEqual(
    messages.map(message => (message.role === 'toolResult' ? message.role : message.content)),
    ['root', [{ type: 'text', text: 'active' }]]
  )
})

test('readPiSessionTranscript skips malformed lines and falls back to file order for no-id entries', async () => {
  const file = writeJsonl([
    '{bad json',
    { type: 'session', id: 'legacy-session', cwd: '/tmp/project' },
    { type: 'message', message: { role: 'user', content: 'legacy user' } },
    { type: 'metadata', value: true },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }] } }
  ])

  const messages = await readPiSessionTranscript(file)
  assert.deepEqual(
    messages.map(message => (message.role === 'toolResult' ? message.role : message.content)),
    ['legacy user', [{ type: 'text', text: 'legacy assistant' }]]
  )
})

test('readPiSessionTranscript returns toolResult replay messages from JSONL', async () => {
  const toolResult = {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'ok' }]
  }
  const file = writeJsonl([{ type: 'message', id: 't1', parentId: null, message: toolResult }])

  const messages = await readPiSessionTranscript(file)
  assert.deepEqual(messages, [{ role: 'toolResult', message: toolResult }])
})
