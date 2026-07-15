// ACP method surface for the agy agent: session lifecycle, prompting, history
// replay, model/permission configuration.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AuthenticateResponse,
	CloseSessionResponse,
	DeleteSessionResponse,
	InitializeRequest,
	InitializeResponse,
	ListSessionsResponse,
	LoadSessionResponse,
	LogoutResponse,
	NewSessionResponse,
	PromptResponse,
	ResumeSessionResponse,
	SessionConfigOption,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { discoverModels, type ModelsCache } from "../agy/process.js";
import {
	ACCEPT_EDITS_MODE_ID,
	AUTH_METHOD_ID,
	AVAILABLE_COMMANDS,
	DEFAULT_MODE_ID,
	MODE_CONFIG_ID,
	MODEL_CONFIG_ID,
	PLAN_MODE_ID,
} from "../constants/index.js";
import { readMaxStepIdx } from "../conversation/metadata.js";
import { ReplayCache } from "../conversation/replay.js";
import { SessionStore } from "../store/sessionStore.js";
import { TombstoneStore } from "../store/tombstones.js";
import { newSession, type Session } from "../types/session.js";
import { Adapter } from "./adapter.js";
import { NativeSessionCatalog } from "./catalog.js";
import type { AcpClient } from "./client.js";
import { SessionManager } from "./sessions.js";

export interface AgentConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	stateDir: string;
	skipNarration: boolean;
	version: string;
}

type Json = Record<string, unknown>;

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function parseCursor(cursor: string): { updatedAtMs: number; id: string } {
	const separator = cursor.indexOf(":");
	const timestampText = cursor.slice(0, separator);
	const id = cursor.slice(separator + 1);
	if (
		separator <= 0 ||
		separator === cursor.length - 1 ||
		!/^(?:\d+)(?:\.\d+)?$/.test(timestampText) ||
		id.includes(":")
	) {
		throw RequestError.invalidParams(undefined, "invalid cursor");
	}

	const updatedAtMs = Number(timestampText);
	if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) {
		throw RequestError.invalidParams(undefined, "invalid cursor");
	}
	return { updatedAtMs, id };
}

interface ConfigResult {
	configOptions: SessionConfigOption[];
}

interface ListedSession {
	sessionId: string;
	conversationId: string | null;
	cwd: string;
	additionalDirs: string[];
	title: string | null;
	updatedAtMs: number;
}

function persistedTimestamp(value: string): number {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

export class AgyAcpAgent {
	private readonly sessions: SessionManager;
	private readonly tombstoneStore: TombstoneStore;
	private readonly catalog: NativeSessionCatalog;
	private readonly adapter: Adapter;
	private readonly replayCache = new ReplayCache();
	private availableModels: string[] = [];
	// Tracks which AcpClient is serving each session so async updates can be pushed.
	private readonly activeClients = new Map<string, AcpClient>();

	constructor(private readonly config: AgentConfig) {
		const modelCacheFile = path.join(config.stateDir, "models.json");
		const sessionStore = new SessionStore(
			path.join(config.stateDir, "sessions"),
			config.stateDir,
		);
		this.sessions = new SessionManager(sessionStore);

		this.tombstoneStore = new TombstoneStore(
			path.join(config.stateDir, "tombstones"),
			config.stateDir,
		);

		this.catalog = new NativeSessionCatalog(
			this.tombstoneStore,
			config.conversationsDir,
		);

		this.adapter = new Adapter({
			binary: config.binary,
			conversationsDir: config.conversationsDir,
			workingDir: config.workingDir,
			stateDir: config.stateDir,
			skipNarration: config.skipNarration,
		});

		// Attempt to load models from the shared versioned cache immediately.
		try {
			if (fs.existsSync(modelCacheFile)) {
				const cached = JSON.parse(
					fs.readFileSync(modelCacheFile, "utf-8"),
				) as Partial<ModelsCache>;
				if (Array.isArray(cached.models) && cached.models.length > 0) {
					this.availableModels = cached.models;
				}
			}
		} catch {
			// ignore
		}

		// Kick off model discovery in the background. discoverModels owns the
		// atomic cache write; this layer only updates active ACP sessions.
		discoverModels(config.binary, modelCacheFile).then((models) => {
			const changed =
				JSON.stringify(models) !== JSON.stringify(this.availableModels);
			if (changed && models.length > 0) {
				this.availableModels = models;
				this.pushConfigOptionUpdates();
			}
		});
	}

	// --- ACP methods ---------------------------------------------------------

	initialize(_params?: InitializeRequest): InitializeResponse {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "Antigravity", version: this.config.version },
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { embeddedContext: true },
				sessionCapabilities: {
					list: {},
					delete: {},
					resume: {},
					close: {},
					additionalDirectories: {},
				},
				auth: { logout: {} },
			},
			authMethods: [
				{
					id: AUTH_METHOD_ID,
					name: "Google Sign In",
					description:
						"Antigravity uses Google OAuth2 credentials managed by the agy CLI. " +
						"Run `agy` to configure authentication if needed.",
				},
			],
		};
	}

	authenticate(params: { methodId?: string }): AuthenticateResponse {
		if (params.methodId && params.methodId !== AUTH_METHOD_ID) {
			throw RequestError.invalidParams(
				undefined,
				`unknown auth method: ${params.methodId}`,
			);
		}
		return {};
	}

	logout(): LogoutResponse {
		return {};
	}

	newSession(
		params: { cwd?: string; additionalDirectories?: string[] },
		client: AcpClient,
	): NewSessionResponse {
		const cwd = params.cwd || this.config.workingDir;
		const additionalDirs = params.additionalDirectories ?? [];
		const { sessionId, session } = this.sessions.create(cwd, additionalDirs);
		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return { sessionId, ...this.configResult(session) };
	}

	async loadSession(
		params: {
			sessionId?: string;
			cwd?: string;
			additionalDirectories?: string[];
		},
		client: AcpClient,
	): Promise<LoadSessionResponse> {
		const sessionId = this.validateIdSafe(params.sessionId);
		let session = await this.sessions.ensure(sessionId);

		if (!session) {
			const dbPath = path.join(this.config.conversationsDir, `${sessionId}.db`);
			if (!fs.existsSync(dbPath)) {
				throw RequestError.resourceNotFound(sessionId);
			}

			if (await this.tombstoneStore.has(sessionId)) {
				throw RequestError.resourceNotFound(sessionId);
			}

			const all = await this.sessions.list();
			const existingBinding = all.find(
				(s) => s.session.conversationId === sessionId,
			);
			if (existingBinding && existingBinding.sessionId !== sessionId) {
				throw RequestError.invalidParams(
					undefined,
					"session already bound to another ID",
				);
			}

			const native = await this.catalog.find(sessionId);
			if (!native) {
				throw RequestError.resourceNotFound(sessionId);
			}

			session = newSession(native.cwd, params.additionalDirectories || []);
			session.conversationId = sessionId;
			session.title = native.title;
			session.modelId = null;
			session.lastStepIdx = native.maxStepIdx;

			await this.sessions.persistStrict(sessionId, session);
			this.sessions.adopt(sessionId, session);
		}

		if (
			session.conversationId &&
			(await this.tombstoneStore.has(session.conversationId))
		) {
			throw RequestError.resourceNotFound(sessionId);
		}

		if (!session.conversationId && params.cwd) {
			session.cwd = params.cwd;
		}

		if (params.additionalDirectories) {
			session.additionalDirs = params.additionalDirectories;
		}

		if (session.conversationId) {
			const replay = this.replayCache.get(
				this.config.conversationsDir,
				session.conversationId,
				{ skipNarration: this.config.skipNarration, cwd: session.cwd },
			);
			if (replay && replay.updates.length > 0) {
				for (const update of replay.updates) {
					await client.update(sessionId, update);
				}
				session.lastStepIdx = replay.maxIdx;
				await this.sessions.persist(sessionId, session);
			}
		}

		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return this.configResult(session);
	}

	async resumeSession(
		params: {
			sessionId?: string;
			cwd?: string;
			additionalDirectories?: string[];
		},
		client: AcpClient,
	): Promise<ResumeSessionResponse> {
		const sessionId = this.validateIdSafe(params.sessionId);
		let session = await this.sessions.ensure(sessionId);
		let adoptedNative = false;

		if (!session) {
			const dbPath = path.join(this.config.conversationsDir, `${sessionId}.db`);
			if (!fs.existsSync(dbPath)) {
				throw RequestError.resourceNotFound(sessionId);
			}

			if (await this.tombstoneStore.has(sessionId)) {
				throw RequestError.resourceNotFound(sessionId);
			}

			const all = await this.sessions.list();
			const existingBinding = all.find(
				(s) => s.session.conversationId === sessionId,
			);
			if (existingBinding && existingBinding.sessionId !== sessionId) {
				throw RequestError.invalidParams(
					undefined,
					"session already bound to another ID",
				);
			}

			const native = await this.catalog.find(sessionId);
			if (!native) {
				throw RequestError.resourceNotFound(sessionId);
			}

			session = newSession(native.cwd, params.additionalDirectories || []);
			session.conversationId = sessionId;
			session.title = native.title;
			session.modelId = null;
			session.lastStepIdx = native.maxStepIdx;

			await this.sessions.persistStrict(sessionId, session);
			this.sessions.adopt(sessionId, session);
			adoptedNative = true;
		}

		if (
			session.conversationId &&
			(await this.tombstoneStore.has(session.conversationId))
		) {
			throw RequestError.resourceNotFound(sessionId);
		}

		let dirty = false;
		if (session.conversationId && !adoptedNative) {
			const maxStepIdx = readMaxStepIdx(
				this.config.conversationsDir,
				session.conversationId,
			);
			if (maxStepIdx !== null && session.lastStepIdx !== maxStepIdx) {
				session.lastStepIdx = maxStepIdx;
				dirty = true;
			}
		}
		if (!session.conversationId && params.cwd) {
			session.cwd = params.cwd;
			dirty = true;
		}

		if (params.additionalDirectories) {
			session.additionalDirs = params.additionalDirectories;
			dirty = true;
		}

		if (dirty) await this.sessions.persist(sessionId, session);

		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return this.configResult(session);
	}

	async listSessions(params: {
		cwd?: string;
		cursor?: string;
	}): Promise<ListSessionsResponse> {
		const nativeSessions = await this.catalog.discover();
		const persisted = await this.sessions.list();

		const tombstoneSet = new Set(await this.tombstoneStore.list());
		const merged = new Map<string, ListedSession>();
		const nativeByConversation = new Map<string, ListedSession>();

		for (const native of nativeSessions) {
			if (!tombstoneSet.has(native.id)) {
				const listed: ListedSession = {
					sessionId: native.id,
					conversationId: native.id,
					cwd: native.cwd,
					additionalDirs: [],
					title: native.title,
					updatedAtMs: native.updatedAtMs,
				};
				merged.set(native.id, listed);
				nativeByConversation.set(native.id, listed);
			}
		}

		const persistedByConversation = new Map<string, string>();
		const persistedTimeByConversation = new Map<string, number>();
		for (const p of persisted) {
			if (
				p.session.conversationId &&
				tombstoneSet.has(p.session.conversationId)
			) {
				continue;
			}
			const convId = p.session.conversationId;
			const native = convId ? nativeByConversation.get(convId) : undefined;
			if (convId) {
				merged.delete(convId);
			}
			const previousId = convId
				? persistedByConversation.get(convId)
				: undefined;
			const previous = previousId ? merged.get(previousId) : undefined;
			const persistedUpdatedAtMs = persistedTimestamp(p.session.updatedAt);

			const candidate: ListedSession = {
				sessionId: p.sessionId,
				conversationId: convId,
				cwd: p.session.cwd,
				additionalDirs: p.session.additionalDirs,
				title: native?.title ?? p.session.title ?? previous?.title ?? null,
				updatedAtMs: Math.max(
					persistedUpdatedAtMs,
					native?.updatedAtMs ?? previous?.updatedAtMs ?? 0,
				),
			};

			if (previous && convId) {
				const candidateWins =
					persistedUpdatedAtMs >
						(persistedTimeByConversation.get(convId) ?? 0) ||
					(persistedUpdatedAtMs ===
						(persistedTimeByConversation.get(convId) ?? 0) &&
						candidate.sessionId.localeCompare(previous.sessionId) < 0);
				if (candidateWins) {
					merged.delete(previous.sessionId);
					merged.set(candidate.sessionId, candidate);
					persistedByConversation.set(convId, candidate.sessionId);
					persistedTimeByConversation.set(convId, persistedUpdatedAtMs);
				}
				continue;
			}

			merged.set(candidate.sessionId, candidate);
			if (convId) {
				persistedByConversation.set(convId, candidate.sessionId);
				persistedTimeByConversation.set(convId, persistedUpdatedAtMs);
			}
		}

		let results = Array.from(merged.values());

		if (params.cwd) {
			let reqRealpath: string | null = null;
			try {
				reqRealpath = fs.realpathSync(params.cwd);
			} catch {}

			if (reqRealpath) {
				results = results.filter((r) => {
					const dirs = [r.cwd, ...(r.additionalDirs ?? [])];
					for (const d of dirs) {
						try {
							const rp = fs.realpathSync(d);
							if (isWithin(reqRealpath, rp)) return true;
						} catch {}
					}
					return false;
				});
			} else {
				const requestedCwd = params.cwd;
				results = results.filter(
					(r) =>
						r.cwd === requestedCwd || r.additionalDirs.includes(requestedCwd),
				);
			}
		}

		results.sort((a, b) => {
			if (b.updatedAtMs !== a.updatedAtMs) {
				return b.updatedAtMs - a.updatedAtMs;
			}
			const idA = a.conversationId || a.sessionId;
			const idB = b.conversationId || b.sessionId;
			return idA.localeCompare(idB);
		});

		const PAGE_SIZE = 50;
		if (params.cursor !== undefined) {
			const { updatedAtMs: curTime, id: curId } = parseCursor(params.cursor);
			const idx = results.findIndex((r) => {
				if (r.updatedAtMs < curTime) return true;
				if (r.updatedAtMs === curTime) {
					const rid = r.conversationId || r.sessionId;
					return rid.localeCompare(curId) > 0;
				}
				return false;
			});
			if (idx !== -1) {
				results = results.slice(idx);
			} else {
				results = [];
			}
		}

		let nextCursor: string | undefined;
		if (results.length > PAGE_SIZE) {
			const last = results[PAGE_SIZE - 1];
			if (last) {
				nextCursor = `${last.updatedAtMs}:${last.conversationId || last.sessionId}`;
			}
			results = results.slice(0, PAGE_SIZE);
		}

		return {
			sessions: results.map((r) => ({
				sessionId: r.sessionId,
				cwd: r.cwd,
				title: r.title,
				updatedAt: new Date(r.updatedAtMs).toISOString(),
				additionalDirectories: r.additionalDirs,
			})),
			nextCursor,
		};
	}

	async deleteSession(params: {
		sessionId?: string;
	}): Promise<DeleteSessionResponse> {
		const sessionId = this.validateIdSafe(params.sessionId);

		let conversationId = sessionId;
		const session =
			this.sessions.peek(sessionId) || (await this.sessions.ensure(sessionId));
		if (session?.conversationId) {
			conversationId = session.conversationId;
		}

		const dbPath = path.join(
			this.config.conversationsDir,
			`${conversationId}.db`,
		);
		const hasNative = fs.existsSync(dbPath);

		if (hasNative || session?.conversationId) {
			await this.tombstoneStore.add(conversationId);
		}

		const deleted = await this.sessions.deleteStrict(sessionId);
		if (!deleted && !hasNative) {
			throw RequestError.resourceNotFound(sessionId);
		}

		this.activeClients.delete(sessionId);
		return {};
	}

	closeSession(params: { sessionId?: string }): CloseSessionResponse {
		const sessionId = params.sessionId;
		if (sessionId) {
			this.adapter.cancel(sessionId);
			this.sessions.evict(sessionId);
			this.activeClients.delete(sessionId);
		}
		return {};
	}

	async prompt(
		params: { sessionId?: string; prompt?: unknown },
		client: AcpClient,
	): Promise<PromptResponse> {
		const sessionId = this.validateIdSafe(params.sessionId);

		if (await this.tombstoneStore.has(sessionId)) {
			throw RequestError.resourceNotFound(sessionId);
		}

		let session = await this.sessions.ensure(sessionId);
		if (
			session?.conversationId &&
			(await this.tombstoneStore.has(session.conversationId))
		) {
			throw RequestError.resourceNotFound(sessionId);
		}

		if (!session) {
			session = newSession(this.config.workingDir);
			this.sessions.adopt(sessionId, session);
		}

		const rawText = promptText(params.prompt);
		const outcome = await this.adapter.runPrompt(
			sessionId,
			session,
			rawText,
			client,
			async () => {
				await this.sessions.persistStrict(sessionId, session);
			},
		);

		if (session.conversationId === null) session.conversationId = outcome.conversationId;
		if (outcome.conversationId !== null) {
			session.lastStepIdx = outcome.lastStepIdx;
			session.updatedAt = new Date().toISOString();
			await this.sessions.persistStrict(sessionId, session);
		}

		if (outcome.error) {
			throw RequestError.internalError(undefined, outcome.error);
		}

		return { stopReason: outcome.stopReason };
	}

	cancel(params: { sessionId?: string }): void {
		if (params.sessionId) this.adapter.cancel(params.sessionId);
	}

	shutdown(): Promise<void> {
		return this.adapter.cancelAll(2_000);
	}

	async setConfigOption(params: {
		sessionId?: string;
		configId?: string;
		value?: unknown;
	}): Promise<SetSessionConfigOptionResponse> {
		const sessionId = this.validateIdSafe(params.sessionId);
		const value = typeof params.value === "string" ? params.value : "";
		if (
			params.configId !== MODEL_CONFIG_ID &&
			params.configId !== MODE_CONFIG_ID
		) {
			throw RequestError.invalidParams(
				undefined,
				`unknown configId: ${params.configId}`,
			);
		}
		if (!value) throw RequestError.invalidParams(undefined, "missing value");
		const session = await this.requireSession(sessionId);
		if (params.configId === MODEL_CONFIG_ID) {
			session.modelId = value;
		} else if (params.configId === MODE_CONFIG_ID) {
			if (![DEFAULT_MODE_ID, ACCEPT_EDITS_MODE_ID, PLAN_MODE_ID].includes(value)) {
				throw RequestError.invalidParams(undefined, `unsupported mode: ${value}`);
			}
			session.permissionMode = value;
		}
		await this.sessions.persist(sessionId, session);
		return { configOptions: this.configOptions(session) };
	}

	listResources(): Json {
		return { resources: [] };
	}
	listPrompts(): Json {
		return { prompts: [] };
	}
	listTools(): Json {
		return { tools: [] };
	}

	// --- helpers -------------------------------------------------------------

	private validateIdSafe(sessionId: string | undefined): string {
		if (!sessionId) {
			throw RequestError.invalidParams(undefined, "missing sessionId");
		}
		if (sessionId.includes("/") || sessionId.includes("\\")) {
			throw RequestError.invalidParams(undefined, "invalid sessionId");
		}
		return sessionId;
	}

	private async requireSession(sessionId: string): Promise<Session> {
		const session = await this.sessions.ensure(sessionId);
		if (!session) throw RequestError.resourceNotFound(sessionId);
		return session;
	}

	private pushConfigOptionUpdates(): void {
		for (const [sessionId, client] of this.activeClients) {
			void this.sessions.ensure(sessionId).then((session) => {
				if (!session) return;
				const opts = this.configOptions(session);
				if (opts.length === 0) return;
				void client
					.update(sessionId, {
						sessionUpdate: "config_option_update",
						configOptions: opts,
					} as never)
					.catch(() => {});
			});
		}
	}

	private announceSession(
		client: AcpClient,
		sessionId: string,
		session: Session,
	): void {
		setTimeout(async () => {
			await client
				.update(sessionId, {
					sessionUpdate: "available_commands_update",
					availableCommands: AVAILABLE_COMMANDS,
				} as never)
				.catch(() => {});

			const opts = this.configOptions(session);
			if (opts.length > 0) {
				await client
					.update(sessionId, {
						sessionUpdate: "config_option_update",
						configOptions: opts,
					} as never)
					.catch(() => {});
			}
		}, 50);
	}

	private configResult(session: Session): ConfigResult {
		return {
			configOptions: this.configOptions(session),
		};
	}

	private configOptions(session: Session): SessionConfigOption[] {
		const options: SessionConfigOption[] = [];
		const models = this.availableModels;

		if (models.length > 0) {
			const currentModel =
				session.modelId ?? models[0] ?? "Gemini 3.5 Flash (Medium)";
			options.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel,
				options: models.map((name) => ({ value: name, name })),
			});
		}

		const pm = session.permissionMode;
		const currentMode =
			pm === ACCEPT_EDITS_MODE_ID
				? ACCEPT_EDITS_MODE_ID
				: pm === PLAN_MODE_ID
					? PLAN_MODE_ID
					: DEFAULT_MODE_ID;

		options.push({
			id: MODE_CONFIG_ID,
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: currentMode,
			options: [
				{
					value: DEFAULT_MODE_ID,
					name: "Standard",
					description: "Antigravity's standard mode",
				},
				{
					value: PLAN_MODE_ID,
					name: "Plan Mode",
					description:
						"Read-only exploration: agent may only read and search, then returns " +
						"a step-by-step plan without making any changes",
				},
				{
					value: ACCEPT_EDITS_MODE_ID,
					name: "Accept Edits",
					description:
						"Antigravity native mode that accepts edit operations while preserving standard safety behavior",
				},
			],
		});

		return options;
	}
}

function escapeAttr(str: string): string {
	return str.replace(/"/g, "&quot;");
}

function promptText(prompt: unknown): string {
	const blocks = Array.isArray(prompt) ? prompt : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const obj = block as Record<string, unknown>;
		const type = obj.type;

		if (type === "text" && typeof obj.text === "string") {
			parts.push(`<user_text>\n${obj.text}\n</user_text>`);
		} else if (type === "resource_link") {
			const uri = typeof obj.uri === "string" ? obj.uri : "unknown";
			const label =
				typeof obj.title === "string"
					? obj.title
					: typeof obj.name === "string"
						? obj.name
						: uri;
			parts.push(
				`<resource_link uri="${escapeAttr(uri)}" title="${escapeAttr(label)}"/>`,
			);
		} else if (
			type === "resource" &&
			obj.resource &&
			typeof obj.resource === "object"
		) {
			const r = obj.resource as Record<string, unknown>;
			const uri = typeof r.uri === "string" ? r.uri : "unknown";
			const text = stringField(r, "text", "content");
			if (text)
				parts.push(
					`<embedded_resource uri="${escapeAttr(uri)}">\n${text}\n</embedded_resource>`,
				);
		} else if (typeof obj.text === "string") {
			parts.push(`<user_text>\n${obj.text}\n</user_text>`);
		}
	}
	return parts.join("\n\n").trim();
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		if (typeof obj[key] === "string") return obj[key] as string;
	}
	return "";
}
