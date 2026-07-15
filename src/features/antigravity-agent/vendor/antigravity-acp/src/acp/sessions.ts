// In-memory session registry with LRU-style eviction, backed by the persistent
// SessionStore so bindings survive restarts.

import { MAX_SESSIONS } from "../constants/index.js";
import type { SessionStore } from "../store/sessionStore.js";
import { newSession, type Session } from "../types/session.js";

export class SessionManager {
	private readonly sessions = new Map<string, Session>();

	constructor(private readonly store: SessionStore) {}

	/** Create a fresh, unbound session with a random id. */
	create(
		cwd: string,
		additionalDirs: string[] = [],
	): { sessionId: string; session: Session } {
		const sessionId = crypto.randomUUID();
		this.evictIfNeeded();
		const session = newSession(cwd, additionalDirs);
		this.sessions.set(sessionId, session);
		return { sessionId, session };
	}

	/** The in-memory session, if loaded (no disk access). */
	peek(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId);
	}

	/** Get a session, restoring it from disk if not already in memory. */
	async ensure(sessionId: string): Promise<Session | null> {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;

		const stored = await this.store.restore(sessionId);
		if (!stored) return null;

		this.evictIfNeeded();
		const session: Session = { ...stored };
		this.sessions.set(sessionId, session);
		return session;
	}

	/** Insert a session under a known id (e.g. for an unknown-but-prompted id). */
	adopt(sessionId: string, session: Session): void {
		this.evictIfNeeded();
		this.sessions.set(sessionId, session);
	}

	/** Remove a session from memory (does not affect persistent storage). */
	evict(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** List all persisted sessions from the store. */
	list(): Promise<Array<{ sessionId: string; session: Session }>> {
		return this.store.list();
	}

	/** Delete a session from memory and persistent storage. Returns true if it
	 *  existed in either location. */
	async delete(sessionId: string): Promise<boolean> {
		const inMemory = this.sessions.has(sessionId);
		this.sessions.delete(sessionId);
		const inStore = await this.store.delete(sessionId);
		return inMemory || inStore;
	}

	async deleteStrict(sessionId: string): Promise<boolean> {
		const inMemory = this.sessions.has(sessionId);
		const inStore = await this.store.deleteStrict(sessionId);
		this.sessions.delete(sessionId);
		return inMemory || inStore;
	}

	/** Persist a session's binding to disk. */
	persist(sessionId: string, session: Session): Promise<void> {
		return this.store.persist(sessionId, session);
	}

	/** Persist a session's binding to disk, rejecting on failure. */
	persistStrict(sessionId: string, session: Session): Promise<void> {
		return this.store.persistStrict(sessionId, session);
	}

	private evictIfNeeded(): void {
		while (this.sessions.size >= MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) break;
			this.sessions.delete(oldest);
		}
	}
}
