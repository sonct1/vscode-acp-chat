import * as assert from "assert";
import { createGrokBuildAgentConfig } from "../../features/grok-build";

suite("features/grok-build", () => {
  test("creates exact built-in launch config", () => {
    const config = createGrokBuildAgentConfig();

    assert.strictEqual(config.id, "grok-build");
    assert.strictEqual(config.name, "Grok Build");
    assert.strictEqual(config.command, "grok");
    assert.deepStrictEqual(config.args, ["--no-auto-update", "agent", "stdio"]);
    assert.strictEqual(config.availabilityCommand, undefined);
    assert.strictEqual(config.env, undefined);
    assert.strictEqual(config.liveToolOutputProfile, undefined);
  });
});
