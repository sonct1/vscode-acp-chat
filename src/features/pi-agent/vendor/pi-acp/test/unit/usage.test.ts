import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePiUsageUpdate } from '../../src/acp/usage.js'

test('normalizePiUsageUpdate: uses Pi contextUsage tokens and contextWindow', () => {
  assert.deepEqual(
    normalizePiUsageUpdate({
      stats: {
        tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
        cost: 0.001,
        currency: 'USD',
        contextUsage: { tokens: 18, contextWindow: 128000, percent: 0.01 }
      }
    }),
    {
      used: 18,
      size: 128000,
      cost: { amount: 0.001, currency: 'USD' }
    }
  )
})

test('normalizePiUsageUpdate: falls back to tokens.total and get_state model contextWindow', () => {
  assert.deepEqual(
    normalizePiUsageUpdate({
      stats: { tokens: { input: 10, output: 5, total: 15 } },
      state: { model: { contextWindow: 64000 } }
    }),
    { used: 15, size: 64000, cost: null }
  )
})

test('normalizePiUsageUpdate: falls back to summing token parts', () => {
  assert.deepEqual(
    normalizePiUsageUpdate({
      stats: { tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, contextUsage: { contextWindow: 1000 } }
    }),
    { used: 18, size: 1000, cost: null }
  )
})

test('normalizePiUsageUpdate: ignores malformed stats', () => {
  assert.equal(normalizePiUsageUpdate({ stats: null }), null)
  assert.equal(
    normalizePiUsageUpdate({ stats: { tokens: { total: -1 }, contextUsage: { contextWindow: 1000 } } }),
    null
  )
  assert.equal(normalizePiUsageUpdate({ stats: { tokens: { total: 1 }, contextUsage: { contextWindow: 0 } } }), null)
})

test('normalizePiUsageUpdate: does not emit without reliable context size', () => {
  assert.equal(normalizePiUsageUpdate({ stats: { tokens: { total: 12 } } }), null)
})
