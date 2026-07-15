import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPiAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
  fileSize: number | null
  fileMtimeMs: number | null
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function emptyMap(): SessionMapFile {
  return { version: 1, sessions: {} }
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return emptyMap()
    }
    const sessions: Record<string, StoredSession> = {}
    for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        if (
          typeof record.sessionId === 'string' &&
          typeof record.cwd === 'string' &&
          typeof record.sessionFile === 'string'
        ) {
          sessions[sessionId] = {
            sessionId: record.sessionId,
            cwd: record.cwd,
            sessionFile: record.sessionFile,
            updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
            fileSize: typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) ? record.fileSize : null,
            fileMtimeMs: typeof record.fileMtimeMs === 'number' && Number.isFinite(record.fileMtimeMs) ? record.fileMtimeMs : null
          }
        }
      }
    }
    return { version: 1, sessions }
  } catch {
    return emptyMap()
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  const tempPath = join(dirname(path), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tempPath, path)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type LockOwner = { pid: number; token: string }

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number' || typeof record.token !== 'string') return null
    return { pid: record.pid, token: record.token }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  if (readLockOwner(lockPath)?.token !== token) return
  rmSync(lockPath, { force: true })
}

function withFileLock<T>(path: string, action: () => T): T {
  const lockPath = `${path}.lock`
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const ownerPath = `${lockPath}.${token}.owner`
  ensureParentDir(lockPath)
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), 'utf8')
  const deadline = Date.now() + 5000
  try {
    while (true) {
      try {
        linkSync(ownerPath, lockPath)
        rmSync(ownerPath, { force: true })
        try {
          return action()
        } finally {
          releaseOwnedLock(lockPath, token)
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
        if (code !== 'EEXIST') throw error
        const owner = readLockOwner(lockPath)
        if (owner && !isProcessAlive(owner.pid)) {
          releaseOwnedLock(lockPath, owner.token)
          continue
        }
        if (!owner) {
          try {
            if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
              rmSync(lockPath, { force: true })
              continue
            }
          } catch {
            continue
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for session store lock: ${lockPath}`)
        }
        sleepSync(10)
      }
    }
  } finally {
    rmSync(ownerPath, { force: true })
  }
}

function fileSignature(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function signatureMatches(stored: StoredSession, current: { size: number; mtimeMs: number }): boolean {
  if (stored.fileSize === null || stored.fileMtimeMs === null) return true
  return stored.fileSize === current.size && stored.fileMtimeMs === current.mtimeMs
}

export class SessionStore {
  private readonly path: string
  private db: SessionMapFile | null = null

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path
  }

  private load(): SessionMapFile {
    if (!this.db) this.db = loadFile(this.path)
    return this.db
  }

  private reload(): SessionMapFile {
    this.db = loadFile(this.path)
    return this.db
  }

  private mutate(mutator: (db: SessionMapFile) => boolean): void {
    withFileLock(this.path, () => {
      const db = this.reload()
      if (!mutator(db)) return
      saveFile(this.path, db)
    })
  }

  get(sessionId: string): StoredSession | null {
    const db = this.reload()
    const stored = db.sessions[sessionId]
    if (!stored) return null
    const signature = fileSignature(stored.sessionFile)
    if (!signature || !signatureMatches(stored, signature)) {
      this.mutate(current => {
        if (!current.sessions[sessionId]) return false
        delete current.sessions[sessionId]
        return true
      })
      return null
    }
    return stored
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string }): void {
    this.upsertMany([entry])
  }

  upsertMany(entries: Array<{ sessionId: string; cwd: string; sessionFile: string }>): void {
    if (entries.length === 0) return
    const updatedAt = new Date().toISOString()
    const materialized = entries.map(entry => {
      const signature = fileSignature(entry.sessionFile)
      return {
        ...entry,
        fileSize: signature?.size ?? null,
        fileMtimeMs: signature?.mtimeMs ?? null
      }
    })
    this.mutate(db => {
      for (const entry of materialized) {
        db.sessions[entry.sessionId] = {
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          sessionFile: entry.sessionFile,
          updatedAt,
          fileSize: entry.fileSize,
          fileMtimeMs: entry.fileMtimeMs
        }
      }
      return true
    })
  }

  delete(sessionId: string): void {
    this.mutate(db => {
      if (!db.sessions[sessionId]) return false
      delete db.sessions[sessionId]
      return true
    })
  }

  flush(): void {
    if (!this.db) return
    const pending = this.db
    withFileLock(this.path, () => {
      const current = loadFile(this.path)
      current.sessions = { ...current.sessions, ...pending.sessions }
      this.db = current
      saveFile(this.path, current)
    })
  }
}
