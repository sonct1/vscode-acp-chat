// Spawning and querying the agy CLI via Node's child_process APIs.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { readJsonFile, writeJsonAtomic } from "../utils/fs.js";

const NATIVE_MODES = new Set(["default", "accept-edits", "plan"]);
const UNSAFE_ARG_MARKERS = ["skip-permissions", "bypass", "dont-ask"];
const MODELS_TIMEOUT_MS = 5_000;
const MODELS_CACHE_TTL_MS = 10 * 60_000;

export interface ModelsCache { models: string[]; updatedAt: number }

export type AgyFailureKind = "auth" | "quota" | "rate_limit" | "timeout" | "process_exit" | "no_db" | "ambiguous_binding" | "incompatible_schema" | "missing_session";

export function classifyAgyError(stderr: string, exitCode?: number | null): AgyFailureKind {
	const text = stderr.toLowerCase();
	if (/auth|oauth|login|credential|unauthorized|forbidden/.test(text)) return "auth";
	if (/quota|billing|limit exceeded/.test(text)) return "quota";
	if (/rate.?limit|too many requests|429/.test(text)) return "rate_limit";
	if (/timed? out|timeout/.test(text)) return "timeout";
	if (/no conversation db|no db/.test(text)) return "no_db";
	if (/ambiguous/.test(text)) return "ambiguous_binding";
	if (/schema|steps table|required column/.test(text)) return "incompatible_schema";
	if (/missing|tombstone|not found/.test(text)) return "missing_session";
	return exitCode && exitCode !== 0 ? "process_exit" : "process_exit";
}

export function actionableAgyError(kind: AgyFailureKind, detail: string): string {
	switch (kind) {
		case "auth": return `${detail}. Authentication failed; run interactive 'agy' in a terminal and complete OAuth/login, then retry.`;
		case "quota": return `${detail}. agy reported quota exhaustion; check your Antigravity account quota/billing.`;
		case "rate_limit": return `${detail}. agy reported rate limiting; wait and retry.`;
		case "timeout": return `${detail}. agy timed out; check network/authentication and retry.`;
		case "no_db": return `${detail}. agy did not create a conversation database; run interactive 'agy' once and verify AGY_CONVERSATIONS_DIR.`;
		case "ambiguous_binding": return `${detail}. Multiple new agy conversation databases appeared; retry the first prompt.`;
		case "incompatible_schema": return `${detail}. agy's SQLite schema is incompatible with this adapter; upgrade agy to >= 1.1.0.`;
		case "missing_session": return `${detail}. The native conversation is missing or tombstoned.`;
		case "process_exit": return detail;
	}
}

export async function discoverModels(binary: string, cacheFile?: string): Promise<string[]> {
	const now = Date.now();
	const cached = cacheFile ? await readJsonFile<ModelsCache>(cacheFile) : null;
	if (cached && now - cached.updatedAt < MODELS_CACHE_TTL_MS) return cached.models;
	try {
		const child = spawn(binary, ["models"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		const close = new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(-1));
			child.once("close", resolve);
		});
		const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), MODELS_TIMEOUT_MS));
		const result = await Promise.race([close, timeout]);
		if (result === "timeout") {
			child.kill("SIGTERM");
			await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 500))]);
			if (child.exitCode === null) child.kill("SIGKILL");
			return cached?.models ?? [];
		}
		if (result !== 0) return cached?.models ?? [];
		const models = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		if (cacheFile) await writeJsonAtomic(cacheFile, { models, updatedAt: now });
		return models;
	} catch {
		return cached?.models ?? [];
	}
}

export interface AgyArgsOptions {
	workingDir: string;
	additionalDirs?: string[];
	conversationId: string | null;
	modelId: string | null;
	permissionMode: string | null;
	prompt: string;
	extraArgs?: string[];
}

function isUnsafeArg(arg: string): boolean {
	const lower = arg.toLowerCase();
	return UNSAFE_ARG_MARKERS.some((marker) => lower.includes(marker));
}

export function normalizeMode(mode: string | null): string {
	if (!mode) return "default";
	if (!NATIVE_MODES.has(mode)) throw new Error(`Unsupported agy mode: ${mode}`);
	return mode;
}

export function buildAgyArgs(opts: AgyArgsOptions): string[] {
	const args = ["--add-dir", opts.workingDir];
	for (const dir of opts.additionalDirs ?? []) args.push("--add-dir", dir);
	if (opts.extraArgs?.length) args.push(...opts.extraArgs.filter((arg) => !isUnsafeArg(arg)));
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	if (opts.modelId) args.push("--model", opts.modelId);
	args.push("--mode", normalizeMode(opts.permissionMode));
	args.push("-p", opts.prompt);
	return args;
}

export type AgyChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export function spawnAgy(binary: string, args: string[], cwd: string): AgyChildProcess {
	return spawn(binary, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

export function extraArgsFromEnv(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0 && !isUnsafeArg(s)) : [];
}
