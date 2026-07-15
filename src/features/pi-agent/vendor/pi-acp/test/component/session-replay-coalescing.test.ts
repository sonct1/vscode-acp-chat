import test from 'node:test'
import assert from 'node:assert/strict'

import { replayPiMessages } from '../../src/acp/agent.js'
import { FakeAgentSideConnection } from '../helpers/fakes.js'
import type { PiReplayMessage } from '../../src/acp/pi-session-transcript.js'

function replayMessages(messages: PiReplayMessage[]): Promise<FakeAgentSideConnection> {
  const conn = new FakeAgentSideConnection()
  // replayPiMessages is async but does not throw; rejections are test failures.
  const promise = replayPiMessages(conn as any, 'test-session', messages)
  // Return the connection after replay completes.
  return promise.then(() => conn)
}

test('replayPiMessages: coalesces consecutive user fragments into one user_message_chunk', async () => {
  const messages: PiReplayMessage[] = [
    { role: 'user', content: 'Hello ' },
    { role: 'user', content: 'there, ' },
    { role: 'user', content: 'how are you?' }
  ]

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const userChunks = updates.filter(u => u?.sessionUpdate === 'user_message_chunk')

  assert.equal(userChunks.length, 1, 'three user fragments should produce one chunk')
  assert.equal(userChunks[0]?.content?.text, 'Hello there, how are you?')
})

test('replayPiMessages: coalesces consecutive assistant fragments into one agent_message_chunk', async () => {
  const messages: PiReplayMessage[] = [
    { role: 'assistant', content: [{ type: 'text', text: 'I am ' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'doing ' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'great!' }] }
  ]

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const assistantChunks = updates.filter(u => u?.sessionUpdate === 'agent_message_chunk')

  assert.equal(assistantChunks.length, 1, 'three assistant fragments should produce one chunk')
  assert.equal(assistantChunks[0]?.content?.text, 'I am doing great!')
})

test('replayPiMessages: keeps tool_call boundaries between coalesced groups', async () => {
  const messages: PiReplayMessage[] = [
    { role: 'user', content: 'Read this file' },
    {
      role: 'toolResult',
      message: {
        toolName: 'read',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'file content' }],
        isError: false
      }
    },
    { role: 'assistant', content: [{ type: 'text', text: 'I have read ' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'the file.' }] },
    { role: 'user', content: 'Now edit it' },
    { role: 'user', content: 'Please add a line' }
  ]

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const kinds = updates.map(u => u?.sessionUpdate)

  // Expected order: user_message_chunk, tool_call, agent_message_chunk, user_message_chunk
  assert.deepEqual(kinds, ['user_message_chunk', 'tool_call', 'agent_message_chunk', 'user_message_chunk'])

  // Verify text content for the coalesced groups
  assert.equal(updates[0]?.content?.text, 'Read this file')
  assert.equal(updates[2]?.content?.text, 'I have read the file.')
  assert.equal(updates[3]?.content?.text, 'Now edit itPlease add a line')
})

test('replayPiMessages: notification count reduction for chunk-heavy fixture', async () => {
  // 10 user fragments, 5 tool results, 10 assistant fragments
  const messages: PiReplayMessage[] = []

  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `user-part-${i} ` })
  }
  for (let i = 0; i < 5; i++) {
    messages.push({
      role: 'toolResult',
      message: {
        toolName: 'bash',
        toolCallId: `call_${i}`,
        content: [{ type: 'text', text: `result-${i}` }],
        isError: false
      }
    })
  }
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `assistant-part-${i} ` }] })
  }

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const userChunks = updates.filter(u => u?.sessionUpdate === 'user_message_chunk')
  const assistantChunks = updates.filter(u => u?.sessionUpdate === 'agent_message_chunk')
  const toolCalls = updates.filter(u => u?.sessionUpdate === 'tool_call')

  // Without coalescing: 10 user + 10 assistant + 5 tool = 25 notifications
  // With coalescing: 1 user + 1 assistant + 5 tool = 7 notifications
  assert.equal(userChunks.length, 1, '10 user fragments should coalesce into 1')
  assert.equal(assistantChunks.length, 1, '10 assistant fragments should coalesce into 1')
  assert.equal(toolCalls.length, 5, '5 tool results should remain 5 tool_calls')
  assert.equal(updates.length, 7, 'total notifications should be 1 + 1 + 5 = 7')

  // Verify rendered order equivalence: user text, tools, assistant text
  assert.ok(userChunks[0]?.content?.text.startsWith('user-part-0 '))
  assert.ok(userChunks[0]?.content?.text.includes('user-part-9 '))
  assert.match(userChunks[0]?.content?.text, /user-part-0 .*user-part-9 /)

  assert.ok(assistantChunks[0]?.content?.text.startsWith('assistant-part-0 '))
  assert.ok(assistantChunks[0]?.content?.text.includes('assistant-part-9 '))
})

test('replayPiMessages: empty text fragments are skipped, not coalesced', async () => {
  const messages: PiReplayMessage[] = [
    { role: 'user', content: 'First' },
    { role: 'user', content: '' },
    { role: 'user', content: 'Second' },
    { role: 'assistant', content: [{ type: 'text', text: '' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] }
  ]

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const userChunks = updates.filter(u => u?.sessionUpdate === 'user_message_chunk')
  const assistantChunks = updates.filter(u => u?.sessionUpdate === 'agent_message_chunk')

  // Empty user content normalized to '' → skipped; empty assistant content skipped
  // So we have: user "FirstSecond" and assistant "Reply"
  assert.equal(userChunks.length, 1)
  assert.equal(userChunks[0]?.content?.text, 'FirstSecond')
  assert.equal(assistantChunks.length, 1)
  assert.equal(assistantChunks[0]?.content?.text, 'Reply')
})

test('replayPiMessages: single messages produce single notifications (no unnecessary batching)', async () => {
  const messages: PiReplayMessage[] = [
    { role: 'user', content: 'Single user' },
    { role: 'toolResult', message: { toolName: 'read', toolCallId: 'call_1', isError: false } },
    { role: 'assistant', content: [{ type: 'text', text: 'Single assistant' }] }
  ]

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const kinds = updates.map(u => u?.sessionUpdate)

  assert.deepEqual(kinds, ['user_message_chunk', 'tool_call', 'agent_message_chunk'])
  assert.equal(updates.length, 3)
})

test('replayPiMessages: preserves tool_call final state, errors, and content', async () => {
  const messages: PiReplayMessage[] = [
    {
      role: 'toolResult',
      message: {
        toolName: 'edit',
        toolCallId: 'call_edit_1',
        content: [{ type: 'text', text: 'edit succeeded' }],
        isError: false
      }
    },
    {
      role: 'toolResult',
      message: {
        toolName: 'bash',
        toolCallId: 'call_fail_1',
        content: [{ type: 'text', text: 'command failed' }],
        isError: true
      }
    }
  ]

  const conn = await replayMessages(messages)
  const updates = conn.updates.map(u => (u as any).update)
  const toolCalls = updates.filter(u => u?.sessionUpdate === 'tool_call')

  assert.equal(toolCalls.length, 2)

  assert.equal(toolCalls[0].toolCallId, 'call_edit_1')
  assert.equal(toolCalls[0].title, 'edit')
  assert.equal(toolCalls[0].status, 'completed')
  assert.equal(toolCalls[0].content?.[0]?.content?.text, 'edit succeeded')

  assert.equal(toolCalls[1].toolCallId, 'call_fail_1')
  assert.equal(toolCalls[1].title, 'bash')
  assert.equal(toolCalls[1].status, 'failed')
  assert.equal(toolCalls[1].content?.[0]?.content?.text, 'command failed')
})
