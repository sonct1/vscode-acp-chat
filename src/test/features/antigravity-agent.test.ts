import * as assert from "assert";
import * as vscode from "vscode";
import {
  createAntigravityAgentConfig,
  getBundledAntigravityAcpEntrypoint,
  isAntigravityAgentEnabled,
} from "../../features/antigravity-agent";

suite("features/antigravity-agent", () => {
  let originalEnabled: boolean | undefined;

  setup(() => {
    originalEnabled = vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .get<boolean>("antigravity.enabled");
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update(
        "antigravity.enabled",
        originalEnabled,
        vscode.ConfigurationTarget.Global
      );
  });

  test("setting helper reflects enabled configuration", async () => {
    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update("antigravity.enabled", false, vscode.ConfigurationTarget.Global);
    assert.strictEqual(isAntigravityAgentEnabled(), false);

    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update("antigravity.enabled", true, vscode.ConfigurationTarget.Global);
    assert.strictEqual(isAntigravityAgentEnabled(), true);
  });

  test("entrypoint points at bundled dist adapter", () => {
    assert.ok(
      getBundledAntigravityAcpEntrypoint()
        .replace(/\\/g, "/")
        .endsWith("antigravity-acp/index.mjs")
    );
  });

  test("launch config uses Electron Node without Bun or dangerous flags", () => {
    const config = createAntigravityAgentConfig();
    assert.strictEqual(config.id, "antigravity");
    assert.strictEqual(config.name, "Antigravity (Experimental)");
    assert.strictEqual(config.command, process.execPath);
    assert.strictEqual(config.args[0], "--no-warnings");
    assert.ok(
      config.args[1]?.replace(/\\/g, "/").endsWith("antigravity-acp/index.mjs")
    );
    assert.deepStrictEqual(config.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.strictEqual(config.availabilityCommand, "agy");
    assert.ok(
      ![config.command, ...config.args].some((part) =>
        part.toLowerCase().includes("bun")
      )
    );
    assert.ok(
      !config.args.some((arg) => arg.includes("--dangerously-skip-permissions"))
    );
  });
});
