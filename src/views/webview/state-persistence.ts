import type { VsCodeApi, WebviewState } from "./types";

const DEBOUNCE_MS = 100;

/**
 * Manages webview persisted state via the VS Code state API.
 *
 * Provides debounced writes so rapid sequences of state changes (e.g.
 * during streaming) do not each trigger a `setState` call. Components
 * should call {@link update} for granular field changes or {@link save}
 * to replace the entire snapshot.
 */
export class StatePersistenceService {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cached: WebviewState | undefined;

  constructor(private vscode: VsCodeApi) {}

  /**
   * Restore the previously persisted state (if any).
   * Results are cached so repeated calls are cheap.
   */
  restore(): WebviewState | undefined {
    if (this.cached === undefined) {
      this.cached = this.vscode.getState<WebviewState>();
    }
    return this.cached;
  }

  /**
   * Replace the entire persisted state and schedule a debounced write.
   */
  save(state: WebviewState): void {
    this.cached = state;
    this.scheduleWrite();
  }

  /**
   * Update a single field of the persisted state.
   * Merges with the existing snapshot.
   */
  update<K extends keyof WebviewState>(key: K, value: WebviewState[K]): void {
    // Fallback to getState() so we merge into the existing snapshot rather
    // than clobbering it when update() is called before restore().
    const current =
      this.cached ??
      this.vscode.getState<WebviewState>() ??
      ({} as WebviewState);
    (current as unknown as Record<string, unknown>)[key] = value;
    this.cached = current;
    this.scheduleWrite();
  }

  /**
   * Immediately flush any pending debounced write.
   */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.writeToHost();
  }

  private scheduleWrite(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.writeToHost();
    }, DEBOUNCE_MS);
  }

  private writeToHost(): void {
    if (this.cached !== undefined) {
      this.vscode.setState<WebviewState>(this.cached);
    }
  }
}
