import type { MultiSessionListItem } from "./contracts";

export function compareSessionsByCreatedAt(
  a: MultiSessionListItem,
  b: MultiSessionListItem
): number {
  return b.createdAt - a.createdAt;
}
