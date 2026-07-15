import * as vscode from "vscode";
import type { AgentConfig } from "../../acp/agents";
import { ACPClient } from "../../acp/client";
import {
  AgentSessionManager,
  globalStateSessionStore,
  inMemorySessionStore,
  type HistorySessionPage,
  type HistorySessionRef,
  type SessionInfo,
  type SessionStore,
} from "../../acp/session-manager";
import { getWorkspaceRoot } from "../../utils/workspace";

export interface CatalogCapabilities {
  load: boolean;
  list: boolean;
  delete: boolean;
}

export interface SessionCatalogRuntime {
  client: ACPClient;
  manager: AgentSessionManager;
}

/** Shared per-agent local stores plus temporary control-client fallback. */
export class SessionCatalogService implements vscode.Disposable {
  private readonly stores = new Map<string, SessionStore>();

  constructor(private readonly globalState: vscode.Memento) {}

  getStore(agentId: string): SessionStore {
    let store = this.stores.get(agentId);
    if (store) return store;

    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    store = config.get<boolean>("enablePersistentSessions", true)
      ? globalStateSessionStore(
          this.globalState,
          `vscode-acp-chat.localSessions.v1.${agentId}`,
          {
            retentionDays: config.get<number>("sessionRetentionDays", 30),
            maxSessions: config.get<number>("maxSessionsPerAgent", 300),
          }
        )
      : inMemorySessionStore();
    this.stores.set(agentId, store);
    return store;
  }

  createManager(client: ACPClient): AgentSessionManager {
    return new AgentSessionManager(client, (agentId) => this.getStore(agentId));
  }

  async listSessions(
    agent: AgentConfig,
    runtime?: SessionCatalogRuntime
  ): Promise<SessionInfo[]> {
    const first = await this.listSessionPage(agent, runtime, null);
    let sessions = first.sessions;
    let cursor = first.nextCursor ?? null;
    while (cursor) {
      const next = await this.listSessionPage(agent, runtime, cursor);
      sessions = sessions.concat(next.sessions);
      cursor = next.nextCursor ?? null;
    }
    return sessions;
  }

  async listSessionPage(
    agent: AgentConfig,
    runtime?: SessionCatalogRuntime,
    cursor?: string | null
  ): Promise<HistorySessionPage> {
    const cwd = getWorkspaceRoot();
    if (runtime && !runtime.client.isConnected()) {
      if (cursor) {
        return { sessions: [], nextCursor: null, authoritative: false };
      }
      const records = await this.getStore(agent.id).read();
      return {
        sessions: records
          .filter((record) => record.cwd === cwd)
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )
          .map((record) => ({
            sessionId: record.sessionId,
            agentId: agent.id,
            title: record.title,
            cwd: record.cwd,
            updatedAt: record.updatedAt,
            source: "local-fallback" as const,
          })),
        nextCursor: null,
        authoritative: false,
      };
    }
    const page = await this.withRuntime(agent, runtime, (manager) =>
      manager.listSessionPage(cwd, cursor)
    );
    return {
      sessions: page.sessions.map((session): HistorySessionRef => ({
        ...session,
        agentId: session.agentId || agent.id,
      })),
      nextCursor: page.nextCursor,
      authoritative: page.authoritative,
    };
  }

  async listLocalSessions(agent: AgentConfig): Promise<HistorySessionRef[]> {
    const cwd = getWorkspaceRoot();
    const records = await this.getStore(agent.id).read();
    return records
      .filter((record) => record.cwd === cwd)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      .map((record) => ({
        agentId: agent.id,
        sessionId: record.sessionId,
        title: record.title,
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        source: "local-fallback",
      }));
  }

  async deleteSession(
    agent: AgentConfig,
    sessionId: string,
    runtime?: SessionCatalogRuntime
  ): Promise<void> {
    if (runtime && !runtime.client.isConnected()) {
      await this.getStore(agent.id).deleteOne(sessionId);
      return;
    }
    await this.withRuntime(agent, runtime, (manager) =>
      manager.deleteSession(sessionId)
    );
  }

  async getCapabilities(
    agent: AgentConfig,
    runtime?: SessionCatalogRuntime
  ): Promise<CatalogCapabilities> {
    return this.withRuntime(agent, runtime, async (manager) => ({
      load: manager.supportsLoadSession,
      list: manager.supportsListSessions,
      delete: manager.supportsDeleteSession,
    }));
  }

  dispose(): void {
    this.stores.clear();
  }

  private async withRuntime<T>(
    agent: AgentConfig,
    runtime: SessionCatalogRuntime | undefined,
    action: (manager: AgentSessionManager) => Promise<T>
  ): Promise<T> {
    if (runtime?.client.isConnected()) {
      runtime.manager.syncCapabilities();
      return action(runtime.manager);
    }

    const client = runtime?.client ?? new ACPClient({ agentConfig: agent });
    const manager = this.createManager(client);
    try {
      await client.connect(getWorkspaceRoot());
      manager.syncCapabilities();
      return await action(manager);
    } finally {
      if (!runtime) client.dispose();
    }
  }
}
