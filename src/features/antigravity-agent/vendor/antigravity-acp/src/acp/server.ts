// Wire Node stdio to the ACP connection and dispatch to AgyAcpAgent.

import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import pkg from "../../package.json";
import { resolveAgyBinary, validateAgyBinary } from "../agy/binary.js";
import { CONVERSATION_DIR } from "../constants/index.js";
import { resolveAcpStateDir } from "../utils/paths.js";
import { AgyAcpAgent } from "./agent.js";
import { AcpClient } from "./client.js";

function stdoutWritable(): WritableStream<Uint8Array> {
	return Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
}

function stdinReadable(): ReadableStream<Uint8Array> {
	return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
}

const raw = <T>() => ({ parse: (p: unknown) => p as T });

export async function runAcp() {
	const skipNarration = process.argv.includes("--skip-narration");
	const binary = resolveAgyBinary();
	await validateAgyBinary(binary);

	const agentImpl = new AgyAcpAgent({
		binary,
		conversationsDir: CONVERSATION_DIR,
		workingDir: process.cwd(),
		stateDir: resolveAcpStateDir(),
		skipNarration,
		version: pkg.version ?? "0.0.0",
	});

	const stream = ndJsonStream(stdoutWritable(), stdinReadable());

	const connection = agent({ name: "agy-acp" })
		.onRequest(methods.agent.initialize, (ctx) => agentImpl.initialize(ctx.params))
		.onRequest(methods.agent.authenticate, (ctx) => agentImpl.authenticate(ctx.params as { methodId?: string }))
		.onRequest(methods.agent.logout, () => agentImpl.logout())
		.onRequest(methods.agent.session.new, (ctx) => agentImpl.newSession(ctx.params as { cwd?: string; additionalDirectories?: string[] }, new AcpClient(ctx.client)))
		.onRequest(methods.agent.session.load, (ctx) => agentImpl.loadSession(ctx.params as { sessionId?: string; cwd?: string; additionalDirectories?: string[] }, new AcpClient(ctx.client)))
		.onRequest(methods.agent.session.resume, (ctx) => agentImpl.resumeSession(ctx.params as { sessionId?: string; cwd?: string; additionalDirectories?: string[] }, new AcpClient(ctx.client)))
		.onRequest(methods.agent.session.list, (ctx) => agentImpl.listSessions(ctx.params as { cwd?: string; cursor?: string }))
		.onRequest(methods.agent.session.delete, (ctx) => agentImpl.deleteSession(ctx.params as { sessionId?: string }))
		.onRequest(methods.agent.session.close, (ctx) => agentImpl.closeSession(ctx.params as { sessionId?: string }))
		.onRequest(methods.agent.session.prompt, (ctx) => agentImpl.prompt(ctx.params, new AcpClient(ctx.client)))
		.onRequest(methods.agent.session.setConfigOption, (ctx) => agentImpl.setConfigOption(ctx.params))
		.onRequest("resources/list", raw<unknown>(), () => agentImpl.listResources())
		.onRequest("prompts/list", raw<unknown>(), () => agentImpl.listPrompts())
		.onRequest("tools/list", raw<unknown>(), () => agentImpl.listTools())
		.onNotification(methods.agent.session.cancel, (ctx) => agentImpl.cancel(ctx.params))
		.connect(stream);

	return { connection, agent: agentImpl };
}
