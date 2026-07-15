// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb } from "./database.js";
import { resolveNewConversation, type BindingResult } from "./scan.js";
import { Translator } from "./translator.js";

export interface StreamOptions {
	dir: string;
	/** Bound conversation id, or null to bind the DB agy creates for a fresh prompt. */
	conversationId: string | null;
	/** Highest idx already delivered to the client before this turn. */
	baseStepIdx: number;
	skipNarration: boolean;
	cwd?: string;
	/** Snapshot of conversation ids before the prompt, for binding a new DB. */
	snapshot: Set<string> | null;
	/** agy child PID, used to prefer DB files opened by this process. */
	pid?: number;
	/** Called once while the first-turn lock is held after a DB is schema-validated. */
	onBind?: (conversationId: string, lastStepIdx: number) => Promise<void> | void;
	/** Emit DB agent text during live polling. Defaults to true. */
	emitAgentText?: boolean;
}

function agentTextFromUpdate(update: SessionUpdate): string {
	if (update.sessionUpdate !== "agent_message_chunk") return "";
	return update.content.type === "text" ? update.content.text : "";
}

export class StreamPoller {
	private readonly translator: Translator;
	private db: ConversationDb | null = null;
	private boundId: string | null;
	private bindingResult: BindingResult = { kind: "none" };
	private bindingPersisted = false;

	constructor(private readonly opts: StreamOptions) {
		this.boundId = opts.conversationId;
		this.translator = new Translator({
			mode: "stream",
			skipNarration: opts.skipNarration,
			emitAgentText: opts.emitAgentText,
			cwd: opts.cwd,
		});
	}

	get conversationId(): string | null {
		return this.boundId;
	}

	get lastStepIdx(): number {
		return Math.max(this.translator.lastStepIdx, this.opts.baseStepIdx);
	}

	get hadUpdates(): boolean {
		return this.translator.hadUpdates;
	}

	get bindState(): BindingResult {
		return this.boundId ? { kind: "single", id: this.boundId } : this.bindingResult;
	}

	get isBindingPersisted(): boolean {
		return this.boundId !== null && (this.opts.snapshot === null || this.bindingPersisted);
	}

	private async ensureDb(): Promise<ConversationDb | null> {
		if (this.boundId === null && this.opts.snapshot !== null) {
			this.bindingResult = resolveNewConversation(
				this.opts.dir,
				this.opts.snapshot,
				this.opts.pid,
			);
			if (this.bindingResult.kind === "single") {
				this.boundId = this.bindingResult.id;
			} else {
				return null;
			}
		}
		if (this.boundId === null) return null;

		if (this.db === null) this.db = ConversationDb.open(this.opts.dir, this.boundId);
		if (this.db !== null && !this.bindingPersisted && this.opts.snapshot !== null) {
			await this.opts.onBind?.(this.boundId, this.lastStepIdx);
			this.bindingPersisted = true;
		}
		return this.db;
	}

	/** Read steps appended since the turn began and translate the new ones. */
	async poll(): Promise<SessionUpdate[]> {
		const db = await this.ensureDb();
		if (db === null) return [];
		return this.translator.translate(db.readAfter(this.opts.baseStepIdx));
	}

	/**
	 * Reconstruct canonical assistant text for this turn from the final DB state.
	 * A fresh translator rebuilds repeated same-idx text rows into ordered deltas.
	 */
	async finalAgentText(): Promise<string> {
		const db = await this.ensureDb();
		if (db === null) return "";

		const translator = new Translator({
			mode: "stream",
			skipNarration: this.opts.skipNarration,
			cwd: this.opts.cwd,
		});

		return translator
			.translate(db.readAfter(this.opts.baseStepIdx))
			.map(agentTextFromUpdate)
			.join("");
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}
