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
  upsertMany() {}
}

test('PiAcpAgent: loadSession replays toolResult as one final tool_call notification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-toolresult-test-'))
  const sessionFile = join(root, 's.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'message',
      id: 'tool-1',
      parentId: null,
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'hello from bash' }],
        isError: false
      }
    }) + '\n',
    'utf8'
  )

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => {
        throw new Error('getMessages should not be called when full JSONL replay succeeds')
      },
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCalls = updates.filter(u => u?.sessionUpdate === 'tool_call')
    assert.equal(toolCalls.length, 1)
    const toolCall = toolCalls[0]
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'bash')
    assert.equal(toolCall.status, 'completed')
    assert.equal(toolCall.content?.[0]?.content?.text, 'hello from bash')
    assert.deepEqual(toolCall.rawOutput, {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'hello from bash' }],
      isError: false
    })
    assert.equal(
      updates.some(u => u?.sessionUpdate === 'tool_call_update'),
      false
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
