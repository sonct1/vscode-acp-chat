import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const LOCK_WAIT_MS = 10_000;

interface LockFile { pid: number; createdAt: number; token: string }

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockOwnedByLiveProcess(raw: string): boolean {
	try {
		const parsed = JSON.parse(raw) as Partial<LockFile>;
		return typeof parsed.pid === "number" && pidAlive(parsed.pid);
	} catch {
		return false;
	}
}

async function closeHandle(handle: fs.FileHandle | null): Promise<void> {
	if (!handle) return;
	try { await handle.close(); } catch {}
}

export class InterprocessLock {
	private released = false;

	private constructor(
		private readonly file: string,
		private readonly token: string,
	) {}

	static async acquire(stateDir: string, name: string): Promise<InterprocessLock> {
		const dir = path.join(stateDir, "locks");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, `${name}.lock`);
		const start = Date.now();
		const token = crypto.randomUUID();

		while (true) {
			let handle: fs.FileHandle | null = null;
			try {
				handle = await fs.open(file, "wx");
				const payload: LockFile = { pid: process.pid, createdAt: Date.now(), token };
				await handle.writeFile(JSON.stringify(payload));
				await closeHandle(handle);
				return new InterprocessLock(file, token);
			} catch {
				await closeHandle(handle);

				try {
					const raw = await fs.readFile(file, "utf8");
					if (!lockOwnedByLiveProcess(raw)) {
						await fs.unlink(file).catch(() => {});
					}
				} catch {
					await fs.unlink(file).catch(() => {});
				}

				if (Date.now() - start > LOCK_WAIT_MS) {
					throw new Error("timed out waiting for first-turn binding lock");
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		try {
			const raw = await fs.readFile(this.file, "utf8");
			const parsed = JSON.parse(raw) as Partial<LockFile>;
			if (parsed.token === this.token) {
				await fs.unlink(this.file).catch(() => {});
			}
		} catch {}
	}
}

function idFromDbPath(target: string, dir: string): string | null {
	const resolvedDir = path.resolve(dir);
	const resolvedTarget = path.resolve(target);
	if (!resolvedTarget.endsWith(".db")) return null;
	const relative = path.relative(resolvedDir, resolvedTarget);
	if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) return null;
	return path.basename(relative, ".db");
}

function linuxProcessDbIds(pid: number, dir: string): Set<string> {
	const out = new Set<string>();
	const fdDir = `/proc/${pid}/fd`;
	let entries: string[];
	try { entries = fsSync.readdirSync(fdDir); } catch { return out; }
	for (const entry of entries) {
		try {
			const target = fsSync.readlinkSync(path.join(fdDir, entry)).replace(/ \(deleted\)$/, "");
			const id = idFromDbPath(target, dir);
			if (id) out.add(id);
		} catch {}
	}
	return out;
}

function macProcessDbIds(pid: number, dir: string): Set<string> {
	const out = new Set<string>();
	let text = "";
	try { text = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }); } catch { return out; }
	for (const line of text.split("\n")) {
		if (!line.startsWith("n")) continue;
		const id = idFromDbPath(line.slice(1), dir);
		if (id) out.add(id);
	}
	return out;
}

export function currentProcessDbIds(pid: number, dir: string): Set<string> {
	if (!Number.isInteger(pid) || pid <= 0) return new Set();
	if (process.platform === "linux") return linuxProcessDbIds(pid, dir);
	if (process.platform === "darwin") return macProcessDbIds(pid, dir);
	return new Set();
}
