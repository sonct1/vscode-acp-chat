import assert from "node:assert/strict";
import test from "node:test";
import { fileUriToFsPath } from "../src/updates/file-uri.js";
import { fsPath } from "../src/updates/utils.js";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: platform });
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
}

test("fileUriToFsPath decodes POSIX file URI", () => {
  assert.equal(
    withPlatform("linux", () =>
      fileUriToFsPath("file:///tmp/workspace/a%20b.ts")
    ),
    "/tmp/workspace/a b.ts"
  );
});

test("fileUriToFsPath decodes Windows drive file URI", () => {
  assert.equal(
    withPlatform("win32", () =>
      fileUriToFsPath("file:///C:/Users/me/workspace/a%20b.ts")
    ),
    String.raw`C:\Users\me\workspace\a b.ts`
  );
});

test("fileUriToFsPath decodes Windows UNC file URI", () => {
  assert.equal(
    withPlatform("win32", () =>
      fileUriToFsPath("file://server/share/a%20b.ts")
    ),
    String.raw`\\server\share\a b.ts`
  );
});

test("fsPath uses native file URI decoding", () => {
  assert.equal(
    withPlatform("win32", () =>
      fsPath("file:///C:/Users/me/workspace/a%20b.ts")
    ),
    String.raw`C:\Users\me\workspace\a b.ts`
  );
});
