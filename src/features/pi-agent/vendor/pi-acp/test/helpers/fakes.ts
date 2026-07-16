import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly promptPromiseSequence: Array<Promise<void>> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  getSessionStatsCount = 0
  state: unknown = {}
  stateSequence: unknown[] = []
  stateErrorSequence: unknown[] = []
  statePromiseSequence: Array<Promise<unknown>> = []
  getStateCount = 0
  sessionStats: unknown = null
  sessionStatsDelayMs = 0
  sessionStatsPromiseSequence: Array<Promise<unknown>> = []

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
    if (this.promptPromiseSequence.length) await this.promptPromiseSequence.shift()
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<unknown> {
    this.getStateCount += 1
    if (this.statePromiseSequence.length) return await this.statePromiseSequence.shift()
    if (this.stateErrorSequence.length) {
      const err = this.stateErrorSequence.shift()
      if (err) throw err
    }
    if (this.stateSequence.length) return this.stateSequence.shift()
    return this.state
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getSessionStats(): Promise<any> {
    this.getSessionStatsCount += 1
    if (this.sessionStatsPromiseSequence.length) return await this.sessionStatsPromiseSequence.shift()
    if (this.sessionStatsDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.sessionStatsDelayMs))
    }
    return this.sessionStats
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
