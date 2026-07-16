import * as assert from "assert";
import * as vscode from "vscode";
import {
  createOldContentUri,
  oldContentUriToFsPath,
} from "../acp/diff-content-uri";

suite("diff content URI", () => {
  test("round-trips POSIX file paths", () => {
    const filePath = "/tmp/workspace/src/file with space.ts";
    const uri = createOldContentUri(filePath);

    assert.strictEqual(oldContentUriToFsPath(uri), filePath);
  });

  test("round-trips Windows drive paths without uri.path conversion", () => {
    const filePath = String.raw`C:\Users\me\workspace\src\file with space.ts`;
    const uri = createOldContentUri(filePath);

    assert.strictEqual(oldContentUriToFsPath(uri), filePath);
  });

  test("round-trips Windows UNC paths without uri.path conversion", () => {
    const filePath = String.raw`\\server\share\workspace\src\file.ts`;
    const uri = createOldContentUri(filePath);

    assert.strictEqual(oldContentUriToFsPath(uri), filePath);
  });

  test("preserves additional query parameters", () => {
    const filePath = String.raw`C:\Users\me\workspace\src\file.ts`;
    const uri = createOldContentUri(filePath, { localSessionId: "local 1" });
    const query = new URLSearchParams(uri.query);

    assert.strictEqual(query.get("filePath"), filePath);
    assert.strictEqual(query.get("localSessionId"), "local 1");
  });

  test("falls back to uri.fsPath for legacy old-content URIs", () => {
    const legacyUri = vscode.Uri.file("/tmp/legacy.ts").with({
      scheme: "acp-old-content",
    });

    assert.strictEqual(oldContentUriToFsPath(legacyUri), legacyUri.fsPath);
  });
});
