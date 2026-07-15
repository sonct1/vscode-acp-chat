import * as path from "path";
import * as vscode from "vscode";
import type { HistorySessionRef } from "../../acp/session-manager";

const REMOTE_HISTORY_CATALOG_PREFIX = "vscode-acp-chat.remoteHistoryCatalog.v1";
const REMOTE_HISTORY_CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REMOTE_HISTORY_CATALOG_MAX_ENTRIES = 300;

interface StoredHistoryCatalog {
  agentId: string;
  cwd: string;
  cachedAt: string;
  sessions: Array<Omit<HistorySessionRef, "source">>;
}

export function normalizeHistoryCwd(cwd: string): string {
  const normalized = path.normalize(path.resolve(cwd));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function catalogKey(agentId: string, cwd: string): string {
  return `${REMOTE_HISTORY_CATALOG_PREFIX}.${encodeURIComponent(agentId)}.${encodeURIComponent(
    normalizeHistoryCwd(cwd)
  )}`;
}

export function readRemoteHistoryCatalog(
  globalState: vscode.Memento,
  agentId: string,
  cwd: string
): HistorySessionRef[] {
  const normalizedCwd = normalizeHistoryCwd(cwd);
  const stored = globalState.get<StoredHistoryCatalog>(
    catalogKey(agentId, cwd)
  );
  if (
    !stored ||
    stored.agentId !== agentId ||
    normalizeHistoryCwd(stored.cwd) !== normalizedCwd ||
    !Array.isArray(stored.sessions)
  ) {
    return [];
  }
  const cachedAt = new Date(stored.cachedAt ?? 0).getTime();
  if (
    !Number.isFinite(cachedAt) ||
    Date.now() - cachedAt > REMOTE_HISTORY_CATALOG_TTL_MS
  ) {
    void globalState.update(catalogKey(agentId, cwd), undefined);
    return [];
  }

  return stored.sessions
    .filter(
      (session) =>
        session.agentId === agentId &&
        normalizeHistoryCwd(session.cwd) === normalizedCwd
    )
    .map((session) => ({ ...session, source: "remote-cache" as const }));
}

export async function deleteRemoteHistoryCatalogSession(
  globalState: vscode.Memento,
  ref: HistorySessionRef
): Promise<void> {
  const sessions = readRemoteHistoryCatalog(globalState, ref.agentId, ref.cwd)
    .filter((session) => session.sessionId !== ref.sessionId)
    .map(({ source: _source, ...session }) => session);
  await globalState.update(catalogKey(ref.agentId, ref.cwd), {
    agentId: ref.agentId,
    cwd: normalizeHistoryCwd(ref.cwd),
    cachedAt: new Date().toISOString(),
    sessions,
  } satisfies StoredHistoryCatalog);
}

export async function writeRemoteHistoryCatalogPage(
  globalState: vscode.Memento,
  agentId: string,
  cwd: string,
  sessions: HistorySessionRef[],
  append: boolean
): Promise<void> {
  const remoteSessions = sessions.filter(
    (session) =>
      session.agentId === agentId &&
      session.source === "agent" &&
      normalizeHistoryCwd(session.cwd) === normalizeHistoryCwd(cwd)
  );
  if (append && remoteSessions.length === 0) return;

  const merged = new Map<string, HistorySessionRef>();
  if (append) {
    for (const session of readRemoteHistoryCatalog(globalState, agentId, cwd)) {
      merged.set(session.sessionId, session);
    }
  }
  for (const session of remoteSessions) {
    merged.set(session.sessionId, session);
  }

  const sorted = [...merged.values()]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, REMOTE_HISTORY_CATALOG_MAX_ENTRIES);
  await globalState.update(catalogKey(agentId, cwd), {
    agentId,
    cwd: normalizeHistoryCwd(cwd),
    cachedAt: new Date().toISOString(),
    sessions: sorted.map(({ source: _source, ...session }) => session),
  } satisfies StoredHistoryCatalog);
}
