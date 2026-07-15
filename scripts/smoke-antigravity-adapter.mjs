import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { build } from "esbuild";

const tempRoot = await mkdtemp(join(tmpdir(), "antigravity-acp-smoke-"));
const adapterEntrypoint = join(tempRoot, "antigravity-acp.mjs");
const conversationsDir = join(tempRoot, "conversations");
const stateDir = join(tempRoot, "state");
const fakeAgyPath = join(tempRoot, "fake-agy.mjs");

const fakeAgySource = `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("agy 1.1.2\\n");
  process.exit(0);
}
if (args.includes("models")) {
  process.stdout.write("Fake Antigravity Model\\n");
  process.exit(0);
}
const conversationsDir = process.env.AGY_CONVERSATIONS_DIR;
if (!conversationsDir) throw new Error("AGY_CONVERSATIONS_DIR is required");
mkdirSync(conversationsDir, { recursive: true });
const db = new DatabaseSync(join(conversationsDir, "fake-conversation.db"));
db.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)");
db.close();
process.stdout.write("fake assistant response");
`;

await build({
  entryPoints: [
    resolve("src/features/antigravity-agent/vendor/antigravity-acp/index.ts"),
  ],
  bundle: true,
  format: "esm",
  target: "node22",
  minify: true,
  platform: "node",
  outfile: adapterEntrypoint,
  external: ["node:*"],
  logLevel: "silent",
});
await writeFile(fakeAgyPath, fakeAgySource, "utf8");
await chmod(fakeAgyPath, 0o755);

const child = spawn(process.execPath, ["--no-warnings", adapterEntrypoint], {
  cwd: tempRoot,
  env: {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    AGY_BIN: fakeAgyPath,
    AGY_CONVERSATIONS_DIR: conversationsDir,
    AGY_ACP_STATE_DIR: stateDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const updates = [];
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout)
);
const connection = new ClientSideConnection(
  () => ({
    requestPermission: async () => ({
      outcome: { outcome: "cancelled" },
    }),
    sessionUpdate: async (params) => {
      updates.push(params);
    },
  }),
  stream
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const initialized = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "antigravity-smoke", version: "1" },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
  assert(
    initialized.agentInfo?.name === "Antigravity",
    "initialize did not return the Antigravity agent"
  );

  const session = await connection.newSession({
    cwd: tempRoot,
    mcpServers: [],
  });
  assert(
    session.configOptions?.some((option) => option.id === "mode"),
    "session/new did not expose the mode config option"
  );

  const prompted = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  assert(prompted.stopReason === "end_turn", "prompt did not complete");

  const assistantText = updates
    .filter(
      ({ update }) => update.sessionUpdate === "agent_message_chunk"
    )
    .map(({ update }) =>
      update.content.type === "text" ? update.content.text : ""
    )
    .join("");
  assert(
    assistantText === "fake assistant response",
    "prompt output was not streamed over ACP"
  );

  await connection.closeSession({ sessionId: session.sessionId });
  console.log("Antigravity adapter ACP smoke passed");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "close").catch(() => undefined),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  await rm(tempRoot, { recursive: true, force: true });
  if (stderr.trim()) process.stderr.write(stderr);
}
