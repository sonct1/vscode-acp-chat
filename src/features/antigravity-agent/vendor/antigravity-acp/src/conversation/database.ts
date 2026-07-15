// Read-only access to agy's per-conversation SQLite databases (node:sqlite).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { StepPayload } from "../gen/steps.js";
import type { StepRow } from "../types/index.js";
import {
	decodeErrorDetails,
	decodePermissions,
	decodeTaskDetails,
} from "./columns.js";

const SELECT_ROWS =
	"SELECT idx, step_type, status, step_payload, error_details, permissions, task_details " +
	"FROM steps WHERE idx > ? ORDER BY idx";
const REQUIRED_COLUMNS = ["idx", "step_type", "status", "step_payload", "error_details", "permissions", "task_details"] as const;

export class ConversationDbError extends Error {
	constructor(
		readonly kind: "incompatible_schema" | "read_error",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ConversationDbError";
	}
}

interface RawRow {
	idx: number;
	step_type: number;
	status: number;
	step_payload: unknown;
	error_details: unknown;
	permissions: unknown;
	task_details: unknown;
}

export function isSqliteBusy(error: unknown): boolean {
	const e = error as { code?: string; message?: string };
	return e.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(e.message ?? "");
}

export function withBusyRetry<T>(operation: () => T, attempts = 5): T {
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try { return operation(); } catch (error) {
			last = error;
			if (!isSqliteBusy(error) || attempt === attempts - 1) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
		}
	}
	throw last;
}

function toUint8(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	if (Buffer.isBuffer(v)) return new Uint8Array(v);
	return new Uint8Array(0);
}

function decodeColumn<T>(v: unknown, decode: (b: Uint8Array) => T): T | null {
	const bytes = toUint8(v);
	return bytes.length === 0 ? null : decode(bytes);
}

function rowToStep(r: RawRow): StepRow {
	return {
		idx: r.idx,
		stepType: r.step_type,
		status: r.status,
		stepPayload: StepPayload.decode(toUint8(r.step_payload)),
		error: decodeColumn(r.error_details, decodeErrorDetails),
		permission: decodeColumn(r.permissions, decodePermissions),
		task: decodeColumn(r.task_details, decodeTaskDetails),
	};
}

export function conversationDbPath(dir: string, id: string): string {
	return path.join(dir, `${id}.db`);
}

export interface DbStat {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	dev: bigint;
	ino: bigint;
	walMtimeMs: number;
	walCtimeMs: number;
	walSize: number;
	walDev: bigint;
	walIno: bigint;
}

interface FileIdentity {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	dev: bigint;
	ino: bigint;
}

function safeStat(filePath: string): FileIdentity | null {
	try {
		const stat = fs.statSync(filePath, { bigint: true });
		return {
			mtimeMs: Number(stat.mtimeNs) / 1_000_000,
			ctimeMs: Number(stat.ctimeNs) / 1_000_000,
			size: Number(stat.size),
			dev: stat.dev,
			ino: stat.ino,
		};
	} catch {
		return null;
	}
}

export function statConversation(dir: string, id: string): DbStat | null {
	const dbPath = conversationDbPath(dir, id);
	const db = safeStat(dbPath);
	if (!db) return null;
	const wal = safeStat(`${dbPath}-wal`) ?? {
		mtimeMs: 0,
		ctimeMs: 0,
		size: 0,
		dev: 0n,
		ino: 0n,
	};
	return {
		mtimeMs: db.mtimeMs,
		ctimeMs: db.ctimeMs,
		size: db.size,
		dev: db.dev,
		ino: db.ino,
		walMtimeMs: wal.mtimeMs,
		walCtimeMs: wal.ctimeMs,
		walSize: wal.size,
		walDev: wal.dev,
		walIno: wal.ino,
	};
}

function assertSchema(db: DatabaseSync, id: string): void {
	const hasSteps = withBusyRetry(() => db
		.prepare("SELECT COUNT(*) > 0 AS present FROM sqlite_master WHERE type='table' AND name='steps'")
		.get() as { present: number } | undefined);
	if (!hasSteps?.present) throw new ConversationDbError("incompatible_schema", `steps table not found in ${id}.db`);

	for (const column of REQUIRED_COLUMNS) {
		const present = withBusyRetry(() => db
			.prepare("SELECT COUNT(*) AS present FROM pragma_table_info('steps') WHERE name = ?")
			.get(column) as { present: number } | undefined);
		if (!present?.present) throw new ConversationDbError("incompatible_schema", `required column ${column} missing from ${id}.db`);
	}
}

export class ConversationDb {
	private constructor(private readonly db: DatabaseSync, private readonly stmt: StatementSync) {}

	/** Open a conversation DB. Returns null only when the file is absent. */
	static open(dir: string, id: string): ConversationDb | null {
		const dbPath = conversationDbPath(dir, id);
		if (!fs.existsSync(dbPath)) return null;
		let db: DatabaseSync | null = null;
		try {
			db = withBusyRetry(() => new DatabaseSync(dbPath, { readOnly: true }));
			const openedDb = db;
			assertSchema(openedDb, id);
			const stmt = withBusyRetry(() => openedDb.prepare(SELECT_ROWS));
			return new ConversationDb(db, stmt);
		} catch (error) {
			try { db?.close(); } catch {}
			if (error instanceof ConversationDbError) throw error;
			throw new ConversationDbError("read_error", `failed to open/read ${id}.db: ${(error as Error).message}`, { cause: error });
		}
	}

	readAfter(afterStepIdx: number): StepRow[] {
		try {
			const rows = withBusyRetry(() => this.stmt.all(afterStepIdx) as unknown as RawRow[]);
			return rows.map(rowToStep);
		} catch (error) {
			if (error instanceof ConversationDbError) throw error;
			throw new ConversationDbError("read_error", `failed to read steps: ${(error as Error).message}`, { cause: error });
		}
	}

	close(): void { this.db.close(); }
}

export function readRows(dir: string, id: string, afterStepIdx: number): StepRow[] | null {
	const conn = ConversationDb.open(dir, id);
	if (!conn) return null;
	try { return conn.readAfter(afterStepIdx); } finally { conn.close(); }
}
