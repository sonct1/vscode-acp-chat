import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import { toolResultToText } from './translate/pi-tools.js'
import { normalizePiContextUsage } from './usage.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  id: number
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'
const FINAL_USAGE_REFRESH_TIMEOUT_MS = 1000
// Pi emits post-run lifecycle (retry/compaction/continuation) asynchronously after
// agent_end. Keep a real non-zero settle grace before accepting idle so those
// events can invalidate or replace the terminal candidate in production.
const PROMPT_COMPLETION_SETTLE_GRACE_MS = 150
const PROMPT_COMPLETION_STATE_POLL_INTERVAL_MS = 25
const PROMPT_COMPLETION_GET_STATE_TIMEOUT_MS = 100

type PromptCompletionTiming = {
  settleGraceMs: number
  pollIntervalMs: number
  getStateTimeoutMs: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_PROMPT_COMPLETION_TIMING: PromptCompletionTiming = {
  settleGraceMs: PROMPT_COMPLETION_SETTLE_GRACE_MS,
  pollIntervalMs: PROMPT_COMPLETION_STATE_POLL_INTERVAL_MS,
  getStateTimeoutMs: PROMPT_COMPLETION_GET_STATE_TIMEOUT_MS
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()

  constructor(private readonly store = new SessionStore()) {}

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly promptCompletionTiming: PromptCompletionTiming

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()
  private lastPublishedTitle: string | null = null
  private usageRefreshInFlight: Promise<void> | null = null
  private usageRefreshRequested = false
  private lifecycleRevision = 0
  private nextTurnId = 1
  private completionValidationGeneration = 0
  private completionValidationRunning = false
  private compactionNoticeActive = false

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    promptCompletionTiming?: Partial<PromptCompletionTiming>
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.promptCompletionTiming = {
      ...DEFAULT_PROMPT_COMPLETION_TIMING,
      ...opts.promptCompletionTiming
    }

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async publishSessionTitle(name: string): Promise<void> {
    const title = name.trim()
    if (!title) return

    if (title !== this.lastPublishedTitle) {
      this.lastPublishedTitle = title
      this.emit({
        sessionUpdate: 'session_info_update',
        title,
        updatedAt: new Date().toISOString()
      })
    }

    await this.flushEmits()
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitContextUsageUnavailable(
    size: number | undefined,
    reason: 'post_compaction' | 'pending_provider_usage'
  ): void {
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          contextUsage: {
            state: 'unavailable',
            ...(size === undefined ? {} : { size }),
            reason
          }
        }
      }
    } as SessionUpdate)
  }

  private async sampleUsage(): Promise<void> {
    const [stats, state] = await Promise.all([this.proc.getSessionStats(), this.proc.getState().catch(() => null)])
    const usage = normalizePiContextUsage({ stats, state })
    if (usage.state === 'available') {
      this.emit({
        sessionUpdate: 'usage_update',
        used: usage.used,
        size: usage.size,
        cost: usage.cost ?? null
      } as SessionUpdate)
      return
    }

    if (usage.state === 'unavailable') {
      this.emitContextUsageUnavailable(usage.size, usage.reason)
    }
  }

  private requestUsageRefresh(): Promise<void> {
    this.usageRefreshRequested = true

    if (!this.usageRefreshInFlight) {
      this.usageRefreshInFlight = this.runUsageRefreshes().finally(() => {
        this.usageRefreshInFlight = null
      })
    }

    return this.usageRefreshInFlight
  }

  private async runUsageRefreshes(): Promise<void> {
    while (this.usageRefreshRequested) {
      this.usageRefreshRequested = false
      try {
        await this.sampleUsage()
      } catch {
        // Usage is best-effort; stats failures must not affect prompt completion.
      }
    }
  }

  refreshUsage(): Promise<void> {
    return this.requestUsageRefresh()
  }

  private async refreshUsageBeforePromptCompletion(): Promise<void> {
    const refresh = this.requestUsageRefresh()
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.race([
        refresh,
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, FINAL_USAGE_REFRESH_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.lifecycleRevision += 1

    this.pendingTurn = { id: this.nextTurnId, resolve: t.resolve, reject: t.reject }
    this.nextTurnId += 1

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Important: pi may emit multiple `turn_end` events (e.g. when the model requests tools).
    // The full prompt is finished when we see the owning top-level pi run become idle.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before completion, settle the active turn and clear
      // queued work without starting it: pi may be unhealthy or require re-auth.
      void this.flushEmits().finally(() => {
        this.failCurrentTurn(err)
      })
    })
  }

  private isRootBusyState(state: unknown): boolean {
    const record = state as { isStreaming?: unknown; isCompacting?: unknown; pendingMessageCount?: unknown } | null
    return (
      record?.isStreaming === true ||
      record?.isCompacting === true ||
      (typeof record?.pendingMessageCount === 'number' && record.pendingMessageCount > 0)
    )
  }

  private isCompletionCandidateCurrent(turnId: number, revision: number): boolean {
    return this.pendingTurn?.id === turnId && this.lifecycleRevision === revision
  }

  private async sleep(ms: number): Promise<void> {
    const sleep = this.promptCompletionTiming.sleep
    if (sleep) {
      await sleep(ms)
      return
    }

    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private async getStateWithTimeout(timeoutMs: number): Promise<unknown> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.proc.getState(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timed out waiting for pi state')), timeoutMs)
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async rootStateIsStablyIdle(turnId: number, revision: number): Promise<boolean> {
    let observedBusy = false
    const { settleGraceMs, pollIntervalMs, getStateTimeoutMs } = this.promptCompletionTiming

    const confirmIdleAfterSettleGrace = async (): Promise<'idle' | 'busy' | 'retry'> => {
      await this.sleep(settleGraceMs)
      if (!this.isCompletionCandidateCurrent(turnId, revision)) return 'retry'

      try {
        const finalState = await this.getStateWithTimeout(getStateTimeoutMs)
        if (!this.isCompletionCandidateCurrent(turnId, revision)) return 'retry'
        return this.isRootBusyState(finalState) ? 'busy' : 'idle'
      } catch {
        if (observedBusy) return 'retry'
        return this.isCompletionCandidateCurrent(turnId, revision) ? 'idle' : 'retry'
      }
    }

    while (this.isCompletionCandidateCurrent(turnId, revision)) {
      let firstState: unknown
      try {
        firstState = await this.getStateWithTimeout(getStateTimeoutMs)
      } catch {
        if (observedBusy) {
          await this.sleep(pollIntervalMs)
          continue
        }

        const settled = await confirmIdleAfterSettleGrace()
        if (settled === 'idle') return true
        if (settled === 'busy') observedBusy = true
        await this.sleep(pollIntervalMs)
        continue
      }

      if (!this.isCompletionCandidateCurrent(turnId, revision)) return false

      if (this.isRootBusyState(firstState)) {
        observedBusy = true
        await this.sleep(pollIntervalMs)
        continue
      }

      await this.sleep(pollIntervalMs)
      if (!this.isCompletionCandidateCurrent(turnId, revision)) return false

      let secondState: unknown
      try {
        secondState = await this.getStateWithTimeout(getStateTimeoutMs)
      } catch {
        if (observedBusy) {
          await this.sleep(pollIntervalMs)
          continue
        }

        const settled = await confirmIdleAfterSettleGrace()
        if (settled === 'idle') return true
        if (settled === 'busy') observedBusy = true
        await this.sleep(pollIntervalMs)
        continue
      }

      if (!this.isCompletionCandidateCurrent(turnId, revision)) return false

      if (this.isRootBusyState(secondState)) {
        observedBusy = true
        await this.sleep(pollIntervalMs)
        continue
      }

      const settled = await confirmIdleAfterSettleGrace()
      if (settled === 'idle') return true
      if (settled === 'busy') observedBusy = true
      await this.sleep(pollIntervalMs)
    }

    return false
  }

  private resetCompletionValidation(): void {
    this.completionValidationGeneration += 1
    this.completionValidationRunning = false
  }

  private failCurrentTurn(err: unknown): void {
    const pending = this.pendingTurn
    if (!pending) return

    const queued = this.turnQueue.splice(0, this.turnQueue.length)
    for (const t of queued) t.resolve('cancelled')

    this.pendingTurn = null
    this.inAgentLoop = false
    this.lifecycleRevision += 1
    this.resetCompletionValidation()

    const authErr = maybeAuthRequiredError(err)
    if (authErr) {
      pending.reject(authErr)
    } else {
      const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
      pending.resolve(reason)
    }

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: 0, running: false } }
    })
  }

  private completePendingTurn(pending: PendingTurn, reason: StopReason): void {
    if (this.pendingTurn !== pending) return

    pending.resolve(reason)
    this.pendingTurn = null
    this.inAgentLoop = false
    this.lifecycleRevision += 1
    this.resetCompletionValidation()

    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  private schedulePendingTurnCompletion(ev: PiRpcEvent): void {
    const pending = this.pendingTurn
    if (!pending) return

    const willRetry = (ev as { willRetry?: unknown }).willRetry
    if (willRetry === true) return

    const generation = (this.completionValidationGeneration += 1)
    if (this.completionValidationRunning) return

    this.completionValidationRunning = true
    this.runCompletionValidation(generation)
  }

  private runCompletionValidation(generation: number): void {
    let validatingTurnId: number | undefined

    void (async () => {
      const pending = this.pendingTurn
      if (!pending) return

      const turnId = pending.id
      validatingTurnId = turnId
      const revision = this.lifecycleRevision

      try {
        const isIdle = await this.rootStateIsStablyIdle(turnId, revision)
        if (!isIdle) return
      } catch {
        // A terminal agent_end is the best available completion signal if state is
        // unavailable. willRetry=true candidates are filtered before validation.
      }

      if (
        this.pendingTurn !== pending ||
        this.lifecycleRevision !== revision ||
        this.completionValidationGeneration !== generation
      ) {
        return
      }

      await this.refreshUsageBeforePromptCompletion()
      if (
        this.pendingTurn !== pending ||
        this.lifecycleRevision !== revision ||
        this.completionValidationGeneration !== generation
      ) {
        return
      }

      await this.flushEmits()
      if (
        this.pendingTurn !== pending ||
        this.lifecycleRevision !== revision ||
        this.completionValidationGeneration !== generation
      ) {
        return
      }

      const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
      this.completePendingTurn(pending, reason)
    })().finally(() => {
      this.completionValidationRunning = false
      if (this.pendingTurn?.id === validatingTurnId && this.completionValidationGeneration !== generation) {
        this.runCompletionValidation(this.completionValidationGeneration)
      }
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.currentToolCalls.delete(toolCallId)
        this.fileSnapshots.delete(toolCallId)
        this.fileMutationToolCallIds.delete(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.lifecycleRevision += 1
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.lifecycleRevision += 1
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start':
      case 'compaction_start': {
        this.lifecycleRevision += 1
        if (!this.compactionNoticeActive) {
          this.compactionNoticeActive = true
          const reason = stringProp(ev, 'reason')
          const isAutomatic = type === 'auto_compaction_start' || reason === 'threshold' || reason === 'overflow'
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: isAutomatic
                ? 'Context nearing limit, running automatic compaction...'
                : 'Context compaction started; summarizing context to continue the session...'
            } satisfies ContentBlock
          })
        }
        break
      }

      case 'auto_compaction_end': {
        this.lifecycleRevision += 1
        this.compactionNoticeActive = false
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        void this.requestUsageRefresh()
        this.schedulePendingTurnCompletion(ev)
        break
      }

      case 'compaction_end': {
        this.lifecycleRevision += 1
        this.compactionNoticeActive = false
        void this.requestUsageRefresh()
        this.schedulePendingTurnCompletion(ev)
        break
      }

      case 'session_info_changed': {
        const name = stringProp(ev, 'name')
        if (name) void this.publishSessionTitle(name)
        break
      }

      case 'agent_start': {
        this.lifecycleRevision += 1
        this.inAgentLoop = true
        break
      }

      case 'message_end': {
        void this.requestUsageRefresh()
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        this.schedulePendingTurnCompletion(ev)
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      // Many ACP clients render `execute` tool calls only via the terminal APIs.
      // Since this adapter lets pi execute locally (no client terminal delegation),
      // we report bash as `other` so clients show inline text output blocks.
      return 'other'
    default:
      return 'other'
  }
}
