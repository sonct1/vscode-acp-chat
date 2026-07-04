import type {
  SessionStore,
  StoredSessionRecord,
} from "../../acp/session-manager";

/** In-memory store for tests. */
export function inMemorySessionStore(): SessionStore {
  const sessions = new Map<string, StoredSessionRecord>();
  return {
    async read() {
      return Array.from(sessions.values());
    },
    async readOne(sessionId: string) {
      return sessions.get(sessionId);
    },
    async writeOne(session: StoredSessionRecord) {
      sessions.set(session.sessionId, session);
    },
    async deleteOne(sessionId: string) {
      sessions.delete(sessionId);
    },
  };
}
