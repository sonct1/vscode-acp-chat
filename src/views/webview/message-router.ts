import type { ExtensionMessage } from "./types";

/**
 * Any component that reacts to extension → webview messages implements this
 * interface and registers itself with the {@link MessageRouter}.
 */
export interface MessageHandler {
  handleMessage(
    msg: ExtensionMessage
  ): boolean | void | Promise<boolean | void>;
}

/**
 * Registry of message handlers. Components register for the message types
 * they care about; the controller iterates registered handlers via
 * {@link getHandlers} and drives execution order itself.
 *
 * Ordering is NOT owned by the router — the controller's
 * `incomingNotifier` (an {@link AsyncSerialQueue}) serialises incoming
 * messages before they reach the handlers.
 */
export class MessageRouter {
  private handlers = new Map<string, MessageHandler[]>();

  /**
   * Register a handler for a single message type.
   */
  register(messageType: string, handler: MessageHandler): void {
    const list = this.handlers.get(messageType);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(messageType, [handler]);
    }
  }

  /**
   * Register a handler for multiple message types at once.
   */
  registerMany(types: string[], handler: MessageHandler): void {
    for (const type of types) {
      this.register(type, handler);
    }
  }

  /**
   * Return the handlers registered for a given message type.
   * The controller iterates these directly, providing its own
   * serialisation and error handling.
   */
  getHandlers(messageType: string): MessageHandler[] {
    return this.handlers.get(messageType) ?? [];
  }
}
