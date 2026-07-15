import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE,
  SUPPORTED_EXTERNAL_PROTOCOLS,
  type OpenExternalResourceLinkMessage,
} from "./types";

export function expandHomeResourcePath(pathText: string): string {
  if (pathText === "~") return os.homedir();
  if (/^~[\\/]/.test(pathText)) {
    return path.join(os.homedir(), pathText.slice(2));
  }
  return pathText;
}

export class ClickableResourceLinksHostController {
  async handleMessage(message: { type?: string; url?: unknown }): Promise<boolean> {
    if (message.type !== OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE) return false;
    if (typeof message.url !== "string") return true;

    await this.openExternal(message.url);
    return true;
  }

  async openExternal(urlText: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(urlText);
    } catch {
      console.error("[ClickableResourceLinks] Invalid external URL");
      return false;
    }

    if (!(SUPPORTED_EXTERNAL_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
      console.warn(
        `[ClickableResourceLinks] Rejected unsupported URL protocol: ${parsed.protocol}`
      );
      return false;
    }

    try {
      await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
      return true;
    } catch (error) {
      console.error("[ClickableResourceLinks] Failed to open external URL:", error);
      vscode.window.showErrorMessage("Unable to open external link");
      return false;
    }
  }
}

export function isOpenExternalResourceLinkMessage(
  message: { type?: string; url?: unknown }
): message is OpenExternalResourceLinkMessage {
  return (
    message.type === OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE &&
    typeof message.url === "string"
  );
}

export function registerClickableResourceLinksHostFeature(): ClickableResourceLinksHostController {
  return new ClickableResourceLinksHostController();
}
