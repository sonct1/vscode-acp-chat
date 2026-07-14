import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  maybeGet(sessionId: string) {
    return sessionId === this.session.sessionId ? this.session : undefined
  }
}

test('PiAcpAgent: setSessionMode maps to pi setThinkingLevel + emits sync updates', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const thinkingLevels: string[] = []
  const session = {
    sessionId: 's1',
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return state
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionMode({ sessionId: 's1', modeId: 'high' } as any)

  assert.deepEqual(thinkingLevels, ['high'])
  assert.equal(conn.updates[0]?.update.sessionUpdate, 'current_mode_update')
  assert.equal((conn.updates[0]?.update as any).currentModeId, 'high')
  assert.equal(conn.updates[1]?.update.sessionUpdate, 'config_option_update')
  assert.equal(
    (conn.updates[1]?.update as any).configOptions.find((option: any) => option.id === 'thought_level')?.currentValue,
    'high'
  )
})

test('PiAcpAgent: setSessionMode rejects unknown mode ids', async () => {
  const conn = new FakeAgentSideConnection()
  const session = { sessionId: 's1', proc: {} }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await assert.rejects(() => agent.setSessionMode({ sessionId: 's1', modeId: 'invalid' } as any), {
    name: 'RequestError'
  })
})
