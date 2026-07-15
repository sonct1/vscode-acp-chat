// Discover agy conversation databases by scanning the conversations directory.
// Used to bind a session to the new DB that agy creates when a fresh prompt runs.

import * as fs from "node:fs";
import { currentProcessDbIds } from "../binding/lock.js";
import { ConversationDb } from "./database.js";

export type BindingResult =
	| { kind: "none" }
	| { kind: "single"; id: string }
	| { kind: "ambiguous"; ids: string[] };

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

function validNewIds(dir: string, ids: Iterable<string>, before: Set<string>): string[] {
	const out: string[] = [];
	for (const id of ids) {
		if (before.has(id)) continue;
		const db = ConversationDb.open(dir, id);
		if (!db) continue;
		db.close();
		out.push(id);
	}
	return [...new Set(out)].sort();
}

function resultFromIds(ids: string[]): BindingResult {
	if (ids.length === 0) return { kind: "none" };
	if (ids.length === 1) return { kind: "single", id: ids[0] as string };
	return { kind: "ambiguous", ids };
}

/** Prefer exactly one PID-associated new DB; otherwise use strict snapshot diff. */
export function resolveNewConversation(
	dir: string,
	before: Set<string>,
	pid: number | undefined,
): BindingResult {
	if (pid) {
		const byPid = validNewIds(dir, currentProcessDbIds(pid, dir), before);
		if (byPid.length === 1) return { kind: "single", id: byPid[0] as string };
		if (byPid.length > 1) return { kind: "ambiguous", ids: byPid };
	}
	return resultFromIds(validNewIds(dir, conversationSnapshot(dir), before));
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
