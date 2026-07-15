// Full conversation-history replay for session/load, cached by DB/WAL identity.
//
// Antigravity may update the highest-index row in place while text is streaming,
// so any file identity change triggers a full rebuild instead of an unsafe tail
// append. Only a byte-for-byte unchanged DB/WAL pair can use the fast path.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { MAX_REPLAY_CACHE } from "../constants/index.js";
import { Lru } from "../utils/lru.js";
import { ConversationDb, type DbStat, statConversation } from "./database.js";
import { Translator } from "./translator.js";

export interface ReplayOptions {
	skipNarration: boolean;
	cwd?: string;
}

export interface ReplayResult {
	updates: SessionUpdate[];
	/** Highest step idx covered (advances even for steps that emit nothing). */
	maxIdx: number;
}

interface CacheEntry extends ReplayResult {
	stat: DbStat;
	skipNarration: boolean;
	cwd: string | undefined;
}

/** Translate an entire conversation from scratch. Returns null if unreadable. */
function buildReplay(
	dir: string,
	id: string,
	opts: ReplayOptions,
): ReplayResult | null {
	const conn = ConversationDb.open(dir, id);
	if (!conn) return null;
	try {
		const translator = new Translator({ mode: "replay", ...opts });
		const updates = translator.translate(conn.readAfter(-1));
		return { updates, maxIdx: translator.lastStepIdx };
	} finally {
		conn.close();
	}
}

/**
 * Replays conversations into ACP updates, caching results so repeat loads of an
 * unchanged (or merely-extended) conversation are cheap.
 */
export class ReplayCache {
	private readonly cache = new Lru<string, CacheEntry>(MAX_REPLAY_CACHE);

	/** Replay a conversation, using/refreshing the cache. Null if unreadable. */
	get(dir: string, id: string, opts: ReplayOptions): ReplayResult | null {
		const stat = statConversation(dir, id);
		if (!stat) return null;

		const entry = this.cache.get(id);
		const sameOptions =
			entry?.skipNarration === opts.skipNarration && entry?.cwd === opts.cwd;

		if (entry && sameOptions) {
			const mainUnchanged =
				entry.stat.mtimeMs === stat.mtimeMs &&
				entry.stat.ctimeMs === stat.ctimeMs &&
				entry.stat.size === stat.size &&
				entry.stat.dev === stat.dev &&
				entry.stat.ino === stat.ino;
			const walUnchanged =
				entry.stat.walMtimeMs === stat.walMtimeMs &&
				entry.stat.walCtimeMs === stat.walCtimeMs &&
				entry.stat.walSize === stat.walSize &&
				entry.stat.walDev === stat.walDev &&
				entry.stat.walIno === stat.walIno;

			// Fast path: both the main DB and WAL are identical to what we cached.
			if (mainUnchanged && walUnchanged) {
				return { updates: entry.updates, maxIdx: entry.maxIdx };
			}

		}

		// Full (re)build whenever the main DB or WAL identity changed.
		const built = buildReplay(dir, id, opts);
		if (!built) return null;
		this.store(id, built, stat, opts);
		return built;
	}


	private store(
		id: string,
		result: ReplayResult,
		stat: DbStat,
		opts: ReplayOptions,
	): void {
		this.cache.set(id, {
			...result,
			stat,
			skipNarration: opts.skipNarration,
			cwd: opts.cwd,
		});
	}
}
