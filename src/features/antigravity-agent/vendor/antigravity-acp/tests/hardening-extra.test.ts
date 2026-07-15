import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { Adapter } from "../src/acp/adapter.js";
import { InterprocessLock } from "../src/binding/lock.js";
import { ConversationDbError } from "../src/conversation/database.js";
import { ReplayCache } from "../src/conversation/replay.js";
import { resolveNewConversation } from "../src/conversation/scan.js";
import { StepPayload } from "../src/gen/steps.js";
import type { AcpClient } from "../src/acp/client.js";
import type { Session } from "../src/types/session.js";

function clientStub(update: (id: string, update: unknown) => Promise<void>): AcpClient {
	return { update } as AcpClient;
}

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-hardening-"));
}

function createStepsDb(file: string): void {
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)");
	db.close();
}

test("protobuf uses real @bufbuild runtime for fork/join length-delimited messages", () => {
	const payload = StepPayload.encode({
		validityCheck: 150,
		toolRun: undefined,
		writeFile: undefined,
		grepSearch: undefined,
		viewFile: undefined,
		listDirectory: undefined,
		userPrompt: undefined,
		agentText: { text: "hello protobuf" },
		titleUpdate: undefined,
	}).finish();
	const decoded = StepPayload.decode(payload);
	assert.equal(decoded.validityCheck, 150);
	assert.equal(decoded.agentText?.text, "hello protobuf");
	const reader = new BinaryReader(payload);
	assert.equal(typeof reader.uint32(), "number");
});

test("lock release only removes matching owner token and stale live-pid locks are not reclaimed", async () => {
	const dir = await tmpDir();
	const lock = await InterprocessLock.acquire(dir, "owned");
	const lockFile = path.join(dir, "locks", "owned.lock");
	await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "other" }));
	await lock.release();
	assert.match(await fs.readFile(lockFile, "utf8"), /other/);

	const start = Date.now();
	await assert.rejects(() => InterprocessLock.acquire(dir, "owned"), /timed out/);
	assert.ok(Date.now() - start >= 9_000);
});

test("binding resolution reports none, single and ambiguous only after schema validation", async () => {
	const dir = await tmpDir();
	const before = new Set<string>();
	assert.deepEqual(resolveNewConversation(dir, before, undefined), { kind: "none" });

	createStepsDb(path.join(dir, "one.db"));
	assert.deepEqual(resolveNewConversation(dir, before, undefined), { kind: "single", id: "one" });

	createStepsDb(path.join(dir, "two.db"));
	assert.deepEqual(resolveNewConversation(dir, before, undefined), { kind: "ambiguous", ids: ["one", "two"] });

	const bad = new DatabaseSync(path.join(dir, "bad.db"));
	bad.exec("CREATE TABLE other (id INTEGER)");
	bad.close();
	assert.throws(() => resolveNewConversation(dir, before, undefined), ConversationDbError);
});

test("replay cache notices WAL-only changes", () => {
	const dir = path.join(os.tmpdir(), `agy-acp-wal-${crypto.randomUUID()}`);
	const file = path.join(dir, "wal.db");
	return fs.mkdir(dir, { recursive: true }).then(() => {
		const writer = new DatabaseSync(file);
		writer.exec("PRAGMA journal_mode=WAL");
		writer.exec("PRAGMA wal_autocheckpoint=0");
		writer.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)");
		const cache = new ReplayCache();
		assert.equal(cache.get(dir, "wal", { skipNarration: false })?.maxIdx, -1);
		const payload = StepPayload.encode({
			validityCheck: 0,
			toolRun: undefined,
			writeFile: undefined,
			grepSearch: undefined,
			viewFile: undefined,
			listDirectory: undefined,
			userPrompt: undefined,
			agentText: { text: "from wal" },
			titleUpdate: undefined,
		}).finish();
		writer.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(0, 2, 3, payload);
		assert.equal(cache.get(dir, "wal", { skipNarration: false })?.maxIdx, 0);
		writer.close();
	});
});

test("prompt turns for the same session are serialized", async () => {
	const dir = await tmpDir();
	const bin = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	const script = process.platform === "win32"
		? `@echo off\nnode -e "setTimeout(() => console.log(process.argv.at(-1)), 150)" %*\n`
		: `#!/usr/bin/env node\nsetTimeout(() => console.log(process.argv.at(-1)), 150);\n`;
	await fs.writeFile(bin, script, { mode: 0o755 });
	const session: Session = { conversationId: "bound", lastStepIdx: -1, modelId: null, permissionMode: null, cwd: dir, additionalDirs: [], title: null, updatedAt: new Date().toISOString() };
	const adapter = new Adapter({ binary: bin, conversationsDir: dir, workingDir: dir, stateDir: path.join(dir, "state"), skipNarration: false });
	let active = 0;
	let maxActive = 0;
	const client = clientStub(async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 20));
		active--;
	});
	const [first, second] = await Promise.all([
		adapter.runPrompt("same", session, "first", client),
		adapter.runPrompt("same", session, "second", client),
	]);
	assert.equal(first.error, undefined);
	assert.equal(second.error, undefined);
	assert.equal(maxActive, 1);
});

test("first-turn auth failure is classified before missing DB", async () => {
	const dir = await tmpDir();
	const bin = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	await fs.writeFile(
		bin,
		process.platform === "win32"
			? "@echo off\necho OAuth login required 1>&2\nexit /b 1\n"
			: "#!/bin/sh\necho OAuth login required >&2\nexit 1\n",
		{ mode: 0o755 },
	);
	const session: Session = { conversationId: null, lastStepIdx: -1, modelId: null, permissionMode: null, cwd: dir, additionalDirs: [], title: null, updatedAt: new Date().toISOString() };
	const adapter = new Adapter({ binary: bin, conversationsDir: dir, workingDir: dir, stateDir: path.join(dir, "state"), skipNarration: false });
	const out = await adapter.runPrompt("s", session, "hello", clientStub(async () => {}));
	assert.match(out.error ?? "", /Authentication failed/);
	assert.doesNotMatch(out.error ?? "", /conversation database/);
});

test("non-zero exit remains an error after partial output", async () => {
	const dir = await tmpDir();
	createStepsDb(path.join(dir, "bound.db"));
	const bin = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	await fs.writeFile(
		bin,
		process.platform === "win32"
			? "@echo off\necho partial response\necho OAuth login required 1>&2\nexit /b 1\n"
			: "#!/bin/sh\necho partial response\necho OAuth login required >&2\nexit 1\n",
		{ mode: 0o755 },
	);
	const session: Session = { conversationId: "bound", lastStepIdx: -1, modelId: null, permissionMode: null, cwd: dir, additionalDirs: [], title: null, updatedAt: new Date().toISOString() };
	const adapter = new Adapter({ binary: bin, conversationsDir: dir, workingDir: dir, stateDir: path.join(dir, "state"), skipNarration: false });
	const out = await adapter.runPrompt("s", session, "hello", clientStub(async () => {}));
	assert.match(out.error ?? "", /Authentication failed/);
	assert.equal(out.hadUpdates, true);
});

test("first turn with incompatible DB schema returns an actionable schema error", async () => {
	const dir = await tmpDir();
	const bin = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	const script = process.platform === "win32"
		? `@echo off\nnode -e "const {DatabaseSync}=require('node:sqlite'); const path=require('node:path'); const db=new DatabaseSync(path.join(process.cwd(),'incompatible.db')); db.exec('CREATE TABLE other (id INTEGER)'); db.close();"\n`
		: `#!/usr/bin/env node\nconst {DatabaseSync}=require('node:sqlite'); const path=require('node:path'); const db=new DatabaseSync(path.join(process.cwd(),'incompatible.db')); db.exec('CREATE TABLE other (id INTEGER)'); db.close();\n`;
	await fs.writeFile(bin, script, { mode: 0o755 });
	const session: Session = { conversationId: null, lastStepIdx: -1, modelId: null, permissionMode: null, cwd: dir, additionalDirs: [], title: null, updatedAt: new Date().toISOString() };
	const adapter = new Adapter({ binary: bin, conversationsDir: dir, workingDir: dir, stateDir: path.join(dir, "state"), skipNarration: false });
	const out = await adapter.runPrompt("s", session, "hello", clientStub(async () => {}));
	assert.match(out.error ?? "", /SQLite schema is incompatible/);
});

test("first turn with no DB returns actionable no_db even after stdout and zero exit", async () => {
	const dir = await tmpDir();
	const bin = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	await fs.writeFile(bin, process.platform === "win32" ? "@echo off\necho hi\n" : "#!/bin/sh\necho hi\n", { mode: 0o755 });
	const session: Session = { conversationId: null, lastStepIdx: -1, modelId: null, permissionMode: null, cwd: dir, additionalDirs: [], title: null, updatedAt: new Date().toISOString() };
	const updates: unknown[] = [];
	const adapter = new Adapter({ binary: bin, conversationsDir: dir, workingDir: dir, stateDir: path.join(dir, "state"), skipNarration: false });
	const out = await adapter.runPrompt("s", session, "hello", clientStub(async (_id, update) => { updates.push(update); }));
	assert.equal(out.error?.includes("did not create a conversation database"), true);
	assert.equal(updates.length > 0, true);
});

test("first-turn persist callback completes before lock release allows concurrent acquisition", async () => {
	const dir = await tmpDir();
	const bin = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	const script = process.platform === "win32"
		? `@echo off\nnode -e "const {DatabaseSync}=require('node:sqlite'); const path=require('node:path'); const db=new DatabaseSync(path.join(process.cwd(),'bound.db')); db.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)'); db.close(); console.log('done');"\n`
		: `#!/usr/bin/env node\nconst {DatabaseSync}=require('node:sqlite'); const path=require('node:path'); const db=new DatabaseSync(path.join(process.cwd(),'bound.db')); db.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)'); db.close(); console.log('done');\n`;
	await fs.writeFile(bin, script, { mode: 0o755 });
	const session: Session = { conversationId: null, lastStepIdx: -1, modelId: null, permissionMode: null, cwd: dir, additionalDirs: [], title: null, updatedAt: new Date().toISOString() };
	const adapter = new Adapter({ binary: bin, conversationsDir: dir, workingDir: dir, stateDir: path.join(dir, "state"), skipNarration: true });
	let persisted = false;
	const out = await adapter.runPrompt("s", session, "hello", clientStub(async () => {}), async () => {
		assert.equal(session.conversationId, "bound");
		persisted = true;
	});
	assert.equal(out.error, undefined);
	assert.equal(persisted, true);
	const lock = await InterprocessLock.acquire(path.join(dir, "state"), "first-turn-binding");
	await lock.release();
});
