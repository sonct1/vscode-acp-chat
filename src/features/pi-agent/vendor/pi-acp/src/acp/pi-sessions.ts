import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

export type PiSessionDiscoveryCounters = {
  filesEnumerated: number
  filesStat: number
  metadataParsed: number
  unchangedIndexHits: number
  deletedIndexEntries: number
  discoveryScans: number
}

type FileKey = {
  sessionFile: string
  size: number
  mtimeMs: number
}

type MetadataCacheEntry = FileKey & {
  item: PiSessionListItem
}

export type PiSessionDiscoverySnapshot = {
  readonly sessionsDir: string
  readonly settingsPath: string
  readonly settingsMtimeMs: number | null
  readonly settingsSize: number | null
  readonly createdAt: number
  readonly items: readonly PiSessionListItem[]
  readonly counters: Readonly<PiSessionDiscoveryCounters>
}

const metadataCache = new Map<string, MetadataCacheEntry>()
let lastSettingsSignature: {
  settingsPath: string
  settingsMtimeMs: number | null
  settingsSize: number | null
} | null = null
let lastSessionsDir: string | null = null
let lastSnapshot: PiSessionDiscoverySnapshot | null = null

const WARM_SNAPSHOT_TTL_MS = 5000

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function getSettingsPath(agentDir = getPiAgentDir()): string {
  return join(agentDir, 'settings.json')
}

function settingsSignature(settingsPath: string): {
  settingsPath: string
  settingsMtimeMs: number | null
  settingsSize: number | null
} {
  try {
    const st = statSync(settingsPath)
    return { settingsPath, settingsMtimeMs: st.mtimeMs, settingsSize: st.size }
  } catch {
    return { settingsPath, settingsMtimeMs: null, settingsSize: null }
  }
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = getSettingsPath(agentDir)
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function walkJsonlFiles(dir: string, root: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof e.name === 'string' ? e.name : String(e.name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, root, out)
    else if ((e.isFile() || e.isSymbolicLink()) && name.endsWith('.jsonl')) {
      try {
        const canonical = canonicalPath(p)
        if (statSync(p).isFile() && isWithinRoot(root, canonical)) out.push(canonical)
      } catch {
        // ignore broken links and racing deletes
      }
    }
  }
}

function parseSessionHeader(obj: unknown): { sessionId: string; cwd: string } | null {
  if (!obj || typeof obj !== 'object') return null
  const record = obj as Record<string, unknown>
  if (record.type !== 'session') return null
  const sessionId = typeof record.id === 'string' ? record.id : null
  const cwd = typeof record.cwd === 'string' ? record.cwd : null
  if (!sessionId || !cwd) return null
  return { sessionId, cwd }
}

function pickTimestamp(obj: Record<string, unknown>): string | null {
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null
  if (!ts) return null
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function firstUserText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const record = message as Record<string, unknown>
  if (record.role !== 'user') return null
  const content = record.content
  if (typeof content === 'string') return content.slice(0, 80)
  if (!Array.isArray(content)) return null
  const text = content.find((part): part is { type: string; text: string } => {
    if (!part || typeof part !== 'object') return false
    const partRecord = part as Record<string, unknown>
    return partRecord.type === 'text' && typeof partRecord.text === 'string'
  })
  return text ? text.text.slice(0, 80) : null
}

function parseMetadataPass(path: string, fileKey: FileKey): PiSessionListItem | null {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    let leftover = ''
    let offset = 0
    let header: { sessionId: string; cwd: string } | null = null
    let title: string | null = null
    let firstUserTitle: string | null = null
    let updatedAt: string | null = null
    let fallbackUpdatedAt: string | null = null

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n

      const chunk = leftover + buf.subarray(0, n).toString('utf8')
      const lines = chunk.split(/\r?\n/)
      leftover = lines.pop() ?? ''

      for (const line0 of lines) {
        const line = line0.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line) as unknown
          if (!obj || typeof obj !== 'object') continue
          const record = obj as Record<string, unknown>
          if (!header) header = parseSessionHeader(record)
          if (record.type === 'session_info' && typeof record.name === 'string' && record.name.trim()) {
            title = record.name.trim()
          }
          if (!firstUserTitle && record.type === 'message') firstUserTitle = firstUserText(record.message)
          if (record.type === 'message') updatedAt = pickTimestamp(record) ?? updatedAt
          fallbackUpdatedAt = pickTimestamp(record) ?? fallbackUpdatedAt
        } catch {
          // ignore malformed JSONL lines
        }
      }
    }

    const finalLine = leftover.trim()
    if (finalLine) {
      try {
        const obj = JSON.parse(finalLine) as unknown
        if (obj && typeof obj === 'object') {
          const record = obj as Record<string, unknown>
          if (!header) header = parseSessionHeader(record)
          if (record.type === 'session_info' && typeof record.name === 'string' && record.name.trim()) {
            title = record.name.trim()
          }
          if (!firstUserTitle && record.type === 'message') firstUserTitle = firstUserText(record.message)
          if (record.type === 'message') updatedAt = pickTimestamp(record) ?? updatedAt
          fallbackUpdatedAt = pickTimestamp(record) ?? fallbackUpdatedAt
        }
      } catch {
        // ignore
      }
    }

    if (!header) return null
    return {
      sessionId: header.sessionId,
      cwd: header.cwd,
      title: title ?? firstUserTitle,
      updatedAt: updatedAt ?? fallbackUpdatedAt ?? new Date(fileKey.mtimeMs).toISOString(),
      sessionFile: fileKey.sessionFile
    }
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function debugDiscovery(snapshot: PiSessionDiscoverySnapshot, elapsedMs: number): void {
  if (process.env.PI_ACP_DEBUG_HISTORY !== 'true') return
  const c = snapshot.counters
  console.warn(
    `[pi-acp] history discovery: sessions=${snapshot.items.length} files=${c.filesEnumerated} stat=${c.filesStat} parsed=${c.metadataParsed} warmHits=${c.unchangedIndexHits} deleted=${c.deletedIndexEntries} scans=${c.discoveryScans} elapsedMs=${elapsedMs.toFixed(1)}`
  )
}

export function invalidatePiSessionIndex(): void {
  metadataCache.clear()
  lastSnapshot = null
  lastSettingsSignature = null
  lastSessionsDir = null
}

export function discoverPiSessionsSnapshot(opts: { force?: boolean } = {}): PiSessionDiscoverySnapshot {
  const started = performance.now()
  const agentDir = getPiAgentDir()
  const settingsPath = getSettingsPath(agentDir)
  const signature = settingsSignature(settingsPath)
  const sessionsDir = canonicalPath(getPiSessionsDir())

  const settingsChanged =
    !lastSettingsSignature ||
    lastSettingsSignature.settingsPath !== signature.settingsPath ||
    lastSettingsSignature.settingsMtimeMs !== signature.settingsMtimeMs ||
    lastSettingsSignature.settingsSize !== signature.settingsSize
  const sessionsDirChanged = lastSessionsDir !== sessionsDir

  // Fast path: return cached snapshot when nothing changed and snapshot is fresh
  if (!opts.force && !settingsChanged && !sessionsDirChanged && lastSnapshot) {
    if (Date.now() - lastSnapshot.createdAt < WARM_SNAPSHOT_TTL_MS) {
      const snapshot: PiSessionDiscoverySnapshot = Object.freeze({
        sessionsDir: lastSnapshot.sessionsDir,
        settingsPath: lastSnapshot.settingsPath,
        settingsMtimeMs: lastSnapshot.settingsMtimeMs,
        settingsSize: lastSnapshot.settingsSize,
        createdAt: Date.now(),
        items: lastSnapshot.items,
        counters: Object.freeze({
          filesEnumerated: 0,
          filesStat: 0,
          metadataParsed: 0,
          unchangedIndexHits: 0,
          deletedIndexEntries: 0,
          discoveryScans: 0
        })
      })
      if (process.env.PI_ACP_DEBUG_HISTORY === 'true') {
        console.warn(
          `[pi-acp] history discovery: warm-cached snapshotTtlMs=${(Date.now() - lastSnapshot.createdAt).toFixed(0)}`
        )
      }
      lastSnapshot = snapshot
      return snapshot
    }
  }

  if (opts.force || settingsChanged || sessionsDirChanged) {
    metadataCache.clear()
    lastSnapshot = null
  }

  const discoveredFiles: string[] = []
  walkJsonlFiles(sessionsDir, sessionsDir, discoveredFiles)
  const files = [...new Set(discoveredFiles)]
  const seen = new Set(files)
  const counters: PiSessionDiscoveryCounters = {
    filesEnumerated: files.length,
    filesStat: 0,
    metadataParsed: 0,
    unchangedIndexHits: 0,
    deletedIndexEntries: 0,
    discoveryScans: 1
  }

  for (const cachedFile of [...metadataCache.keys()]) {
    if (!seen.has(cachedFile)) {
      metadataCache.delete(cachedFile)
      counters.deletedIndexEntries += 1
    }
  }

  const items: PiSessionListItem[] = []
  for (const file of files) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(file)
      counters.filesStat += 1
      if (!st.isFile()) continue
    } catch {
      continue
    }

    const fileKey = { sessionFile: file, size: st.size, mtimeMs: st.mtimeMs }
    const cached = metadataCache.get(file)
    if (cached && cached.size === fileKey.size && cached.mtimeMs === fileKey.mtimeMs) {
      items.push(cached.item)
      counters.unchangedIndexHits += 1
      continue
    }

    counters.metadataParsed += 1
    const item = parseMetadataPass(file, fileKey)
    if (!item) {
      metadataCache.delete(file)
      continue
    }
    metadataCache.set(file, { ...fileKey, item })
    items.push(item)
  }

  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  const snapshot: PiSessionDiscoverySnapshot = Object.freeze({
    sessionsDir,
    settingsPath,
    settingsMtimeMs: signature.settingsMtimeMs,
    settingsSize: signature.settingsSize,
    createdAt: Date.now(),
    items: Object.freeze(items.slice()),
    counters: Object.freeze(counters)
  })

  lastSettingsSignature = signature
  lastSessionsDir = sessionsDir
  lastSnapshot = snapshot
  debugDiscovery(snapshot, performance.now() - started)
  return snapshot
}

export function getLastPiSessionDiscoverySnapshot(): PiSessionDiscoverySnapshot | null {
  return lastSnapshot
}

export function listPiSessions(): PiSessionListItem[] {
  return [...discoverPiSessionsSnapshot().items]
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  return discoverPiSessionsSnapshot().items.find(s => s.sessionId === sessionId) ?? null
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null
}
