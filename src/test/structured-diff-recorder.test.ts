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

  test("records a valid absolute path diff", () => {
    const absolutePath = path.resolve("/tmp/project/src/example.ts");
    const count = recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: absolutePath,
          oldText: "before",
          newText: "after",
        },
      ],
      { cwd: "/tmp/project", diffManager }
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

  test("resolves a valid relative path diff against cwd", () => {
    const cwd = path.resolve("/tmp/project");
    const count = recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "src/example.ts",
          oldText: "before",
          newText: "after",
        },
      ],
      { cwd, diffManager }
    );

    assert.strictEqual(count, 1);
    assert.strictEqual(
      diffManager.getPendingChanges()[0].path,
      path.join(cwd, "src/example.ts")
    );
  });

  test("records oldText null for newly created files", () => {
    const count = recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "new-file.ts",
          oldText: null,
          newText: "created\n",
        },
      ],
      { cwd: "/tmp/project", diffManager }
    );

    assert.strictEqual(count, 1);
    assert.strictEqual(diffManager.getPendingChanges()[0].oldText, null);
  });

  test("skips oldText undefined instead of treating it as a new file", () => {
    const count = recordStructuredDiffsFromContent(
      [
        {
          type: "diff",
          path: "existing.ts",
          newText: "after",
        },
      ],
      { cwd: "/tmp/project", diffManager }
    );

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(diffManager.getPendingChanges(), []);
  });

  test("skips malformed and non-diff items", () => {
    const count = recordStructuredDiffsFromContent(
      [
        null,
        "not object",
        { type: "text", text: "hello" },
        { type: "diff", path: "", oldText: "before", newText: "after" },
        { type: "diff", path: "a.ts", oldText: "before" },
        { type: "diff", path: "b.ts", oldText: 1, newText: "after" },
      ],
      { cwd: "/tmp/project", diffManager }
    );

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(diffManager.getPendingChanges(), []);
  });

  test("returns zero for non-array content", () => {
    const count = recordStructuredDiffsFromContent(
      { type: "diff", path: "a.ts", oldText: "before", newText: "after" },
      { cwd: "/tmp/project", diffManager }
    );

    assert.strictEqual(count, 0);
  });

  test("calls onDidRecord only when DiffManager records or updates", () => {
    const records: Array<{ path: string; oldText: string | null; newText: string }> = [];
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
      onDidRecord: (recordPath: string, oldText: string | null, newText: string) =>
        records.push({ path: recordPath, oldText, newText }),
    };

    assert.strictEqual(recordStructuredDiffsFromContent(content, options), 1);
    assert.strictEqual(recordStructuredDiffsFromContent(content, options), 0);
    assert.strictEqual(records.length, 1);
  });
});
