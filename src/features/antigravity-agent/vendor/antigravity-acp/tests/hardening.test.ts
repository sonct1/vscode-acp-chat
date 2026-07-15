import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { Adapter } from "../src/acp/adapter.js";
import { buildAgyArgs, classifyAgyError, discoverModels, normalizeMode } from "../src/agy/process.js";
import { validateAgyBinary } from "../src/agy/binary.js";
import { InterprocessLock } from "../src/binding/lock.js";
import { ConversationDb, ConversationDbError } from "../src/conversation/database.js";
import { resolveNewConversation } from "../src/conversation/scan.js";
import { StepPayload } from "../src/gen/steps.js";
import { SessionStore } from "../src/store/sessionStore.js";
import { TombstoneStore } from "../src/store/tombstones.js";

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-test-"));
}

async function fakeAgy(dir: string, body: string): Promise<string> {
	const file = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
	const content = process.platform === "win32"
		? `@echo off\nnode -e "${body.replaceAll('"', '\\"')}" %*\n`
		: `#!/usr/bin/env node\n${body}\n`;
	await fs.writeFile(file, content, { mode: 0o755 });
	return file;
}

test("CLI args emit native modes and reject unsupported modes", () => {
	const args = buildAgyArgs({ workingDir: "/w", conversationId: null, modelId: "m", permissionMode: "plan", prompt: "hello", extraArgs: ["--safe", "--skip-permissions"] });
	assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "plan"]);
	assert.equal(args.includes("--skip-permissions"), false);
	assert.equal(normalizeMode(null), "default");
	assert.throws(() => normalizeMode("unsupported"), /Unsupported agy mode/);
});

test("persistence uses per-session files and tombstone markers", async () => {
	const dir = await tmpDir();
	const store = new SessionStore(path.join(dir, "sessions"), dir);
	await store.persistStrict("s1", { conversationId: "c1", lastStepIdx: 2, modelId: null, permissionMode: "default", cwd: "/tmp", additionalDirs: [], title: null, updatedAt: "2026-07-15T00:00:00.000Z" });
	assert.equal((await store.restore("s1"))?.conversationId, "c1");
	assert.equal((await store.list()).length, 1);
	const tombstones = new TombstoneStore(path.join(dir, "tombstones"), dir);
	await tombstones.add("c1");
	assert.equal(await tombstones.has("c1"), true);
});

test("version and models validation work with fake agy and reuse the cache", async () => {
	const dir = await tmpDir();
	const counter = path.join(dir, "models-count.txt");
	const bin = await fakeAgy(dir, `
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('agy 1.1.2'); process.exit(0); }
if (process.argv.includes('models')) { appendFileSync(${JSON.stringify(counter)}, '1'); console.log('gemini-test'); process.exit(0); }
`);
	const cacheFile = path.join(dir, "models.json");
	assert.equal(await validateAgyBinary(bin), "1.1.2");
	assert.deepEqual(await discoverModels(bin, cacheFile), ["gemini-test"]);
	assert.deepEqual(await discoverModels(bin, cacheFile), ["gemini-test"]);
	assert.equal(await fs.readFile(counter, "utf8"), "1");
});

test("DB schema validation accepts steps table and rejects incompatible schema", async () => {
	const dir = await tmpDir();
	const good = new DatabaseSync(path.join(dir, "good.db"));
	good.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)");
	good.close();
	const bad = new DatabaseSync(path.join(dir, "bad.db"));
	bad.exec("CREATE TABLE other (id INTEGER)");
	bad.close();
	const opened = ConversationDb.open(dir, "good");
	assert.ok(opened);
	opened.close();
	assert.throws(() => ConversationDb.open(dir, "bad"), ConversationDbError);
});

test("error classification covers auth, quota, rate-limit and timeout", () => {
	assert.equal(classifyAgyError("OAuth login required"), "auth");
	assert.equal(classifyAgyError("quota exceeded"), "quota");
	assert.equal(classifyAgyError("429 rate limit"), "rate_limit");
	assert.equal(classifyAgyError("timed out"), "timeout");
});

test("interprocess lock serializes concurrent first-turn binding seam", async () => {
	const dir = await tmpDir();
	const first = await InterprocessLock.acquire(dir, "first-turn-binding");
	let acquired = false;
	const second = InterprocessLock.acquire(dir, "first-turn-binding").then(async (lock) => { acquired = true; await lock.release(); });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(acquired, false);
	await first.release();
	await second;
	assert.equal(acquired, true);
});

test("ACP fake agy smoke emits version through process", async () => {
	const dir = await tmpDir();
	const bin = await fakeAgy(dir, `if (process.argv.includes('--version')) { console.log('agy 1.1.2'); process.exit(0); }`);
	const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; });
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	assert.equal(code, 0);
	assert.match(stdout, /1\.1\.2/);
});
