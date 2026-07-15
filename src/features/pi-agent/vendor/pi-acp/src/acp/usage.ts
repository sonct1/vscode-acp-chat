export type AcpUsageUpdate = {
  used: number
  size: number
  cost?: { amount: number; currency: string } | null
}

export type NormalizedPiContextUsage =
  | ({ state: 'available' } & AcpUsageUpdate)
  | { state: 'unavailable'; size?: number; reason: 'post_compaction' | 'pending_provider_usage' }
  | { state: 'unsupported' }

type UsageInputs = {
  stats?: unknown
  state?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function finiteNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

function positiveInteger(value: unknown): number | null {
  const n = finiteNonNegativeInteger(value)
  return n !== null && n > 0 ? n : null
}

function firstNonNegative(...values: unknown[]): number | null {
  for (const value of values) {
    const n = finiteNonNegativeInteger(value)
    if (n !== null) return n
  }
  return null
}

function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    const n = positiveInteger(value)
    if (n !== null) return n
  }
  return null
}

function sumTokenParts(tokens: Record<string, unknown> | null): number | null {
  if (!tokens) return null

  const parts = ['input', 'output', 'cacheRead', 'cacheWrite']
    .map(key => finiteNonNegativeInteger(tokens[key]))
    .filter((value): value is number => value !== null)

  if (!parts.length) return null
  return parts.reduce((total, value) => total + value, 0)
}

function normalizeCost(stats: Record<string, unknown>): { amount: number; currency: string } | null {
  const cost = stats.cost
  const costRecord = asRecord(cost)

  if (costRecord) {
    const amount =
      typeof costRecord.amount === 'number' && Number.isFinite(costRecord.amount) ? costRecord.amount : null
    const currency =
      typeof costRecord.currency === 'string' && costRecord.currency.trim() ? costRecord.currency.trim() : null
    return amount !== null && currency !== null ? { amount, currency } : null
  }

  const amount = typeof cost === 'number' && Number.isFinite(cost) ? cost : null
  const currency = typeof stats.currency === 'string' && stats.currency.trim() ? stats.currency.trim() : null
  return amount !== null && currency !== null ? { amount, currency } : null
}

export function normalizePiContextUsage(input: UsageInputs): NormalizedPiContextUsage {
  const stats = asRecord(input.stats)
  if (!stats) return { state: 'unsupported' }

  const hasContextUsage = Object.prototype.hasOwnProperty.call(stats, 'contextUsage')
  const contextUsage = asRecord(stats.contextUsage)
  const tokens = asRecord(stats.tokens)
  const state = asRecord(input.state)
  const stateModel = asRecord(state?.model)
  const size = firstPositive(
    contextUsage?.contextWindow,
    contextUsage?.contextLimit,
    contextUsage?.maxContextTokens,
    stateModel?.contextWindow,
    stateModel?.contextLimit,
    stateModel?.maxContextTokens
  )

  if (hasContextUsage) {
    if (contextUsage?.tokens === null) {
      return {
        state: 'unavailable',
        ...(size === null ? {} : { size }),
        reason: 'post_compaction'
      }
    }

    const used = firstNonNegative(contextUsage?.tokens)
    if (used === null || size === null) return { state: 'unsupported' }

    return {
      state: 'available',
      used,
      size,
      cost: normalizeCost(stats)
    }
  }

  const used = firstNonNegative(tokens?.total, sumTokenParts(tokens))
  if (used === null || size === null) return { state: 'unsupported' }

  return {
    state: 'available',
    used,
    size,
    cost: normalizeCost(stats)
  }
}

export function normalizePiUsageUpdate(input: UsageInputs): AcpUsageUpdate | null {
  const usage = normalizePiContextUsage(input)
  if (usage.state !== 'available') return null
  return { used: usage.used, size: usage.size, cost: usage.cost }
}
