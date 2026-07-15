import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { discoverPiSessionsSnapshot, invalidatePiSessionIndex, listPiSessions } from '../../src/acp/pi-sessions.js'
import { getPiAcpSessionMapPath } from '../../src/acp/paths.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

async function withPiAgentDir<T>(root: string, fn: () => T | Promise<T>): Promise<T> {
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  invalidatePiSessionIndex()
  try {
    return await fn()
  } finally {
    invalidatePiSessionIndex()
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
  }
}

function writeSessionFile(
  path: string,
  opts: { id: string; cwd?: string; title?: string; text?: string; ts?: string }
) {
  mkdirSync(join(path, '..'), { recursive: true })
  const ts = opts.ts ?? '2026-01-01T00:00:00.000Z'
  const lines = [
    { type: 'session', version: 3, id: opts.id, timestamp: ts, cwd: opts.cwd ?? '/tmp/project' },
    {
      type: 'message',
      id: `${opts.id}-m1`,
      parentId: null,
      timestamp: ts,
      message: { role: 'user', content: opts.text ?? `hello ${opts.id}` }
    }
  ]
  if (opts.title) {
    lines.push({
      type: 'session_info',
      id: `${opts.id}-info`,
      parentId: `${opts.id}-m1`,
      timestamp: ts,
      name: opts.title
    } as any)
  }
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8')
}

function readSessionMap(): Record<string, { cwd: string; sessionFile: string; fileSize?: number | null; fileMtimeMs?: number | null }> {
  const path = getPiAcpSessionMapPath()
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')).sessions
}

test('Pi session index: cold one-pass then warm zero content parse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-index-'))
  const file = join(root, 'sessions', 'p', 's1.jsonl')
  writeSessionFile(file, { id: 's1', title: 'One' })

  await withPiAgentDir(root, () => {
    const cold = discoverPiSessionsSnapshot()
    assert.equal(cold.counters.metadataParsed, 1)
    assert.equal(cold.counters.unchangedIndexHits, 0)
    assert.equal(cold.counters.discoveryScans, 1)
    assert.equal(cold.items[0]?.title, 'One')

    const warm = discoverPiSessionsSnapshot()
    assert.equal(warm.counters.discoveryScans, 0)
    assert.equal(warm.counters.filesEnumerated, 0)
    assert.equal(warm.counters.filesStat, 0)
    assert.equal(warm.counters.metadataParsed, 0)
    assert.equal(warm.counters.unchangedIndexHits, 0)
  })
})

test('Pi session index: changed, deleted, and renamed files invalidate entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-index-invalidate-'))
  const dir = join(root, 'sessions', 'p')
  const file = join(dir, 's1.jsonl')
  const renamed = join(dir, 's1-renamed.jsonl')
  writeSessionFile(file, { id: 's1', title: 'Old' })

  await withPiAgentDir(root, () => {
    assert.equal(listPiSessions().find(s => s.sessionId === 's1')?.title, 'Old')

    writeSessionFile(file, { id: 's1', title: 'New', text: 'changed' })
    const changed = discoverPiSessionsSnapshot({ force: true })
    assert.equal(changed.counters.metadataParsed, 1)
    assert.equal(changed.items.find(s => s.sessionId === 's1')?.title, 'New')

    renameSync(file, renamed)
    // After rename, force refresh walks and discovers the file at its new location
    const afterRename = discoverPiSessionsSnapshot({ force: true })
    assert.equal(afterRename.items.find(s => s.sessionId === 's1')?.sessionFile, renamed)

    rmSync(renamed)
    const afterDelete = discoverPiSessionsSnapshot({ force: true })
    assert.equal(
      afterDelete.items.find(s => s.sessionId === 's1'),
      undefined
    )
  })
})

test('Pi session index: canonical paths dedupe internal symlinks and reject external symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-index-symlink-'))
  const file = join(root, 'sessions', 'p', 's1.jsonl')
  const linked = join(root, 'sessions', 'p', 's1-link.jsonl')
  const external = join(root, 'external.jsonl')
  const externalLink = join(root, 'sessions', 'p', 'external-link.jsonl')
  writeSessionFile(file, { id: 's1' })
  writeSessionFile(external, { id: 'external' })
  symlinkSync(file, linked)
  symlinkSync(external, externalLink)

  await withPiAgentDir(root, () => {
    const snapshot = discoverPiSessionsSnapshot()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0]?.sessionId, 's1')
  })
})

test('Pi session index: settings sessionDir changes invalidate previous directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-index-settings-'))
  const first = join(root, 'sessions-a')
  const second = join(root, 'sessions-b')
  writeSessionFile(join(first, 'p', 'a.jsonl'), { id: 'a' })
  writeSessionFile(join(second, 'p', 'b.jsonl'), { id: 'b' })
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: first }), 'utf8')

  await withPiAgentDir(root, () => {
    assert.deepEqual(
      listPiSessions().map(s => s.sessionId),
      ['a']
    )

    writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: second }), 'utf8')
    const changed = discoverPiSessionsSnapshot()
    assert.equal(changed.counters.metadataParsed, 1)
    assert.deepEqual(
      changed.items.map(s => s.sessionId),
      ['b']
    )
  })
})

test('PiAcpAgent: concurrent first pages keep independent opaque cursor snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-pagination-concurrent-'))
  for (let i = 0; i < 60; i++) {
    writeSessionFile(join(root, 'sessions', 'p', `s${i}.jsonl`), {
      id: `s${i}`,
      cwd: '/tmp/project',
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
    })
  }

  await withPiAgentDir(root, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const firstA = await agent.listSessions({ cwd: '/tmp/project', cursor: null, _meta: null } as any)
    const firstB = await agent.listSessions({ cwd: '/tmp/project', cursor: null, _meta: null } as any)
    assert.notEqual(firstA.nextCursor, firstB.nextCursor)

    writeSessionFile(join(root, 'sessions', 'p', 'new.jsonl'), {
      id: 'new',
      cwd: '/tmp/project',
      ts: '2026-01-01T00:01:30.000Z'
    })
    const secondA = await agent.listSessions({ cwd: '/tmp/project', cursor: firstA.nextCursor, _meta: null } as any)
    assert.equal(secondA.sessions.length, 10)
    assert.equal(
      secondA.sessions.some(session => session.sessionId === 'new'),
      false
    )
  })
})

test('PiAcpAgent: page 2 reuses discovery snapshot and list bulk persists mappings for direct load', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-pagination-'))
  for (let i = 0; i < 55; i++) {
    writeSessionFile(join(root, 'sessions', 'p', `s${i}.jsonl`), {
      id: `s${i}`,
      title: `Session ${i}`,
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
    })
  }

  await withPiAgentDir(root, async () => {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const first = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    const beforePage2 = discoverPiSessionsSnapshot().counters
    assert.ok(first.nextCursor)
    assert.doesNotMatch(first.nextCursor ?? '', /^\d+$/)
    const second = await agent.listSessions({ cwd: null, cursor: first.nextCursor, _meta: null } as any)
    const afterPage2 = discoverPiSessionsSnapshot().counters

    assert.equal(first.sessions.length, 50)
    assert.equal(second.sessions.length, 5)
    assert.equal(beforePage2.metadataParsed, 0, 'probe after initial list should be warm')
    assert.equal(afterPage2.metadataParsed, 0, 'page 2 should not force a content parse')

    const map = readSessionMap()
    assert.ok(map.s0)
    assert.ok(map.s54)

    let spawnCount = 0
    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async () => {
      spawnCount += 1
      return {
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      const agent2 = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
      await agent2.loadSession({ sessionId: 's54', cwd: '/tmp/project', mcpServers: [] } as any)
      assert.equal(spawnCount, 1)
      assert.equal(discoverPiSessionsSnapshot().counters.metadataParsed, 0)
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  })
})

test('PiAcpAgent: stale stored mapping falls back to scan and repairs mapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-stale-map-'))
  const file = join(root, 'sessions', 'p', 's1.jsonl')
  writeSessionFile(file, { id: 's1' })

  await withPiAgentDir(root, async () => {
    const mapPath = getPiAcpSessionMapPath()
    mkdirSync(join(mapPath, '..'), { recursive: true })
    writeFileSync(
      mapPath,
      JSON.stringify({
        version: 1,
        sessions: {
          s1: {
            sessionId: 's1',
            cwd: '/tmp/project',
            sessionFile: join(root, 'missing.jsonl'),
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      }) + '\n',
      'utf8'
    )

    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async (params: any) => {
      assert.equal(params.sessionPath, file)
      return {
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
      await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
      const repaired = readSessionMap().s1
      const fileStat = statSync(file)
      assert.equal(repaired?.sessionFile, file)
      assert.equal(repaired?.fileSize, fileStat.size)
      assert.equal(repaired?.fileMtimeMs, fileStat.mtimeMs)
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  })
})

test('PiAcpAgent: stale size/mtime mapping is ignored and repaired before load', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-stale-signature-map-'))
  const file = join(root, 'sessions', 'p', 's1.jsonl')
  writeSessionFile(file, { id: 's1' })

  await withPiAgentDir(root, async () => {
    const mapPath = getPiAcpSessionMapPath()
    mkdirSync(join(mapPath, '..'), { recursive: true })
    writeFileSync(
      mapPath,
      JSON.stringify({
        version: 1,
        sessions: {
          s1: {
            sessionId: 's1',
            cwd: '/tmp/project',
            sessionFile: file,
            updatedAt: '2026-01-01T00:00:00.000Z',
            fileSize: 1,
            fileMtimeMs: 1
          }
        }
      }) + '\n',
      'utf8'
    )

    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async (params: any) => {
      assert.equal(params.sessionPath, file)
      return {
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
      await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
      const repaired = readSessionMap().s1
      const fileStat = statSync(file)
      assert.equal(repaired?.sessionFile, file)
      assert.equal(repaired?.fileSize, fileStat.size)
      assert.equal(repaired?.fileMtimeMs, fileStat.mtimeMs)
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  })
})
