import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, type StopReason } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function resolvedReason(promise: Promise<StopReason>): Promise<StopReason | undefined> {
  const pending = Symbol('pending')
  const result = await Promise.race<StopReason | typeof pending>([
    promise,
    new Promise<typeof pending>(resolve => setTimeout(() => resolve(pending), 0))
  ])
  return result === pending ? undefined : result
}

test('PiAcpSession: completes RPC prompts that resolve without starting an agent loop', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 1, pollIntervalMs: 1, getStateTimeoutMs: 5 }
  })

  const result = session.prompt('/plannotator')

  assert.equal(await result, 'end_turn')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, '/plannotator')
  assert.ok(proc.getStateCount >= 2)
})

test('PiAcpSession: no-agent-loop completion is invalidated if an agent loop starts before RPC prompt resolves', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const promptDeferred = deferred<void>()
  proc.promptPromiseSequence.push(promptDeferred.promise)
  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 1, pollIntervalMs: 1, getStateTimeoutMs: 5 }
  })

  const result = session.prompt('normal prompt')
  proc.emit({ type: 'agent_start' })
  promptDeferred.resolve()

  assert.equal(await resolvedReason(result), undefined)

  proc.emit({ type: 'agent_end' })
  assert.equal(await result, 'end_turn')
})
