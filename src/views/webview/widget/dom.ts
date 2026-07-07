/**
 * Small DOM lookup helper for webview widgets/components.
 *
 * Centralizing this keeps component constructors focused on their ownership
 * boundary instead of repeating non-null assertions for every id lookup.
 */
export function getRequiredElement<T extends HTMLElement = HTMLElement>(
  doc: Document,
  id: string
): T {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Missing required webview element: #${id}`);
  }
  return element as T;
}
