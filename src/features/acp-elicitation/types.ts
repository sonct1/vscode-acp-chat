export const ACP_ELICITATION_OWNER_LEGACY = "legacy";
export const ACP_ELICITATION_PREFIX = "feature.acp-elicitation.";

export type ElicitationAction = "accept" | "decline" | "cancel";
export type ElicitationContentValue = string | number | boolean | string[];
export type ElicitationContent = Record<string, ElicitationContentValue>;
export type ElicitationFieldKind =
  "text" | "select" | "multiselect" | "number" | "boolean";

export interface ElicitationOptionView {
  value: string;
  label: string;
  description?: string;
}

export interface ElicitationFieldBaseView {
  key: string;
  kind: ElicitationFieldKind;
  label: string;
  description?: string;
  required: boolean;
}

export interface TextFieldView extends ElicitationFieldBaseView {
  kind: "text";
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  defaultValue?: string;
  multiline?: boolean;
}

export interface SingleSelectFieldView extends ElicitationFieldBaseView {
  kind: "select";
  options: ElicitationOptionView[];
  defaultValue?: string;
}

export interface MultiSelectFieldView extends ElicitationFieldBaseView {
  kind: "multiselect";
  options: ElicitationOptionView[];
  minItems?: number;
  maxItems?: number;
  defaultValue?: string[];
}

export interface NumberFieldView extends ElicitationFieldBaseView {
  kind: "number";
  integer: boolean;
  minimum?: number;
  maximum?: number;
  defaultValue?: number;
}

export interface BooleanFieldView extends ElicitationFieldBaseView {
  kind: "boolean";
  defaultValue?: boolean;
}

export type ElicitationFieldView =
  | TextFieldView
  | SingleSelectFieldView
  | MultiSelectFieldView
  | NumberFieldView
  | BooleanFieldView;

export interface ElicitationFormView {
  interactionId: string;
  ownerId: string;
  message: string;
  title?: string;
  description?: string;
  toolCallId?: string;
  fields: ElicitationFieldView[];
  createdAt: number;
}

export interface ElicitationOwnerState {
  ownerId: string;
  pendingElicitations: ElicitationFormView[];
}

export interface ElicitationShowMessage {
  type: "feature.acp-elicitation.show";
  ownerId: string;
  pendingElicitations: ElicitationFormView[];
}

export interface ElicitationRespondMessage {
  type: "feature.acp-elicitation.respond";
  ownerId: string;
  interactionId: string;
  action: ElicitationAction;
  content?: ElicitationContent;
}

export interface ElicitationValidationMessage {
  type: "feature.acp-elicitation.validation";
  ownerId: string;
  interactionId: string;
  errors: Record<string, string>;
}

export type ElicitationHostMessage = ElicitationRespondMessage;
export type ElicitationWebviewMessage =
  ElicitationShowMessage | ElicitationValidationMessage;

export const ELICITATION_LIMITS = {
  maxPendingPerOwner: 8,
  maxFields: 32,
  maxOptionsPerField: 100,
  maxMessageChars: 8_000,
  maxSchemaTextChars: 8_000,
  maxPropertyKeyChars: 256,
  maxOptionValueChars: 1_000,
  maxFieldLabelChars: 1_000,
  maxStringAnswerChars: 16_000,
  maxResponseBytes: 64 * 1024,
  maxNormalizedFormBytes: 128 * 1024,
} as const;

export interface ElicitationValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  content?: ElicitationContent;
}
