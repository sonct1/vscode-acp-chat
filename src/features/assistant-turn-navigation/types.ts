export type AssistantTurnNavigationDirection = "previous" | "next";

export interface AssistantTurnEntry {
  element: HTMLElement;
  index: number;
  label: string;
}
