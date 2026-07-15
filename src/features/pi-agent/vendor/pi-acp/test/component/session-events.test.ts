import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession, type StopReason } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function resolvedReason(promise: Promise<StopReason>): Promise<StopReason | undefined> {
  const pending = Symbol('pending')
  const result = await Promise.race<StopReason | typeof pending>([promise, tick().then(() => pending)])
  return result === pending ? undefined : result
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: forwards pi session name changes as ACP session info updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'session_info_changed', name: 'First prompt title' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'session_info_update')
  assert.equal((conn.updates[0]!.update as any).title, 'First prompt title')
  assert.ok(!Number.isNaN(Date.parse(String((conn.updates[0]!.update as any).updatedAt))))
})

test('PiAcpSession: does not duplicate a session name already published by the adapter', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  await session.publishSessionTitle('Named session')
  proc.emit({ type: 'session_info_changed', name: 'Named session' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal((conn.updates[0]!.update as any).title, 'Named session')
})

test('PiAcpSession: ignores empty pi session name changes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'session_info_changed', name: '   ' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 0)
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: emits tool_call + tool_call_update + completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
})

test('PiAcpSession: emits tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: `${process.cwd()}/src/acp/session.ts` }])
})

test('PiAcpSession: handles extension select via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'pi-ui-ui-1',
      title: 'Pick one',
      kind: 'other',
      status: 'pending',
      rawInput: { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] }
    },
    options: [
      { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
      { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('PiAcpSession: handles extension confirm via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'no' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: false }])
})

test('PiAcpSession: sends cancelled response when ACP confirm is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-5', method: 'confirm', title: 'Continue?' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', cancelled: true }])
})

test('PiAcpSession: cancels unsupported input and editor extension UI requests with visible fallback', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Enter name' })
  proc.emit({ type: 'extension_ui_request', id: 'ui-4', method: 'editor', title: 'Edit text' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-3', cancelled: true },
    { id: 'ui-4', cancelled: true }
  ])
  assert.equal(conn.updates.length, 2)
  assert.match((conn.updates[0]!.update as any).content.text, /input UI request is not supported/)
  assert.match((conn.updates[1]!.update as any).content.text, /editor UI request is not supported/)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: emits streamed tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 't1',
        name: 'write',
        arguments: { path: '/tmp/test.txt', content: 'hello' }
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: '/tmp/test.txt' }])
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from edits array when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'needle', newText: 'replacement' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from stringified edits array', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-string-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: JSON.stringify([{ oldText: 'needle', newText: 'replacement' }]) }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt resolves end_turn on final idle agent_end and emits usage_update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  proc.sessionStats = {
    tokens: { input: 10, output: 5, total: 15 },
    contextUsage: { tokens: 15, contextWindow: 128000 },
    cost: 0.001,
    currency: 'USD'
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end', willRetry: false })
  const reason = await p
  await tick()

  assert.equal(reason, 'end_turn')
  const usageIndex = conn.updates.findIndex(update => update.update.sessionUpdate === 'usage_update')
  const usageUpdate = usageIndex >= 0 ? conn.updates[usageIndex] : undefined
  assert.ok(usageIndex >= 0)
  assert.equal(
    conn.updates.findIndex(update => update.update.sessionUpdate === 'session_info_update'),
    0
  )
  assert.ok(usageIndex < conn.updates.length)
  assert.deepEqual(usageUpdate?.update, {
    sessionUpdate: 'usage_update',
    used: 15,
    size: 128000,
    cost: { amount: 0.001, currency: 'USD' }
  })
})

test('PiAcpSession: final agent_end polls busy root state until idle without another lifecycle event', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.stateSequence = [
    { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  ]

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await p, 'end_turn')
  assert.ok(proc.getStateCount >= 3)
})

test('PiAcpSession: newer final agent_end is validated after stale deferred validation resolves', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const firstState = deferred<unknown>()
  proc.statePromiseSequence = [firstState.promise]
  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await tick()

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await tick()

  assert.equal(await resolvedReason(p), undefined)
  firstState.resolve({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 })

  assert.equal(await p, 'end_turn')
  assert.ok(proc.getStateCount >= 3)
})

test('PiAcpSession: cancellation during validation resolves cancelled and clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const firstState = deferred<unknown>()
  proc.statePromiseSequence = [firstState.promise]
  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await tick()

  await session.cancel()
  firstState.resolve({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 })

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: agent_end willRetry true stays pending through idle gap until final agent_end', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: true })
  await tick()

  assert.equal(await resolvedReason(p), undefined)
  assert.equal(conn.updates.some(update => (update.update as any)._meta?.piAcp?.running === false), false)

  proc.emit({ type: 'auto_retry_start', attempt: 2 })
  proc.emit({ type: 'auto_retry_end' })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: compaction continuation keeps prompt pending until later final agent_end', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'compaction_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'compaction_end' })
  await tick()

  assert.equal(await resolvedReason(p), undefined)
  assert.equal(
    conn.updates.filter(
      update =>
        update.update.sessionUpdate === 'agent_message_chunk' &&
        (update.update as any).content?.text?.includes('compaction')
    ).length,
    1
  )

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: agent_end followed by terminal compaction_end resolves without later agent_end', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'compaction_start' })
  proc.emit({ type: 'compaction_end', willRetry: false } as any)

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: compaction_end willRetry true stays pending until later final agent_end', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'compaction_start' })
  proc.emit({ type: 'compaction_end', willRetry: true } as any)
  await tick()

  assert.equal(await resolvedReason(p), undefined)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: delayed compaction_start during settle grace prevents stale completion', async () => {
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
    promptCompletionTiming: { settleGraceMs: 25, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(resolve => setTimeout(resolve, 8))
  proc.emit({ type: 'compaction_start' })
  await new Promise(resolve => setTimeout(resolve, 25))

  assert.equal(await resolvedReason(p), undefined)

  proc.emit({ type: 'compaction_end', willRetry: false } as any)

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: final state sample catches busy transition during settle grace without agent_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const sleeps: Array<{ ms: number; gate: ReturnType<typeof deferred<void>> }> = []
  proc.stateSequence = [
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  ]

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: {
      settleGraceMs: 5,
      pollIntervalMs: 2,
      getStateTimeoutMs: 5,
      sleep: ms => {
        const gate = deferred<void>()
        sleeps.push({ ms, gate })
        return gate.promise
      }
    }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await tick()

  assert.equal(sleeps.length, 1)
  assert.equal(sleeps[0]!.ms, 2)
  sleeps[0]!.gate.resolve()
  await tick()

  assert.equal(sleeps.length, 2)
  assert.equal(sleeps[1]!.ms, 5)
  sleeps[1]!.gate.resolve()
  await tick()

  assert.equal(await resolvedReason(p), undefined)
  assert.equal(sleeps.length, 3)
  assert.equal(sleeps[2]!.ms, 2)

  sleeps[2]!.gate.resolve()
  await tick()
  assert.equal(sleeps.length, 4)
  assert.equal(sleeps[3]!.ms, 2)
  sleeps[3]!.gate.resolve()
  await tick()
  assert.equal(sleeps.length, 5)
  assert.equal(sleeps[4]!.ms, 5)
  sleeps[4]!.gate.resolve()

  assert.equal(await p, 'end_turn')
  assert.ok(proc.getStateCount >= 6)
})

test('PiAcpSession: compaction_start during final usage refresh prevents stale completion', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const stats = deferred<unknown>()
  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  proc.sessionStatsPromiseSequence = [stats.promise]

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(resolve => setTimeout(resolve, 20))
  proc.emit({ type: 'compaction_start' })
  stats.resolve({ contextUsage: { tokens: 1, contextWindow: 10 } })
  await tick()

  assert.equal(await resolvedReason(p), undefined)

  proc.emit({ type: 'compaction_end', willRetry: false } as any)

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: observed busy state stays pending past old timeout and later completes when idle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: true, isCompacting: false, pendingMessageCount: 0 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 5, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(resolve => setTimeout(resolve, 70))

  assert.equal(await resolvedReason(p), undefined)

  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: state timeout after observed busy does not fallback to idle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.statePromiseSequence = [
    Promise.resolve({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 }),
    new Promise<unknown>(() => {})
  ]
  proc.state = { isStreaming: true, isCompacting: false, pendingMessageCount: 0 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 5, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(resolve => setTimeout(resolve, 25))

  assert.equal(await resolvedReason(p), undefined)

  proc.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: lifecycle event invalidates stale terminal candidate', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({ type: 'agent_start' })
  await tick()

  assert.equal(await resolvedReason(p), undefined)

  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: queued second prompt does not start on intermediate agent_end', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: true })
  await tick()

  assert.equal(await resolvedReason(first), undefined)
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await first, 'end_turn')
  assert.equal(proc.prompts.length, 2)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: worker-like activity after final end does not prolong completion', async () => {
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
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: false })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'memory worker note' }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'worker-tool', toolName: 'remember', args: {} })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: state query failure falls back for terminal agent_end but not willRetry true', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.stateErrorSequence = [new Error('state unavailable'), new Error('state unavailable')]

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end', willRetry: true })
  await tick()

  assert.equal(await resolvedReason(p), undefined)

  proc.emit({ type: 'agent_end', willRetry: false })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: message_end triggers coalesced usage refresh', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStatsDelayMs = 20
  proc.sessionStats = { contextUsage: { tokens: 20, contextWindow: 1000 } }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'message_end' })
  proc.emit({ type: 'message_end' })
  proc.emit({ type: 'message_end' })

  await new Promise(r => setTimeout(r, 70))

  assert.equal(proc.getSessionStatsCount, 2)
  assert.equal(conn.updates.filter(update => update.update.sessionUpdate === 'usage_update').length, 2)
})

test('PiAcpSession: stalled stats refresh does not block prompt completion', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getSessionStats = async () => await new Promise(() => {})

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: stats failure does not reject prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getSessionStats = async () => {
    throw new Error('stats unavailable')
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: compaction unknown usage emits unavailable metadata', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { tokens: { total: 900000 }, contextUsage: { tokens: null, contextWindow: 1050000 } }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'compaction_end' })
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  const clear = conn.updates.find(update => update.update.sessionUpdate === 'session_info_update')
  assert.deepEqual((clear?.update as any)._meta?.piAcp?.contextUsage, {
    state: 'unavailable',
    size: 1050000,
    reason: 'post_compaction'
  })
})

test('PiAcpSession: manual compaction start uses neutral wording and aliases do not duplicate notice', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'compaction_start', reason: 'manual' } as any)
  proc.emit({ type: 'auto_compaction_start', reason: 'threshold' } as any)
  await tick()

  const notices = conn.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')
  assert.equal(notices.length, 1)
  assert.equal((notices[0]!.update as any).content?.text, 'Context compaction started; summarizing context to continue the session...')
})

test('PiAcpSession: manual compaction end refreshes usage without automatic completion text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 20, contextWindow: 1000 } }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  proc.emit({ type: 'compaction_end' })
  await new Promise(r => setTimeout(r, 0))

  assert.equal(
    conn.updates.some(
      update =>
        update.update.sessionUpdate === 'agent_message_chunk' &&
        (update.update as any).content?.text?.includes('Automatic compaction finished')
    ),
    false
  )
  assert.equal(
    conn.updates.some(update => update.update.sessionUpdate === 'usage_update'),
    true
  )
})

test('PiAcpSession: does not emit usage_update when context size is unknown', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { tokens: { total: 15 } }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  await p
  await new Promise(r => setTimeout(r, 0))

  assert.equal(
    conn.updates.some(update => update.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('PiAcpSession: does not re-emit startup info on first prompt after it was already sent', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const notice = 'New version available: v0.74.0 (installed v0.73.1).'

  session.setStartupInfo(notice)
  session.sendStartupInfoIfPending()
  await new Promise(r => setTimeout(r, 0))

  const p = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'hello')
  const startupUpdates = conn.updates.filter(
    entry =>
      entry.update.sessionUpdate === 'agent_message_chunk' &&
      (entry.update as any).content?.type === 'text' &&
      (entry.update as any).content?.text === notice
  )
  assert.equal(startupUpdates.length, 1)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: prompt rejection rejects auth turn and cancels queued turns without starting them', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    throw new Error('missing API key')
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  await assert.rejects(first, /Configure an API key/)
  assert.equal(await second, 'cancelled')
  assert.equal(proc.prompts.length, 1)
  assert.equal((conn.updates.at(-1)!.update as any)._meta?.piAcp?.queueDepth, 0)
  assert.equal((conn.updates.at(-1)!.update as any)._meta?.piAcp?.running, false)
})

test('PiAcpSession: prompt rejection resolves non-auth turn as error and cancels queued turns without starting them', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    throw new Error('runtime exploded')
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(await first, 'error')
  assert.equal(await second, 'cancelled')
  assert.equal(proc.prompts.length, 1)
  assert.deepEqual((conn.updates.at(-1)!.update as any)._meta?.piAcp, { queueDepth: 0, running: false })
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    promptCompletionTiming: { settleGraceMs: 5, pollIntervalMs: 2, getStateTimeoutMs: 5 }
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})
