import type {
  SessionStore,
  StoredSessionRecord,
} from "../../acp/session-manager";

/** In-memory store for tests. */
export function inMemorySessionStore(): SessionStore {
  let sessions: StoredSessionRecord[] = [];
  return {
    async read() {
      return sessions;
    },
    async write(updated) {
      sessions = updated;
    },
  };
}
