import type { WebviewController } from "../views/webview/main";
import { registerMultiSessionWebviewFeature } from "./multi-session/webview";

export interface RegisteredWebviewFeatures {
  multiSession: ReturnType<typeof registerMultiSessionWebviewFeature>;
}

export function registerWebviewFeatures(
  controller: WebviewController
): RegisteredWebviewFeatures {
  return {
    multiSession: registerMultiSessionWebviewFeature(controller),
  };
}
