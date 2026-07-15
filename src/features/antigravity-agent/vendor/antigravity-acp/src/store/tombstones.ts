import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STATE_DIR } from "../constants/index.js";
import { pathExists, writeJsonAtomic } from "../utils/fs.js";

export class TombstoneStore {
	constructor(
		private readonly dir: string = path.join(STATE_DIR, "tombstones"),
		private readonly stateDir: string = STATE_DIR,
	) {}

	private fileFor(id: string): string {
		if (!id || id.includes("/") || id.includes("\\")) throw new Error("invalid tombstone id");
		return path.join(this.dir, `${id}.json`);
	}

	async has(id: string): Promise<boolean> {
		return pathExists(this.fileFor(id));
	}

	async list(): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.dir);
			return entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5));
		} catch {
			return [];
		}
	}

	async add(id: string): Promise<void> {
		await writeJsonAtomic(this.fileFor(id), { id, tombstonedAt: new Date().toISOString() });
		await fs.mkdir(this.stateDir, { recursive: true });
	}
}
