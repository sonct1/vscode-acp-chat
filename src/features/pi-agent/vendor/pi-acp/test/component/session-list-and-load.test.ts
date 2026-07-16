import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('PiAcpAgent: repairs a stale session map before a second-process load', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-reload-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_reload.jsonl')
  const mapPath = join(root, 'session-map.json')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'reload-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )
  writeFileSync(
    mapPath,
    JSON.stringify({
      version: 1,
      sessions: {
        'reload-session': {
          sessionId: 'reload-session',
          cwd: '/tmp/project',
          sessionFile,
          updatedAt: new Date(0).toISOString(),
          fileSize: 1,
          fileMtimeMs: 1
        }
      }
    }),
    'utf8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () =>
    ({
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ sessionFile, thinkingLevel: 'medium' })
    }) as any

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {
      sessionStorePath: mapPath
    })
    await agent.loadSession({
      sessionId: 'reload-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)

    const stored = JSON.parse(readFileSync(mapPath, 'utf8')).sessions['reload-session']
    const signature = statSync(sessionFile)
    assert.equal(stored.sessionFile, sessionFile)
    assert.equal(stored.fileSize, signature.size)
    assert.equal(stored.fileMtimeMs, signature.mtimeMs)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  }
})

test('PiAcpAgent: listSessions lists pi sessions and loadSession replays history', async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc. Default full replay should not call getMessages.
    const originalSpawn = PiRpcProcess.spawn

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => {
          throw new Error('getMessages should not be called when full JSONL replay succeeds')
        },
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
