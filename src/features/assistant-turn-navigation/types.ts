export type AssistantTurnNavigationDirection = "previous" | "next";

export interface AssistantTurnEntry {
  element: HTMLElement;
  scrollTarget: HTMLElement;
  index: number;
  label: string;
}
