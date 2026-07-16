import {
  CreateElicitationRequest,
  ElicitationPropertySchema,
  MultiSelectItems,
  type CreateElicitationRequest as CreateElicitationRequestType,
} from "@agentclientprotocol/sdk";
import {
  ELICITATION_LIMITS,
  type ElicitationContent,
  type ElicitationFieldView,
  type ElicitationFormView,
  type ElicitationValidationResult,
} from "./types";

function narrowFormRequest(value: CreateElicitationRequestType) {
  return CreateElicitationRequest.isForm(value) ? value : null;
}

export interface CompileElicitationOptions {
  interactionId: string;
  ownerId: string;
  createdAt: number;
}

export interface NormalizedElicitationForm {
  view: ElicitationFormView;
}

export class ElicitationSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElicitationSchemaError";
  }
}

export function compileElicitationForm(
  params: CreateElicitationRequestType,
  options: CompileElicitationOptions
): NormalizedElicitationForm {
  const form = narrowFormRequest(params);
  if (!form) throw new ElicitationSchemaError("Unsupported elicitation mode");
  validateTextLimit(
    form.message,
    ELICITATION_LIMITS.maxMessageChars,
    "Elicitation message is too large"
  );

  const schema = form.requestedSchema;
  if (schema.type !== undefined && schema.type !== "object") {
    throw new ElicitationSchemaError("Elicitation schema must be an object");
  }
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);
  if (entries.length > ELICITATION_LIMITS.maxFields) {
    throw new ElicitationSchemaError("Elicitation schema has too many fields");
  }
  const required = new Set(schema.required ?? []);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      throw new ElicitationSchemaError("Required field is not declared");
    }
  }

  const fields = entries.map(([key, property]) =>
    compileField(key, property, required.has(key))
  );

  const view: ElicitationFormView = {
    interactionId: options.interactionId,
    ownerId: options.ownerId,
    message: form.message,
    title: cleanText(schema.title),
    description: cleanText(schema.description),
    toolCallId:
      "toolCallId" in form ? (form.toolCallId ?? undefined) : undefined,
    fields,
    createdAt: options.createdAt,
  };
  const bytes = Buffer.byteLength(JSON.stringify(view), "utf8");
  if (bytes > ELICITATION_LIMITS.maxNormalizedFormBytes) {
    throw new ElicitationSchemaError("Elicitation form is too large");
  }
  return { view };
}

function compileField(
  key: string,
  property: ElicitationPropertySchema,
  required: boolean
): ElicitationFieldView {
  validateTextLimit(
    key,
    ELICITATION_LIMITS.maxPropertyKeyChars,
    "Property key is too large"
  );
  if (
    !ElicitationPropertySchema.isString(property) &&
    "pattern" in property &&
    property.pattern
  ) {
    throw new ElicitationSchemaError("Pattern constraints are not supported");
  }
  if (ElicitationPropertySchema.isString(property)) {
    if (property.pattern) {
      throw new ElicitationSchemaError("Pattern constraints are not supported");
    }
    if (property.enum && property.oneOf) {
      throw new ElicitationSchemaError(
        "String field cannot combine enum and oneOf"
      );
    }
    validateRange(
      property.minLength,
      property.maxLength,
      "Invalid string length range"
    );
    if (property.enum || property.oneOf) {
      const options = optionsFromStringProperty(property.enum, property.oneOf);
      for (const option of options) {
        const optionError = validateStringValue(
          key,
          option.value,
          property,
          required
        );
        if (optionError) throw new ElicitationSchemaError(optionError);
      }
      validateDefaultString(
        property.default,
        options.map((o) => o.value)
      );
      return {
        key,
        kind: "select",
        label: labelFor(key, property.title),
        description: cleanText(property.description),
        required,
        options,
        defaultValue: property.default ?? undefined,
      };
    }
    if (property.default !== undefined && property.default !== null) {
      const defaultError = validateStringValue(
        key,
        property.default,
        property,
        required
      );
      if (defaultError) throw new ElicitationSchemaError(defaultError);
    }
    return {
      key,
      kind: "text",
      label: labelFor(key, property.title),
      description: cleanText(property.description),
      required,
      format: property.format ?? undefined,
      minLength: property.minLength ?? undefined,
      maxLength: property.maxLength ?? undefined,
      defaultValue: property.default ?? undefined,
      multiline: !property.format,
    };
  }
  if (
    ElicitationPropertySchema.isNumber(property) ||
    ElicitationPropertySchema.isInteger(property)
  ) {
    validateRange(property.minimum, property.maximum, "Invalid numeric range");
    if (property.default !== undefined && property.default !== null) {
      const defaultError = validateNumberValue(
        key,
        property.default,
        property,
        ElicitationPropertySchema.isInteger(property),
        required
      );
      if (defaultError) throw new ElicitationSchemaError(defaultError);
    }
    return {
      key,
      kind: "number",
      label: labelFor(key, property.title),
      description: cleanText(property.description),
      required,
      integer: ElicitationPropertySchema.isInteger(property),
      minimum: property.minimum ?? undefined,
      maximum: property.maximum ?? undefined,
      defaultValue: property.default ?? undefined,
    };
  }
  if (ElicitationPropertySchema.isBoolean(property)) {
    return {
      key,
      kind: "boolean",
      label: labelFor(key, property.title),
      description: cleanText(property.description),
      required,
      defaultValue: property.default ?? undefined,
    };
  }
  if (ElicitationPropertySchema.isArray(property)) {
    validateRange(
      property.minItems,
      property.maxItems,
      "Invalid selection count range"
    );
    const options = optionsFromMultiSelectItems(property.items);
    const allowed = options.map((o) => o.value);
    if (property.default !== undefined && property.default !== null) {
      validateDefaultMultiSelect(
        property.default,
        allowed,
        property.minItems,
        property.maxItems
      );
    }
    return {
      key,
      kind: "multiselect",
      label: labelFor(key, property.title),
      description: cleanText(property.description),
      required,
      options,
      minItems: property.minItems ?? undefined,
      maxItems: property.maxItems ?? undefined,
      defaultValue: property.default ?? undefined,
    };
  }
  throw new ElicitationSchemaError("Unsupported field type");
}

function optionsFromStringProperty(
  enumValues?: string[] | null,
  oneOf?: Array<{
    const: string;
    title: string;
    description?: string | null;
  }> | null
) {
  const options = oneOf
    ? oneOf.map((item) => ({
        value: item.const,
        label: boundedOptionText(item.title || item.const),
        description: cleanText(item.description),
      }))
    : (enumValues ?? []).map((value) => ({
        value,
        label: boundedOptionText(value),
      }));
  validateOptions(options.map((option) => option.value));
  return options;
}

function optionsFromMultiSelectItems(items: MultiSelectItems) {
  if (MultiSelectItems.isString(items)) {
    const values = items.enum;
    validateOptions(values);
    return values.map((value) => ({ value, label: boundedOptionText(value) }));
  }
  if (MultiSelectItems.isTitled(items)) {
    const options = items.anyOf.map((item) => ({
      value: item.const,
      label: boundedOptionText(item.title || item.const),
      description: cleanText(item.description),
    }));
    validateOptions(options.map((option) => option.value));
    return options;
  }
  throw new ElicitationSchemaError("Unsupported multi-select items");
}

function validateOptions(values: string[]): void {
  if (
    values.length === 0 ||
    values.length > ELICITATION_LIMITS.maxOptionsPerField
  ) {
    throw new ElicitationSchemaError("Invalid option count");
  }
  const seen = new Set<string>();
  for (const value of values) {
    validateTextLimit(
      value,
      ELICITATION_LIMITS.maxOptionValueChars,
      "Option value is too large"
    );
    if (seen.has(value))
      throw new ElicitationSchemaError("Duplicate option value");
    seen.add(value);
  }
}

function validateDefaultMultiSelect(
  defaultValue: string[],
  allowed: string[],
  minItems?: number | null,
  maxItems?: number | null
): void {
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  for (const value of defaultValue) {
    if (!allowedSet.has(value))
      throw new ElicitationSchemaError(
        "Default multi-select value is not allowed"
      );
    if (seen.has(value))
      throw new ElicitationSchemaError(
        "Default multi-select value is duplicated"
      );
    seen.add(value);
  }
  if (
    minItems !== undefined &&
    minItems !== null &&
    defaultValue.length < minItems
  ) {
    throw new ElicitationSchemaError(
      "Default multi-select value has too few items"
    );
  }
  if (
    maxItems !== undefined &&
    maxItems !== null &&
    defaultValue.length > maxItems
  ) {
    throw new ElicitationSchemaError(
      "Default multi-select value has too many items"
    );
  }
}

function validateDefaultString(
  defaultValue: string | null | undefined,
  allowed: string[]
): void {
  if (
    defaultValue !== undefined &&
    defaultValue !== null &&
    !allowed.includes(defaultValue)
  ) {
    throw new ElicitationSchemaError("Default select value is not allowed");
  }
}

function validateRange(
  min: number | null | undefined,
  max: number | null | undefined,
  message: string
): void {
  if (
    min !== undefined &&
    min !== null &&
    max !== undefined &&
    max !== null &&
    min > max
  ) {
    throw new ElicitationSchemaError(message);
  }
}

function labelFor(key: string, title?: string | null): string {
  const label = title?.trim() || key;
  validateTextLimit(
    label,
    ELICITATION_LIMITS.maxFieldLabelChars,
    "Field label is too large"
  );
  return label;
}

function cleanText(value?: string | null): string | undefined {
  if (!value) return undefined;
  validateTextLimit(
    value,
    ELICITATION_LIMITS.maxSchemaTextChars,
    "Schema text is too large"
  );
  return value;
}

function boundedOptionText(value: string): string {
  validateTextLimit(
    value,
    ELICITATION_LIMITS.maxFieldLabelChars,
    "Option text is too large"
  );
  return value;
}

function validateTextLimit(
  value: string,
  limit: number,
  message: string
): void {
  if (value.length > limit) throw new ElicitationSchemaError(message);
}

export function validateElicitationContent(
  form: NormalizedElicitationForm,
  content: ElicitationContent | undefined
): ElicitationValidationResult {
  const errors: Record<string, string> = {};
  const normalized: ElicitationContent = {};
  const source = content ?? {};
  const fields = new Map(form.view.fields.map((field) => [field.key, field]));

  for (const key of Object.keys(source)) {
    if (!fields.has(key)) errors[key] = "Unknown field.";
  }

  for (const field of form.view.fields) {
    const present = Object.prototype.hasOwnProperty.call(source, field.key);
    const value = source[field.key];
    if (!present) {
      if (field.required) errors[field.key] = "This field is required.";
      continue;
    }
    if (field.kind === "text") {
      if (typeof value !== "string") {
        errors[field.key] = "Enter text.";
      } else {
        const error = validateStringValue(
          field.key,
          value,
          field,
          field.required
        );
        if (error) errors[field.key] = error;
        else normalized[field.key] = value;
      }
    } else if (field.kind === "select") {
      if (
        typeof value !== "string" ||
        !field.options.some((option) => option.value === value)
      ) {
        errors[field.key] = "Choose a valid option.";
      } else normalized[field.key] = value;
    } else if (field.kind === "multiselect") {
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      ) {
        errors[field.key] = "Choose valid options.";
      } else {
        const allowed = new Set(field.options.map((option) => option.value));
        const unique = Array.from(new Set(value));
        if (
          unique.length !== value.length ||
          unique.some((item) => !allowed.has(item))
        ) {
          errors[field.key] = "Choose valid options.";
        } else if (
          field.minItems !== undefined &&
          value.length < field.minItems
        ) {
          errors[field.key] = `Choose at least ${field.minItems} option(s).`;
        } else if (
          field.maxItems !== undefined &&
          value.length > field.maxItems
        ) {
          errors[field.key] = `Choose at most ${field.maxItems} option(s).`;
        } else normalized[field.key] = value;
      }
    } else if (field.kind === "number") {
      if (typeof value !== "number") {
        errors[field.key] = "Enter a number.";
      } else {
        const error = validateNumberValue(
          field.key,
          value,
          field,
          field.integer,
          field.required
        );
        if (error) errors[field.key] = error;
        else normalized[field.key] = value;
      }
    } else if (field.kind === "boolean") {
      if (typeof value !== "boolean")
        errors[field.key] = "Choose true or false.";
      else normalized[field.key] = value;
    }
  }

  if (Object.keys(errors).length === 0) {
    const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
    if (bytes > ELICITATION_LIMITS.maxResponseBytes) {
      errors._form = "Response is too large.";
    }
  }
  return { ok: Object.keys(errors).length === 0, errors, content: normalized };
}

function validateStringValue(
  _key: string,
  value: string,
  field: {
    minLength?: number | null;
    maxLength?: number | null;
    format?: string | null;
  },
  _required: boolean
): string | undefined {
  if (value.length > ELICITATION_LIMITS.maxStringAnswerChars)
    return "Text is too long.";
  if (
    field.minLength !== undefined &&
    field.minLength !== null &&
    value.length < field.minLength
  ) {
    return `Enter at least ${field.minLength} character(s).`;
  }
  if (
    field.maxLength !== undefined &&
    field.maxLength !== null &&
    value.length > field.maxLength
  ) {
    return `Enter at most ${field.maxLength} character(s).`;
  }
  if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return "Enter a valid email address.";
  if (field.format === "uri") {
    try {
      new URL(value);
    } catch {
      return "Enter a valid URI.";
    }
  }
  if (field.format === "date" && !isStrictDate(value))
    return "Enter a valid date.";
  if (field.format === "date-time" && !isRfc3339DateTime(value))
    return "Enter a valid date and time.";
  return undefined;
}

function isStrictDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRfc3339DateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isStrictDate(`${match[1]}-${match[2]}-${match[3]}`)
  ) {
    return false;
  }

  const offsetHour = match[10] ? Number(match[10]) : 0;
  const offsetMinute = match[11] ? Number(match[11]) : 0;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  const fractionMs = Number(`0.${match[7] ?? "0"}`) * 1_000;
  const offsetMinutes =
    match[8] === "Z"
      ? 0
      : (match[9] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, fractionMs);
  return !Number.isNaN(utc - offsetMinutes * 60_000);
}

function validateNumberValue(
  _key: string,
  value: number,
  field: { minimum?: number | null; maximum?: number | null },
  integer: boolean,
  _required: boolean
): string | undefined {
  if (!Number.isFinite(value)) return "Enter a finite number.";
  if (integer && !Number.isSafeInteger(value)) return "Enter a whole number.";
  if (
    field.minimum !== undefined &&
    field.minimum !== null &&
    value < field.minimum
  ) {
    return `Enter a value greater than or equal to ${field.minimum}.`;
  }
  if (
    field.maximum !== undefined &&
    field.maximum !== null &&
    value > field.maximum
  ) {
    return `Enter a value less than or equal to ${field.maximum}.`;
  }
  return undefined;
}
