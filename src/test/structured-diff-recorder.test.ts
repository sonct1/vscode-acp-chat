import * as assert from "assert";
import * as path from "path";
import { DiffManager } from "../acp/diff-manager";
import { recordStructuredDiffsFromContent } from "../acp/structured-diff-recorder";

suite("StructuredDiffRecorder", () => {
  let diffManager: DiffManager;

  setup(() => {
    diffManager = new DiffManager();
  });

  teardown(() => {
    diffManager.dispose();
  });

  test("records a valid absolute path diff when disk content matches newText", async () => {
    const absolutePath = path.resolve("/tmp/project/src/example.ts");
    const count = await recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: absolutePath,
          oldText: "before",
          newText: "after",
        },
      ],
      {
        cwd: "/tmp/project",
        diffManager,
        readTextFile: async () => "after",
      }
    );

    assert.strictEqual(count, 1);
    assert.deepStrictEqual(diffManager.getPendingChanges(), [
      {
        path: absolutePath,
        oldText: "before",
        newText: "after",
        status: "pending",
      },
    ]);
  });

  test("resolves a valid relative path diff against cwd", async () => {
    const cwd = path.resolve("/tmp/project");
    const count = await recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "src/example.ts",
          oldText: "before",
          newText: "after",
        },
      ],
      {
        cwd,
        diffManager,
        readTextFile: async (filePath) => {
          assert.strictEqual(filePath, path.join(cwd, "src/example.ts"));
          return "after";
        },
      }
    );

    assert.strictEqual(count, 1);
    assert.strictEqual(
      diffManager.getPendingChanges()[0].path,
      path.join(cwd, "src/example.ts")
    );
  });

  test("records oldText null for newly created files when disk content matches", async () => {
    const count = await recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "new-file.ts",
          oldText: null,
          newText: "created\n",
        },
      ],
      {
        cwd: "/tmp/project",
        diffManager,
        readTextFile: async () => "created\n",
      }
    );

    assert.strictEqual(count, 1);
    assert.strictEqual(diffManager.getPendingChanges()[0].oldText, null);
  });

  test("skips valid diff when disk content does not match newText", async () => {
    const skipped: Array<{ path: string; reason: string }> = [];
    const count = await recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "stale.ts",
          oldText: "before",
          newText: "after",
        },
      ],
      {
        cwd: "/tmp/project",
        diffManager,
        readTextFile: async () => "user changed it",
        onDidSkip: (skippedPath, reason) =>
          skipped.push({ path: skippedPath, reason }),
      }
    );

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(diffManager.getPendingChanges(), []);
    assert.deepStrictEqual(skipped, [
      {
        path: path.join("/tmp/project", "stale.ts"),
        reason: "not-applied",
      },
    ]);
  });

  test("skips valid diff when file is missing on disk", async () => {
    const count = await recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "missing.ts",
          oldText: "before",
          newText: "after",
        },
      ],
      {
        cwd: "/tmp/project",
        diffManager,
        readTextFile: async () => null,
      }
    );

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(diffManager.getPendingChanges(), []);
  });

  test("skips oldText undefined instead of treating it as a new file", async () => {
    const count = await recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "existing.ts",
          newText: "after",
        },
      ],
      {
        cwd: "/tmp/project",
        diffManager,
        readTextFile: async () => {
          throw new Error("invalid diff should not read disk");
        },
      }
    );

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(diffManager.getPendingChanges(), []);
  });

  test("skips malformed and non-diff items", async () => {
    const count = await recordStructuredDiffsFromContent(
      [
        null,
        "not object",
        { type: "text", text: "hello" },
        { type: "diff", path: "", oldText: "before", newText: "after" },
        { type: "diff", path: "a.ts", oldText: "before" },
        { type: "diff", path: "b.ts", oldText: 1, newText: "after" },
      ],
      {
        cwd: "/tmp/project",
        diffManager,
        readTextFile: async () => {
          throw new Error("malformed diffs should not read disk");
        },
      }
    );

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(diffManager.getPendingChanges(), []);
  });

  test("returns zero for non-array content", async () => {
    const count = await recordStructuredDiffsFromContent(
      { type: "diff", path: "a.ts", oldText: "before", newText: "after" },
      { cwd: "/tmp/project", diffManager }
    );

    assert.strictEqual(count, 0);
  });

  test("calls onDidRecord only when DiffManager records or updates", async () => {
    const records: Array<{
      path: string;
      oldText: string | null;
      newText: string;
    }> = [];
    const content = [
      {
        type: "diff",
        path: "a.ts",
        oldText: "before",
        newText: "after",
      },
    ];
    const options = {
      cwd: "/tmp/project",
      diffManager,
      readTextFile: async () => "after",
      onDidRecord: (
        recordPath: string,
        oldText: string | null,
        newText: string
      ) => records.push({ path: recordPath, oldText, newText }),
    };

    assert.strictEqual(await recordStructuredDiffsFromContent(content, options), 1);
    assert.strictEqual(await recordStructuredDiffsFromContent(content, options), 0);
    assert.strictEqual(records.length, 1);
  });
});
