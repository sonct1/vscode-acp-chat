#!/usr/bin/env node
// Entry point for the vendored Node 22 agy ACP server.

import pkg from "./package.json" with { type: "json" };

async function main(): Promise<void> {
	if (process.argv.includes("--version") || process.argv.includes("-v")) {
		process.stdout.write(`${pkg.version}\n`);
		process.exit(0);
	}

	// stdout is the ACP wire — route every other log to stderr.
	console.log = console.error;
	console.info = console.error;
	console.warn = console.error;
	console.debug = console.error;

	process.on("unhandledRejection", (reason) => {
		console.error("[agy-acp] unhandled rejection:", reason);
	});

	try {
		await import("node:sqlite");
	} catch (error) {
		throw new Error(`Node 22 with node:sqlite is required: ${(error as Error).message}`);
	}

	const { runAcp } = await import("./src/acp/server");
	const { connection, agent } = await runAcp();
	const shutdown = async () => {
		await agent.shutdown?.().catch(() => {});
		process.exit(0);
	};
	connection.closed.then(shutdown).catch(shutdown);
	process.on("SIGINT", () => void shutdown());
	if (process.platform !== "win32") process.on("SIGTERM", () => void shutdown());
}

main().catch((err: Error) => {
	process.stderr.write(`[agy-acp] fatal: ${err.message}\n`);
	process.exit(1);
});
