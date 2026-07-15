import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function readJsonFile<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return null;
	}
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = path.join(
		path.dirname(file),
		`.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
	);
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(tmp, file);
}

export async function pathExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}
