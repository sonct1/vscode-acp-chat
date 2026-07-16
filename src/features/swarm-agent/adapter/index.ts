import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { SwarmRootOrchestrator } from "./root-orchestrator";

function stdoutWritable(): WritableStream<Uint8Array> {
  return Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
}

function stdinReadable(): ReadableStream<Uint8Array> {
  return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
}

export function runSwarmAcp(): void {
  const orchestrator = new SwarmRootOrchestrator({
    configPath: process.env.VSCODE_ACP_CHAT_SWARM_CONFIG_PATH,
    version: process.env.npm_package_version,
  });

  const stream = ndJsonStream(stdoutWritable(), stdinReadable());
  const connection = agent({ name: "vscode-acp-chat-swarm" })
    .onRequest(methods.agent.initialize, (ctx) =>
      orchestrator.initialize(ctx.params)
    )
    .onRequest(methods.agent.session.new, (ctx) =>
      orchestrator.newSession(ctx.params)
    )
    .onRequest(methods.agent.session.close, (ctx) =>
      orchestrator.closeSession(ctx.params)
    )
    .onRequest(methods.agent.session.prompt, (ctx) =>
      orchestrator.prompt(ctx.params, ctx.client)
    )
    .onNotification(methods.agent.session.cancel, (ctx) =>
      orchestrator.cancel(ctx.params)
    )
    .connect(stream);

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await orchestrator.dispose();
      connection.close();
      process.exit(0);
    })();
  }

  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("error", () => process.exit(0));
}

runSwarmAcp();
