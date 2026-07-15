import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePiContextUsage, normalizePiUsageUpdate } from '../../src/acp/usage.js'

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

test('normalizePiContextUsage: explicit null contextUsage tokens is unavailable and does not use cumulative total', () => {
  assert.deepEqual(
    normalizePiContextUsage({
      stats: {
        tokens: { total: 900000 },
        contextUsage: { tokens: null, contextWindow: 1050000, percent: null }
      }
    }),
    { state: 'unavailable', size: 1050000, reason: 'post_compaction' }
  )
  assert.equal(
    normalizePiUsageUpdate({
      stats: {
        tokens: { total: 900000 },
        contextUsage: { tokens: null, contextWindow: 1050000, percent: null }
      }
    }),
    null
  )
})

test('normalizePiContextUsage: explicit null tokens remains unavailable when context size is unknown', () => {
  assert.deepEqual(
    normalizePiContextUsage({
      stats: {
        tokens: { total: 900000 },
        contextUsage: { tokens: null, percent: null }
      }
    }),
    { state: 'unavailable', reason: 'post_compaction' }
  )
})

test('normalizePiUsageUpdate: falls back to tokens.total and get_state model contextWindow only without contextUsage', () => {
  assert.deepEqual(
    normalizePiUsageUpdate({
      stats: { tokens: { input: 10, output: 5, total: 15 } },
      state: { model: { contextWindow: 64000 } }
    }),
    { used: 15, size: 64000, cost: null }
  )
})

test('normalizePiUsageUpdate: does not use token part fallback when contextUsage field exists without numeric tokens', () => {
  assert.equal(
    normalizePiUsageUpdate({
      stats: { tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, contextUsage: { contextWindow: 1000 } }
    }),
    null
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
