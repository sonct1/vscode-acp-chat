import * as assert from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearBinPathCaches, isCommandAvailable } from "../utils/bin-paths";

suite("bin path command availability cache", () => {
  setup(() => {
    clearBinPathCaches();
  });

  teardown(() => {
    clearBinPathCaches();
  });

  test("caches availability until force refresh", () => {
    const root = mkdtempSync(join(tmpdir(), "vscode-acp-bin-cache-"));
    const commandPath = join(root, "agent-command");
    writeFileSync(commandPath, "#!/usr/bin/env sh\n", "utf8");

    assert.strictEqual(isCommandAvailable(commandPath), true);

    rmSync(commandPath, { force: true });
    assert.strictEqual(isCommandAvailable(commandPath), true);
    assert.strictEqual(
      isCommandAvailable(commandPath, { forceRefresh: true }),
      false
    );
  });

  test("clearBinPathCaches invalidates cached command availability", () => {
    const root = mkdtempSync(join(tmpdir(), "vscode-acp-bin-clear-"));
    const commandPath = join(root, "agent-command");
    writeFileSync(commandPath, "#!/usr/bin/env sh\n", "utf8");

    assert.strictEqual(isCommandAvailable(commandPath), true);

    rmSync(commandPath, { force: true });
    clearBinPathCaches();

    assert.strictEqual(isCommandAvailable(commandPath), false);
  });
});
