// Persistent session bindings under the namespaced ACP state directory.
// New format: one validated JSON file per session in sessions/. Legacy
// ~/.agy-acp/sessions.json is read/migrated, but never written.

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STATE_DIR } from "../constants/index.js";
import type { StoredSession } from "../types/session.js";
import { readJsonFile, writeJsonAtomic } from "../utils/fs.js";
import { resolveLegacyAcpStateDir } from "../utils/paths.js";

interface LegacyDiskStore { sessions?: Record<string, Record<string, unknown>> }

function safeSessionId(sessionId: string): string {
	if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) throw new Error("invalid session id");
	return sessionId;
}

function normalizeSession(raw: Record<string, unknown>): StoredSession {
	return {
		conversationId: (raw.conversationId as string | null | undefined) ?? (raw.conversation_id as string | null | undefined) ?? null,
		lastStepIdx: (raw.lastStepIdx as number | undefined) ?? (raw.last_step_idx as number | undefined) ?? -1,
		modelId: (raw.modelId as string | null | undefined) ?? (raw.model_id as string | null | undefined) ?? null,
		permissionMode: (raw.permissionMode as string | null | undefined) ?? (raw.permission_mode as string | null | undefined) ?? null,
		cwd: (raw.cwd as string | undefined) ?? "",
		additionalDirs: Array.isArray(raw.additionalDirs) ? (raw.additionalDirs as unknown[]).filter((d): d is string => typeof d === "string") : [],
		title: (raw.title as string | null | undefined) ?? null,
		updatedAt: (raw.updatedAt as string | undefined) ?? new Date().toISOString(),
	};
}

export class SessionStore {
	private writeChain: Promise<void> = Promise.resolve();
	private legacyLoaded = false;

	constructor(
		private readonly dir: string = path.join(STATE_DIR, "sessions"),
		private readonly stateDir: string = STATE_DIR,
	) {}

	private fileFor(sessionId: string): string {
		return path.join(this.dir, `${safeSessionId(sessionId)}.json`);
	}

	async restore(sessionId: string): Promise<StoredSession | null> {
		await this.migrateLegacy();
		const parsed = await readJsonFile<Record<string, unknown>>(this.fileFor(sessionId));
		return parsed ? normalizeSession(parsed) : null;
	}

	async list(): Promise<Array<{ sessionId: string; session: StoredSession }>> {
		await this.migrateLegacy();
		try {
			const entries = await fs.readdir(this.dir);
			const out: Array<{ sessionId: string; session: StoredSession }> = [];
			for (const entry of entries) {
				if (!entry.endsWith(".json")) continue;
				const sessionId = entry.slice(0, -5);
				const session = await this.restore(sessionId);
				if (session) out.push({ sessionId, session });
			}
			return out;
		} catch {
			return [];
		}
	}

	delete(sessionId: string): Promise<boolean> { return this.deleteStrict(sessionId); }

	deleteStrict(sessionId: string): Promise<boolean> {
		let found = false;
		const task = this.writeChain.then(async () => {
			const file = this.fileFor(sessionId);
			found = fsSync.existsSync(file);
			if (found) await fs.unlink(file);
		});
		this.writeChain = task.catch((err) => console.error(`[agy-acp] WARN: failed to delete session: ${(err as Error).message}`));
		return task.then(() => found);
	}

	persist(sessionId: string, session: StoredSession): Promise<void> {
		this.writeChain = this.writeChain.then(() => this.writeOne(sessionId, session)).catch((err) => console.error(`[agy-acp] WARN: failed to persist session: ${(err as Error).message}`));
		return this.writeChain;
	}

	persistStrict(sessionId: string, session: StoredSession): Promise<void> {
		const task = this.writeChain.then(() => this.writeOne(sessionId, session));
		this.writeChain = task.catch((err) => console.error(`[agy-acp] WARN: failed to persist session (strict): ${(err as Error).message}`));
		return task;
	}

	private async writeOne(sessionId: string, session: StoredSession): Promise<void> {
		await writeJsonAtomic(this.fileFor(sessionId), session);
	}

	private async migrateLegacy(): Promise<void> {
		if (this.legacyLoaded) return;
		this.legacyLoaded = true;
		const legacyFile = path.join(resolveLegacyAcpStateDir(), "sessions.json");
		const legacy = await readJsonFile<LegacyDiskStore>(legacyFile);
		if (!legacy?.sessions) return;
		await fs.mkdir(this.dir, { recursive: true });
		for (const [sessionId, raw] of Object.entries(legacy.sessions) as Array<[string, Record<string, unknown>]>) {
			try {
				const file = this.fileFor(sessionId);
				if (!fsSync.existsSync(file)) await writeJsonAtomic(file, normalizeSession(raw));
			} catch {
				// Skip invalid legacy ids/records.
			}
		}
		await writeJsonAtomic(path.join(this.stateDir, "legacy-migration.json"), { source: legacyFile, migratedAt: new Date().toISOString() });
	}
}
