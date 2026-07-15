// Discover agy conversation databases by scanning the conversations directory.
// Used to bind a session to the new DB that agy creates when a fresh prompt runs.

import * as fs from "node:fs";
import { currentProcessDbIds } from "../binding/lock.js";
import { ConversationDb, ConversationDbError } from "./database.js";

export type BindingResult =
	| { kind: "none" }
	| { kind: "single"; id: string }
	| { kind: "ambiguous"; ids: string[] }
	| { kind: "schema_pending"; id: string; message: string }; 

/** Snapshot the set of conversation ids (`*.db` stems) currently on disk. */
export function conversationSnapshot(dir: string): Set<string> {
	const out = new Set<string>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const f of entries) {
		if (f.endsWith(".db")) out.add(f.slice(0, -3));
	}
	return out;
}

function resultFromCandidates(
	dir: string,
	ids: Iterable<string>,
	before: Set<string>,
): BindingResult {
	const candidates = [...new Set(ids)]
		.filter((id) => !before.has(id))
		.sort();
	if (candidates.length === 0) return { kind: "none" };
	if (candidates.length > 1) return { kind: "ambiguous", ids: candidates };

	const id = candidates[0] as string;
	try {
		const db = ConversationDb.open(dir, id);
		if (!db) return { kind: "none" };
		db.close();
		return { kind: "single", id };
	} catch (error) {
		if (error instanceof ConversationDbError) {
			// agy can create the DB file before its schema transaction is visible.
			// Keep polling instead of turning this transient state into a false
			// incompatible-schema failure.
			return { kind: "schema_pending", id, message: error.message };
		}
		throw error;
	}
}

/** Prefer exactly one PID-associated new DB; otherwise use strict snapshot diff. */
export function resolveNewConversation(
	dir: string,
	before: Set<string>,
	pid: number | undefined,
): BindingResult {
	if (pid) {
		const byPid = resultFromCandidates(
			dir,
			currentProcessDbIds(pid, dir),
			before,
		);
		if (byPid.kind !== "none") return byPid;
	}
	return resultFromCandidates(dir, conversationSnapshot(dir), before);
}

/** Back-compat helper for callers/tests that only need nullable single result. */
export function newConversationId(dir: string, before: Set<string>): string | null {
	const result = resolveNewConversation(dir, before, undefined);
	if (result.kind !== "single") {
		if (result.kind === "ambiguous") {
			console.error("[agy-acp] WARN: multiple new agy conversation files appeared; refusing to bind");
		}
		return null;
	}
	return result.id;
}
