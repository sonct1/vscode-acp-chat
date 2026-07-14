import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  constructor(private readonly sessionFile: string) {}

  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: this.sessionFile, updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

function makeSessionFile(entries: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-load-mode-test-'))
  const sessionFile = join(root, 's.jsonl')
  writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  return sessionFile
}

async function withEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const old = process.env.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE
  if (value === undefined) delete process.env.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE
  else process.env.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE = value

  try {
    return await run()
  } finally {
    if (old === undefined) delete process.env.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE
    else process.env.VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE = old
  }
}

test('PiAcpAgent: compacted load mode uses proc.getMessages as primary source', async () => {
  const sessionFile = makeSessionFile([
    { type: 'message', id: 'jsonl-1', parentId: null, message: { role: 'user', content: 'from jsonl' } }
  ])

  const originalSpawn = PiRpcProcess.spawn
  let getMessagesCalls = 0
  ;(PiRpcProcess as any).spawn = async () => ({
    onEvent: () => () => {},
    getMessages: async () => {
      getMessagesCalls += 1
      return { messages: [{ role: 'user', content: 'from rpc' }] }
    },
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  })

  try {
    await withEnv('compacted', async () => {
      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn))
      ;(agent as any).store = new FakeStore(sessionFile)

      await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

      const updates = conn.updates.map(u => (u as any).update)
      assert.equal(getMessagesCalls, 1)
      assert.ok(updates.some(u => u?.sessionUpdate === 'user_message_chunk' && u.content?.text === 'from rpc'))
      assert.ok(!updates.some(u => u?.sessionUpdate === 'user_message_chunk' && u.content?.text === 'from jsonl'))
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: full load mode falls back to proc.getMessages when JSONL has no replayable messages', async () => {
  const sessionFile = makeSessionFile([{ type: 'session', id: 'sess', cwd: '/tmp/project' }])

  const originalSpawn = PiRpcProcess.spawn
  let getMessagesCalls = 0
  ;(PiRpcProcess as any).spawn = async () => ({
    onEvent: () => () => {},
    getMessages: async () => {
      getMessagesCalls += 1
      return { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'fallback rpc' }] }] }
    },
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  })

  try {
    await withEnv('full', async () => {
      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn))
      ;(agent as any).store = new FakeStore(sessionFile)

      await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

      const updates = conn.updates.map(u => (u as any).update)
      assert.equal(getMessagesCalls, 1)
      assert.ok(updates.some(u => u?.sessionUpdate === 'agent_message_chunk' && u.content?.text === 'fallback rpc'))
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
