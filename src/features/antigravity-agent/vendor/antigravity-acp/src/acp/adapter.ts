// Prompt-turn runtime: spawn agy, poll its DB while it runs, stream updates to
// the client, and finalize. Bridges the agy subprocess and the conversation
// streaming layer.

import { execFile } from "node:child_process";
import { once } from "node:events";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { actionableAgyError, buildAgyArgs, classifyAgyError, extraArgsFromEnv, spawnAgy, type AgyChildProcess } from "../agy/process.js";
import { reconcileAgentText, streamAgyStdout } from "../agy/stdout.js";
import { POLL_INTERVAL_MS } from "../constants/index.js";
import { InterprocessLock } from "../binding/lock.js";
import { ConversationDbError } from "../conversation/database.js";
import { conversationSnapshot } from "../conversation/scan.js";
import { StreamPoller } from "../conversation/streaming.js";
import type { Session } from "../types/session.js";
import type { AcpClient } from "./client.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
	let text = "";
	stream.setEncoding("utf8");
	for await (const chunk of stream) text += chunk as string;
	return text;
}

function waitForClose(child: AgyChildProcess, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean; spawnError: Error | null }> {
	return new Promise((resolve) => {
		let settled = false;
		let spawnError: Error | null = null;
		const finish = (code: number | null, timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, timedOut, spawnError });
		};
		const timer = setTimeout(() => finish(null, true), timeoutMs);
		child.once("error", (error) => { spawnError = error; });
		child.once("close", (code) => finish(code, false));
	});
}

async function killProcessTree(child: AgyChildProcess, signal: NodeJS.Signals = "SIGINT"): Promise<void> {
	if (process.platform === "win32") {
		if (child.pid) {
			await new Promise<void>((resolve) => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve()));
		} else child.kill();
		return;
	}
	if (child.pid) {
		try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
	} else child.kill(signal);
}

async function terminateProcessTree(child: AgyChildProcess): Promise<void> {
	await killProcessTree(child, "SIGINT");
	const closed = once(child, "close").then(() => true).catch(() => true);
	const grace = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500));
	if (!(await Promise.race([closed, grace]))) await killProcessTree(child, "SIGKILL");
}


function agentChunk(text: string): SessionUpdate {
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	};
}

export interface PromptOutcome {
	stopReason: "end_turn" | "cancelled";
	conversationId: string | null;
	lastStepIdx: number;
	hadUpdates: boolean;
	/** Set when agy failed to start, or exited non-zero with nothing streamed. */
	error?: string;
}

export interface AdapterConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	stateDir: string;
	skipNarration: boolean;
}

export type PersistBinding = (conversationId: string, lastStepIdx: number) => Promise<void>;

export class Adapter {
	private readonly children = new Map<string, AgyChildProcess>();
	private readonly cancelled = new Set<string>();
	private readonly promptChains = new Map<string, Promise<void>>();

	constructor(private readonly config: AdapterConfig) {}

	/** Request cancellation of an in-flight prompt for a session. */
	cancel(sessionId: string): void {
		this.cancelled.add(sessionId);
		const child = this.children.get(sessionId);
		if (child) void terminateProcessTree(child);
	}

	async cancelAll(timeoutMs = 2_000): Promise<void> {
		for (const sessionId of this.children.keys()) this.cancelled.add(sessionId);
		await Promise.race([
			Promise.all([...this.children.values()].map((child) => terminateProcessTree(child))),
			new Promise((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	}

	/** Serialize prompt turns for one ACP session while allowing other sessions to run concurrently. */
	async runPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
		persistBinding?: PersistBinding,
	): Promise<PromptOutcome> {
		const previous = this.promptChains.get(sessionId) ?? Promise.resolve();
		let release: () => void = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chain = previous.catch(() => {}).then(() => current);
		this.promptChains.set(sessionId, chain);
		await previous.catch(() => {});

		try {
			return await this.runPromptTurn(
				sessionId,
				session,
				promptText,
				client,
				persistBinding,
			);
		} finally {
			release();
			if (this.promptChains.get(sessionId) === chain) {
				this.promptChains.delete(sessionId);
			}
		}
	}

	private async runPromptTurn(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
		persistBinding?: PersistBinding,
	): Promise<PromptOutcome> {
		this.cancelled.delete(sessionId);

		// Use the session's cwd if set, otherwise fall back to the server's workingDir.
		const effectiveCwd = session.cwd || this.config.workingDir;

		// Snapshot existing conversations so we can bind the new DB agy creates.
		const firstTurnLock = session.conversationId === null ? await InterprocessLock.acquire(this.config.stateDir, "first-turn-binding") : null;
		const snapshot =
			session.conversationId === null
				? conversationSnapshot(this.config.conversationsDir)
				: null;

		const args = buildAgyArgs({
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			prompt: promptText,
			extraArgs: extraArgsFromEnv(),
		});

		let child: AgyChildProcess;
		try {
			child = spawnAgy(this.config.binary, args, effectiveCwd);
		} catch (err) {
			if (firstTurnLock) await firstTurnLock.release();
			return {
				stopReason: "end_turn",
				conversationId: session.conversationId,
				lastStepIdx: session.lastStepIdx,
				hadUpdates: false,
				error: `failed to run agy: ${(err as Error).message}`,
			};
		}
		this.children.set(sessionId, child);

		const useStdoutText = !this.config.skipNarration;

		const poller = new StreamPoller({
			dir: this.config.conversationsDir,
			conversationId: session.conversationId,
			baseStepIdx: session.lastStepIdx,
			skipNarration: this.config.skipNarration,
			emitAgentText: !useStdoutText,
			cwd: effectiveCwd,
			snapshot,
			pid: child.pid,
			onBind: async (conversationId, lastStepIdx) => {
				session.conversationId = conversationId;
				session.lastStepIdx = lastStepIdx;
				session.updatedAt = new Date().toISOString();
				await persistBinding?.(conversationId, lastStepIdx);
				await firstTurnLock?.release();
			},
		});

		// Serialize all client notifications so stdout and DB producers never call
		// client.update concurrently. Cross-source order follows enqueue arrival order;
		// stdout and SQLite do not expose enough metadata for causal ordering.
		let updateQueue = Promise.resolve();

		const enqueueUpdate = (update: SessionUpdate): Promise<void> => {
			updateQueue = updateQueue
				.then(() => client.update(sessionId, update))
				.catch((err) => {
					console.error(
						`[agy-acp] client update error: ${(err as Error).message}`,
					);
				});

			return updateQueue;
		};

		// Default mode uses stdout for live text. Narration-filtered mode preserves
		// the existing DB text path because stdout chunks do not provide safe
		// narration boundaries. Stdout is still drained in both modes.
		let stdoutText = "";
		const stdoutPromise = streamAgyStdout(child.stdout, (text) => {
			stdoutText += text;
			if (useStdoutText) void enqueueUpdate(agentChunk(text));
		}).catch((err) => {
			console.error(`[agy-acp] stdout read error: ${(err as Error).message}`);
		});

		// Drain stderr concurrently (resolves when the process exits).
		const stderrPromise = readStream(child.stderr);

		// Serialized poll loop: enqueue updates in DB order, never overlap polls.
		const pollOnce = async (): Promise<void> => {
			for (const update of await poller.poll()) {
				await enqueueUpdate(update);
			}
		};

		let polling = true;
		const pollErrors: Error[] = [];
		const recordPollError = (error: unknown, phase: "poll" | "final poll") => {
			const err = error instanceof Error ? error : new Error(String(error));
			if (pollErrors.length === 0) pollErrors.push(err);
			console.error(`[agy-acp] ${phase} error: ${err.message}`);
			if (err instanceof ConversationDbError) polling = false;
		};
		const loop = (async () => {
			while (polling) {
				try {
					await pollOnce();
				} catch (error) {
					recordPollError(error, "poll");
				}
				if (!polling) break;
				await sleep(POLL_INTERVAL_MS);
			}
		})();

		const exit = await waitForClose(child, 10 * 60_000);
		if (exit.timedOut) await terminateProcessTree(child);
		const exitCode = exit.timedOut ? -1 : exit.code;
		polling = false;
		await loop;
		this.children.delete(sessionId);

		await stdoutPromise;

		// A few trailing polls catch rows flushed right around process exit.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await pollOnce();
			} catch (error) {
				recordPollError(error, "final poll");
				if (error instanceof ConversationDbError) break;
			}
			if (attempt < 2) await sleep(100);
		}

		let fallbackText = "";
		if (useStdoutText && pollErrors.length === 0) {
			try {
				const canonicalText = await poller.finalAgentText();
				const reconciliation = reconcileAgentText(stdoutText, canonicalText);

				if (reconciliation.divergent) {
					console.error(
						"[agy-acp] WARN: agy stdout diverged from conversation DB; " +
							"keeping stdout to avoid duplicate assistant text",
					);
				} else if (reconciliation.suffix.length > 0) {
					fallbackText = reconciliation.suffix;
					await enqueueUpdate(agentChunk(fallbackText));
				}
			} catch (error) {
				recordPollError(error, "final poll");
			}
		}

		await updateQueue;
		poller.close();

		const stderr = (await stderrPromise).trim();
		if (stderr.length > 0) console.error(`[agy-acp] agy stderr: ${stderr}`);

		const wasCancelled = this.cancelled.delete(sessionId);
		const hadTextUpdates =
			useStdoutText && (stdoutText.length > 0 || fallbackText.length > 0);

		const outcome: PromptOutcome = {
			stopReason: wasCancelled ? "cancelled" : "end_turn",
			conversationId: poller.conversationId,
			lastStepIdx: poller.lastStepIdx,
			hadUpdates: poller.hadUpdates || hadTextUpdates,
		};

		const pollError = pollErrors[0];
		if (!wasCancelled && exit.spawnError) {
			outcome.error = `failed to run agy: ${exit.spawnError.message}`;
		} else if (!wasCancelled && pollError instanceof ConversationDbError) {
			outcome.error = actionableAgyError(
				pollError.kind === "incompatible_schema"
					? "incompatible_schema"
					: "process_exit",
				pollError.message,
			);
		} else if (!wasCancelled && pollError) {
			outcome.error = `failed to read Antigravity conversation data: ${pollError.message}`;
		} else if (!wasCancelled && exit.timedOut) {
			outcome.error = actionableAgyError("timeout", "agy prompt timed out");
		} else if (!wasCancelled && exitCode !== 0) {
			console.error(`[agy-acp] WARN: agy exited with status ${exitCode}`);
			const detail = stderr.length > 0
				? `agy failed: ${stderr}`
				: `agy exited with status: ${exitCode}`;
			outcome.error = actionableAgyError(
				classifyAgyError(stderr, exitCode),
				detail,
			);
		} else if (!wasCancelled && session.conversationId === null && !poller.isBindingPersisted) {
			const bind = poller.bindState;
			if (bind.kind === "ambiguous") {
				outcome.error = actionableAgyError("ambiguous_binding", `ambiguous conversation binding: ${bind.ids.join(", ")}`);
			} else if (bind.kind === "schema_pending") {
				outcome.error = actionableAgyError(
					"incompatible_schema",
					bind.message,
				);
			} else {
				outcome.error = actionableAgyError("no_db", "no conversation db was bound for the first prompt");
			}
		}

		if (firstTurnLock) await firstTurnLock.release();
		return outcome;
	}
}
