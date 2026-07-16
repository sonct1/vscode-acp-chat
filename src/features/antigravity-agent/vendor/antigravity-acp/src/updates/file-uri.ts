import { fileURLToPath } from "node:url";

export function fileUriToFsPath(uri: string): string {
  return fileURLToPath(new URL(uri), { windows: process.platform === "win32" });
}
