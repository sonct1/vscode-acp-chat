export interface PermissionOptionView {
  optionId: string;
  kind: string;
  name: string;
}

export interface PermissionToolCallView {
  kind?: string;
  title?: string;
  description?: string;
}

export interface PermissionView {
  requestId: string;
  toolCallId?: string;
  toolCall: PermissionToolCallView;
  options: PermissionOptionView[];
}

export interface PermissionUiStateMessage {
  type: "feature.permission-ui.state";
  ownerId: string;
  activationRevision?: number;
  stateRevision?: number;
  pending: PermissionView[];
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };
