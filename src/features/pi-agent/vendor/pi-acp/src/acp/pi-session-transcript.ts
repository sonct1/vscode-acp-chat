import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export type PiReplayMessage =
  | { role: 'user'; content: unknown }
  | { role: 'assistant'; content: unknown }
  | { role: 'toolResult'; message: unknown }

type JsonObject = Record<string, unknown>

type ParsedEntry = JsonObject & {
  id?: unknown
  parentId?: unknown
  type?: unknown
  message?: unknown
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toReplayMessage(entry: ParsedEntry): PiReplayMessage | null {
  if (entry.type !== 'message' || !isObject(entry.message)) return null

  const role = entry.message.role
  if (role === 'user') return { role, content: entry.message.content }
  if (role === 'assistant') return { role, content: entry.message.content }
  if (role === 'toolResult') return { role, message: entry.message }
  return null
}

function findLastEntry(entries: ParsedEntry[], predicate: (entry: ParsedEntry) => boolean): ParsedEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && predicate(entry)) return entry
  }
  return undefined
}

function extractActivePath(entries: ParsedEntry[]): ParsedEntry[] {
  const byId = new Map<string, ParsedEntry>()
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }

  if (byId.size === 0) return entries

  const leaf = findLastEntry(entries, entry => entry.type !== 'session' && typeof entry.id === 'string')

  if (!leaf || typeof leaf.id !== 'string') return entries

  const path: ParsedEntry[] = []
  const seen = new Set<string>()
  let current: ParsedEntry | undefined = leaf

  while (current && typeof current.id === 'string' && !seen.has(current.id)) {
    path.push(current)
    seen.add(current.id)

    const parentId: unknown = current.parentId
    current = typeof parentId === 'string' ? byId.get(parentId) : undefined
  }

  return path.reverse()
}

export async function readPiSessionTranscript(sessionFile: string): Promise<PiReplayMessage[]> {
  const entries: ParsedEntry[] = []

  const input = createReadStream(sessionFile, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })

  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isObject(parsed)) entries.push(parsed)
    } catch {
      // Skip malformed JSONL lines; one bad entry should not prevent history replay.
    }
  }

  return extractActivePath(entries)
    .map(toReplayMessage)
    .filter((message): message is PiReplayMessage => message !== null)
}
