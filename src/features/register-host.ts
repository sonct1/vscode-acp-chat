import * as vscode from "vscode";
import { MultiSessionHostController } from "./multi-session/host";

export interface HostFeatureRegistry {
  multiSession?: MultiSessionHostController;
}

export function registerHostFeatures(options: {
  globalState: vscode.Memento;
  postMessage: (message: Record<string, unknown>) => void;
  onStatusChanged?: (summary: string) => void;
}): HostFeatureRegistry {
  if (!MultiSessionHostController.isEnabled()) {
    return {};
  }
  return {
    multiSession: new MultiSessionHostController({
      globalState: options.globalState,
      postMessage: options.postMessage,
      onStatusChanged: options.onStatusChanged,
    }),
  };
}
