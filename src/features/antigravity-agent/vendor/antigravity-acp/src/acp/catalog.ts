import * as fs from "node:fs";
import * as path from "node:path";
import { getCachedMetadata } from "../conversation/metaCache.js";
import type { NativeMetadata } from "../conversation/metadata.js";
import type { TombstoneStore } from "../store/tombstones.js";
import { resolveBrainDir, resolveLastConversationsFile } from "../utils/paths.js";

export interface NativeSessionInfo {
	id: string;
	cwd: string;
	title: string | null;
	maxStepIdx: number;
	updatedAtMs: number;
}

function lastConversationCwds(): Map<string, string> {
	const idToCwd = new Map<string, string>();
	try {
		const lastConvPath = resolveLastConversationsFile();
		if (!fs.existsSync(lastConvPath)) return idToCwd;
		const data = JSON.parse(fs.readFileSync(lastConvPath, "utf-8")) as Record<
			string,
			string
		>;
		for (const [cwd, id] of Object.entries(data)) {
			if (typeof cwd === "string" && typeof id === "string") {
				idToCwd.set(id, cwd);
			}
		}
	} catch {
		// Ignore unavailable or malformed last-conversations state.
	}
	return idToCwd;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function isInsideBrain(brainDir: string, cwd: string): boolean {
	try {
		return isWithin(fs.realpathSync(brainDir), fs.realpathSync(cwd));
	} catch {
		return isWithin(path.resolve(brainDir), path.resolve(cwd));
	}
}

/** Resolve native attribution in the same priority order for discovery and adoption. */
export function resolveNativeCwd(
	id: string,
	metadata: Pick<NativeMetadata, "metadataCwdUri" | "stepCwdUri">,
	idToCwd = lastConversationCwds(),
): string | null {
	return metadata.metadataCwdUri || idToCwd.get(id) || metadata.stepCwdUri;
}

export class NativeSessionCatalog {
	constructor(
		private readonly tombstoneStore: TombstoneStore,
		private readonly convDir: string,
	) {}

	async discover(): Promise<NativeSessionInfo[]> {
		if (!fs.existsSync(this.convDir)) {
			return [];
		}

		const files = fs.readdirSync(this.convDir);
		const dbIds = files
			.filter((f) => f.endsWith(".db"))
			.map((f) => f.replace(/\.db$/, ""));

		const tombstones = await this.tombstoneStore.list();
		const tombstoneSet = new Set(tombstones);
		const idToCwd = lastConversationCwds();

		const brainDir = resolveBrainDir();

		const sessions: NativeSessionInfo[] = [];

		for (const id of dbIds) {
			if (tombstoneSet.has(id)) {
				continue;
			}

			const meta = getCachedMetadata(this.convDir, id);
			if (meta.excluded || !meta.hasUserPrompt) {
				continue;
			}

			// CWD priority: metadataCwdUri -> last_conversations.json -> stepCwdUri
			const cwd = resolveNativeCwd(id, meta, idToCwd);
			if (!cwd) {
				continue;
			}

			// Exclude subagent DBs, including completed ones whose CWD was removed.
			if (isInsideBrain(brainDir, cwd)) {
				continue;
			}

			sessions.push({
				id,
				cwd,
				title: meta.title,
				maxStepIdx: meta.maxStepIdx,
				updatedAtMs: meta.updatedAtMs,
			});
		}

		return sessions;
	}

	async find(id: string): Promise<NativeSessionInfo | null> {
		return (await this.discover()).find((session) => session.id === id) ?? null;
	}
}
