/**
 * Type-safe synchronous event bus for intra-webview communication.
 *
 * Components emit events through the shared {@link EventBus} instance on the
 * {@link WebviewContext} instead of reaching into sibling components directly.
 * All handlers are invoked synchronously in registration order when `emit()`
 * is called.
 *
 * @template TEvents A map of event-name → payload type. Define new events
 *                   by extending {@link WebviewEventMap} in `types.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventBus<TEvents extends Record<string, any>> {
  private listeners = new Map<
    keyof TEvents,
    Set<(payload: TEvents[keyof TEvents]) => void>
  >();

  /**
   * Subscribe to an event.
   * The same handler reference will only be added once per event.
   */
  on<K extends keyof TEvents>(
    event: K,
    handler: (payload: TEvents[K]) => void
  ): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: TEvents[keyof TEvents]) => void);
  }

  /**
   * Unsubscribe a previously registered handler.
   */
  off<K extends keyof TEvents>(
    event: K,
    handler: (payload: TEvents[K]) => void
  ): void {
    this.listeners
      .get(event)
      ?.delete(handler as (payload: TEvents[keyof TEvents]) => void);
  }

  /**
   * Synchronously dispatch an event to all registered handlers.
   * Handlers are called in registration order.
   */
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(payload);
    }
  }
}
