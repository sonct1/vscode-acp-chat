import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { StepPayload } from "../gen/steps.js";
import { conversationDbPath, statConversation, withBusyRetry } from "./database.js";

export interface NativeMetadata {
	id: string;
	metadataCwdUri: string | null;
	stepCwdUri: string | null;
	title: string | null;
	hasUserPrompt: boolean;
	maxStepIdx: number;
	updatedAtMs: number;
	excluded?: boolean; // True if corrupt/subagent
}

function parseUserPromptText(rawText: string): string | null {
	const text = rawText
		.replace(/^<system>\n\[PLANNING MODE\][\s\S]*?\n<\/?system>\n?/, "")
		.trim();
	const regex =
		/<user_text>\s*([\s\S]*?)\s*<\/user_text>|<resource_link uri="(.*?)" title="(.*?)"\/>|<embedded_resource uri="(.*?)">\s*([\s\S]*?)\s*<\/embedded_resource>/g;

	let firstTextLine: string | null = null;
	let foundAny = false;

	for (const match of text.matchAll(regex)) {
		foundAny = true;
		if (match[1] !== undefined) {
			const line = match[1]
				.split("\n")
				.map((value) => value.trim())
				.find((value) => value.length > 0);
			if (line && !firstTextLine) {
				firstTextLine = line;
			}
		}
	}

	if (!foundAny) {
		firstTextLine =
			text
				.split("\n")
				.map((value) => value.trim())
				.find((value) => value.length > 0) ?? null;
	}

	if (firstTextLine) {
		return firstTextLine.slice(0, 60);
	}
	return null;
}

function decodeFileUri(value: string): string {
	if (!value.toLowerCase().startsWith("file:")) return value;
	try {
		return fileURLToPath(new URL(value));
	} catch {
		return value;
	}
}

/** Read current high-water mark without applying discovery eligibility rules. */
export function readMaxStepIdx(dir: string, id: string): number | null {
	const dbPath = conversationDbPath(dir, id);
	if (!fs.existsSync(dbPath)) return null;

	let db: DatabaseSync | null = null;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		const openedDb = db;
		const row = withBusyRetry(() => openedDb.prepare("SELECT MAX(idx) AS maxStepIdx FROM steps").get() as
			| { maxStepIdx: number | null }
			| undefined);
		return typeof row?.maxStepIdx === "number" ? row.maxStepIdx : null;
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function extractMetadataCwd(blob: Uint8Array): string | null {
	try {
		const reader = new BinaryReader(blob);
		let metadataCwdUri: string | null = null;
		while (reader.pos < reader.len) {
			const [fieldNo, wireType] = reader.tag();
			if (fieldNo === 7 && wireType === 2) {
				metadataCwdUri = reader.string();
			} else {
				reader.skip(wireType);
			}
		}
		return metadataCwdUri ? decodeFileUri(metadataCwdUri) : null;
	} catch {
		return null;
	}
}

export function extractMetadata(dir: string, id: string): NativeMetadata {
	const dbStat = statConversation(dir, id);
	if (!dbStat) {
		return {
			id,
			metadataCwdUri: null,
			stepCwdUri: null,
			title: null,
			hasUserPrompt: false,
			maxStepIdx: 0,
			updatedAtMs: 0,
			excluded: true,
		};
	}

	const dbPath = conversationDbPath(dir, id);
	let db: DatabaseSync | null = null;

	try {
		db = new DatabaseSync(dbPath, { readOnly: true });

		// 1. Get metadata blob
		let metadataCwdUri: string | null = null;
		try {
			const row = db
				.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
				.get() as { data: Uint8Array } | undefined;
			if (row?.data) {
				metadataCwdUri = extractMetadataCwd(row.data);
			}
		} catch {
			// table might not exist
		}

		// 2. Query only the step fields needed for discovery metadata.
		let maxStepIdx = 0;
		let hasUserPrompt = false;
		let title: string | null = null;
		let stepCwdUri: string | null = null;
		let type14Title: string | null = null;

		try {
			const maxRow = db
				.prepare("SELECT COALESCE(MAX(idx), 0) AS maxStepIdx FROM steps")
				.get() as { maxStepIdx: number } | undefined;
			maxStepIdx = maxRow?.maxStepIdx ?? 0;
		} catch {
			// steps table might not exist
		}

		try {
			hasUserPrompt = Boolean(
				db.prepare("SELECT 1 FROM steps WHERE step_type = 14 LIMIT 1").get(),
			);
		} catch {
			// steps table might not exist
		}

		try {
			const row = db
				.prepare(
					"SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1",
				)
				.get() as { step_payload: Uint8Array } | undefined;
			if (row?.step_payload) {
				const payload = StepPayload.decode(row.step_payload);
				const text = (
					payload.userPrompt?.text ||
					payload.userPrompt?.content?.text ||
					""
				).trim();
				if (text) type14Title = parseUserPromptText(text);
			}
		} catch {
			// Ignore malformed prompt payloads.
		}

		try {
			const rows = db
				.prepare(
					"SELECT step_payload FROM steps WHERE step_type = 23 ORDER BY idx",
				)
				.all() as { step_payload: Uint8Array }[];
			for (const row of rows) {
				try {
					const rawTitle = StepPayload.decode(row.step_payload).titleUpdate
						?.title;
					title = rawTitle?.split("\n\n")[0]?.trim() || null;
				} catch {
					// Ignore malformed title payloads.
				}
			}
		} catch {
			// steps table might not exist
		}

		try {
			const rows = db
				.prepare(
					"SELECT step_payload FROM steps WHERE step_type IN (7, 9, 17) ORDER BY idx",
				)
				.all() as { step_payload: Uint8Array }[];
			for (const row of rows) {
				try {
					const payload = StepPayload.decode(row.step_payload);
					const dirUri =
						payload.listDirectory?.dirUri || payload.grepSearch?.cwdUri;
					if (dirUri) {
						stepCwdUri = decodeFileUri(dirUri);
						break;
					}
				} catch {
					// Ignore malformed tool payloads.
				}
			}
		} catch {
			// steps table might not exist
		}

		return {
			id,
			metadataCwdUri,
			stepCwdUri,
			title: title || type14Title || null,
			hasUserPrompt,
			maxStepIdx,
			updatedAtMs: Math.max(dbStat.mtimeMs, dbStat.walMtimeMs),
			excluded: false,
		};
	} catch {
		return {
			id,
			metadataCwdUri: null,
			stepCwdUri: null,
			title: null,
			hasUserPrompt: false,
			maxStepIdx: 0,
			updatedAtMs: Math.max(dbStat.mtimeMs, dbStat.walMtimeMs),
			excluded: true,
		};
	} finally {
		if (db) {
			db.close();
		}
	}
}
