// Resolve and validate the `agy` executable. This vendored adapter never
// downloads or bundles agy: set AGY_BIN or ensure agy/agy.exe is on PATH.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIN_AGY_VERSION = "1.1.0";
const VERSION_TIMEOUT_MS = 5_000;

export class AgyValidationError extends Error {
	override name = "AgyValidationError";
}

export function resolveAgyBinary(): string {
	return process.env.AGY_BIN || (process.platform === "win32" ? "agy.exe" : "agy");
}

function parseVersion(text: string): string | null {
	return text.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0] ?? null;
}

function compareVersions(a: string, b: string): number {
	const aa = a.split(".").map(Number);
	const bb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const delta = (aa[i] ?? 0) - (bb[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

export async function validateAgyBinary(binary = resolveAgyBinary()): Promise<string> {
	try {
		const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
			timeout: VERSION_TIMEOUT_MS,
			windowsHide: true,
		});
		const version = parseVersion(`${stdout}\n${stderr}`);
		if (!version) {
			throw new AgyValidationError(
				`Unable to parse agy version from '${binary} --version'. Install agy >= ${MIN_AGY_VERSION}.`,
			);
		}
		if (compareVersions(version, MIN_AGY_VERSION) < 0) {
			throw new AgyValidationError(
				`agy ${version} is unsupported; install agy >= ${MIN_AGY_VERSION}.`,
			);
		}
		return version;
	} catch (error) {
		if (error instanceof AgyValidationError) throw error;
		const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
		if (err.killed || err.signal === "SIGTERM") {
			throw new AgyValidationError(
				`Timed out validating '${binary}'. Ensure agy is installed, authenticated, and responsive.`,
			);
		}
		if (err.code === "ENOENT") {
			throw new AgyValidationError(
				`Unable to find agy executable '${binary}'. Set AGY_BIN or add agy to PATH, then run interactive 'agy' to authenticate.`,
			);
		}
		throw new AgyValidationError(
			`Failed to validate agy executable '${binary}': ${err.message}. Run interactive 'agy' to authenticate if needed.`,
		);
	}
}
