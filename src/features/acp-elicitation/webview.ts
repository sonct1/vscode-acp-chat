import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage } from "../../views/webview/types";
import { ACP_ELICITATION_STYLES } from "./styles";
import type {
  ElicitationContent,
  ElicitationFieldView,
  ElicitationFormView,
  ElicitationWebviewMessage,
} from "./types";

const UNSET_SELECT_VALUE = "__acp_elicitation_unset__";

interface FieldHandle {
  field: ElicitationFieldView;
  element: HTMLElement;
  focusTarget: HTMLElement;
  error: HTMLElement;
  read: () => unknown;
}

export function registerAcpElicitationWebviewFeature(
  controller: WebviewController
) {
  return new AcpElicitationWebviewFeature(controller);
}

class AcpElicitationWebviewFeature {
  private readonly doc: Document;
  private readonly vscode: { postMessage(message: unknown): void };
  private readonly panel: HTMLElement;
  private current: ElicitationFormView | null = null;
  private handles: FieldHandle[] = [];
  private previousFocus: HTMLElement | null = null;
  private fieldSequence = 0;

  constructor(controller: WebviewController) {
    const context = controller.getContext();
    this.doc = context.doc;
    this.vscode = context.vscode;
    injectStyles(this.doc);
    this.panel = this.doc.createElement("section");
    this.panel.className = "acp-elicitation-panel";
    this.panel.setAttribute("aria-live", "polite");
    this.panel.setAttribute("aria-label", "Agent input request");
    const inputArea = this.doc.getElementById("chat-input-area");
    inputArea?.parentElement?.insertBefore(this.panel, inputArea);
  }

  handleMessage(message: ExtensionMessage): boolean {
    if (
      message.type !== "feature.acp-elicitation.show" &&
      message.type !== "feature.acp-elicitation.validation"
    ) {
      return false;
    }
    const msg = message as ElicitationWebviewMessage;
    if (msg.type === "feature.acp-elicitation.show") {
      const form = msg.pendingElicitations[0] ?? null;
      const queueCount = msg.pendingElicitations.length;
      if (form && this.current?.interactionId === form.interactionId) {
        this.current = form;
        this.updateQueueCount(queueCount);
      } else {
        this.render(form ? { ...form, queueCount } : null);
      }
      return true;
    }
    if (this.current?.interactionId === msg.interactionId) {
      this.applyErrors(msg.errors);
    }
    return true;
  }

  private render(
    form: (ElicitationFormView & { queueCount?: number }) | null
  ): void {
    const hadForm = Boolean(this.current);
    if (form && !this.current) {
      const activeElement = this.doc.activeElement;
      this.previousFocus = isHTMLElement(activeElement) ? activeElement : null;
    }
    this.current = form;
    this.handles = [];
    this.fieldSequence = 0;
    this.panel.replaceChildren();
    this.panel.classList.toggle("visible", Boolean(form));
    this.panel.onkeydown = form ? this.onKeyDown : null;
    if (!form) {
      if (hadForm) this.restoreFocus();
      return;
    }

    const header = this.doc.createElement("div");
    header.className = "acp-elicitation-header";
    if (form.title) {
      const title = this.doc.createElement("div");
      title.className = "acp-elicitation-title";
      title.textContent = form.title;
      header.appendChild(title);
    }
    const message = this.doc.createElement("div");
    message.className = "acp-elicitation-message";
    message.textContent = form.message;
    header.appendChild(message);
    if (form.description) {
      const description = this.doc.createElement("div");
      description.className = "acp-elicitation-description";
      description.textContent = form.description;
      header.appendChild(description);
    }
    const queue = this.doc.createElement("div");
    queue.className = "acp-elicitation-queue";
    queue.textContent = `1 of ${form.queueCount ?? 1}`;
    header.appendChild(queue);
    const summary = this.doc.createElement("div");
    summary.id = errorSummaryId(form);
    summary.className = "acp-elicitation-error-summary";
    summary.setAttribute("aria-live", "assertive");
    summary.setAttribute("role", "alert");
    header.appendChild(summary);
    this.panel.appendChild(header);

    for (const field of form.fields)
      this.panel.appendChild(this.renderField(field));

    const actions = this.doc.createElement("div");
    actions.className = "acp-elicitation-actions";
    actions.appendChild(this.button("Cancel", () => this.respond("cancel")));
    actions.appendChild(this.button("Decline", () => this.respond("decline")));
    actions.appendChild(this.button("Submit", () => this.submit()));
    this.panel.appendChild(actions);
    const focusable = this.panel.querySelector<HTMLElement>(
      "input, textarea, select, button"
    );
    focusable?.focus();
  }

  private updateQueueCount(queueCount: number): void {
    const queue = this.panel.querySelector<HTMLElement>(
      ".acp-elicitation-queue"
    );
    if (queue) queue.textContent = `1 of ${queueCount}`;
  }

  private renderField(field: ElicitationFieldView): HTMLElement {
    const wrapper = this.doc.createElement("div");
    wrapper.className = "acp-elicitation-field";
    const controlId = controlIdFor(
      this.current?.interactionId ?? "form",
      field.key,
      this.fieldSequence++
    );
    const descriptionId = `${controlId}-description`;
    const errorId = `${controlId}-error`;
    const label = this.doc.createElement("label");
    label.className = "acp-elicitation-label";
    label.textContent = `${field.label}${field.required ? " (required)" : ""}`;
    label.htmlFor = controlId;
    wrapper.appendChild(label);
    const describedBy: string[] = [];
    if (field.description) {
      const description = this.doc.createElement("div");
      description.id = descriptionId;
      description.className = "acp-elicitation-description";
      description.textContent = field.description;
      wrapper.appendChild(description);
      describedBy.push(descriptionId);
    }
    const error = this.doc.createElement("div");
    error.id = errorId;
    error.className = "acp-elicitation-error";
    error.setAttribute("role", "alert");
    describedBy.push(errorId);

    let control: HTMLElement;
    let focusTarget: HTMLElement;
    let read: () => unknown;
    if (field.kind === "text") {
      const input = field.multiline
        ? this.doc.createElement("textarea")
        : this.doc.createElement("input");
      if (input.tagName === "INPUT") {
        (input as HTMLInputElement).type = inputType(field.format);
      }
      input.id = controlId;
      input.setAttribute("aria-describedby", describedBy.join(" "));
      input.toggleAttribute("required", field.required);
      if (field.format === "date-time" && input.tagName === "INPUT") {
        (input as HTMLInputElement).step = "0.001";
      }
      input.value =
        field.format === "date-time" && field.defaultValue
          ? toDateTimeLocal(field.defaultValue)
          : (field.defaultValue ?? "");
      control = input;
      focusTarget = input;
      read = () =>
        field.format === "date-time" && input.value
          ? fromDateTimeLocal(input.value)
          : input.value;
    } else if (field.kind === "number") {
      const input = this.doc.createElement("input");
      input.id = controlId;
      input.type = "number";
      input.setAttribute("aria-describedby", describedBy.join(" "));
      if (field.minimum !== undefined) input.min = String(field.minimum);
      if (field.maximum !== undefined) input.max = String(field.maximum);
      if (field.integer) input.step = "1";
      input.value =
        field.defaultValue === undefined ? "" : String(field.defaultValue);
      control = input;
      focusTarget = input;
      read = () => (input.value === "" ? undefined : Number(input.value));
    } else if (field.kind === "boolean") {
      const select = this.doc.createElement("select");
      select.id = controlId;
      select.setAttribute("aria-describedby", describedBy.join(" "));
      const empty = this.doc.createElement("option");
      empty.value = UNSET_SELECT_VALUE;
      empty.textContent = "Unset";
      select.appendChild(empty);
      for (const [value, text] of [
        ["true", "True"],
        ["false", "False"],
      ] as const) {
        const option = this.doc.createElement("option");
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      }
      select.value =
        field.defaultValue === undefined
          ? UNSET_SELECT_VALUE
          : String(field.defaultValue);
      control = select;
      focusTarget = select;
      read = () =>
        select.value === UNSET_SELECT_VALUE
          ? undefined
          : select.value === "true";
    } else if (field.kind === "select") {
      if (field.options.length <= 6) {
        const group = this.doc.createElement("fieldset");
        group.id = controlId;
        group.className = "acp-elicitation-options";
        group.setAttribute("aria-describedby", describedBy.join(" "));
        const legend = this.doc.createElement("legend");
        legend.textContent = `${field.label}${field.required ? " (required)" : ""}`;
        group.appendChild(legend);
        for (const option of field.options) {
          const optionLabel = this.doc.createElement("label");
          optionLabel.className = "acp-elicitation-option";
          const input = this.doc.createElement("input");
          input.type = "radio";
          input.name = controlId;
          input.value = option.value;
          input.checked = field.defaultValue === option.value;
          const text = this.optionText(option);
          optionLabel.append(input, text);
          group.appendChild(optionLabel);
        }
        control = group;
        focusTarget = group.querySelector("input") ?? group;
        read = () =>
          group.querySelector<HTMLInputElement>("input:checked")?.value;
      } else {
        const select = this.doc.createElement("select");
        select.id = controlId;
        select.setAttribute("aria-describedby", describedBy.join(" "));
        const empty = this.doc.createElement("option");
        empty.textContent = "Select…";
        select.appendChild(empty);
        for (const option of field.options) {
          const item = this.doc.createElement("option");
          item.value = option.value;
          item.textContent = option.label;
          select.appendChild(item);
        }
        select.selectedIndex =
          field.defaultValue === undefined
            ? 0
            : Math.max(
                0,
                field.options.findIndex(
                  (option) => option.value === field.defaultValue
                ) + 1
              );
        const selectedDescription = this.doc.createElement("div");
        selectedDescription.className = "acp-elicitation-option-description";
        selectedDescription.id = `${controlId}-selected-description`;
        const updateDescription = (): void => {
          selectedDescription.textContent =
            field.options.find((option) => option.value === select.value)
              ?.description ?? "";
        };
        select.addEventListener("change", updateDescription);
        updateDescription();
        wrapper.appendChild(selectedDescription);
        select.setAttribute(
          "aria-describedby",
          [...describedBy, selectedDescription.id].join(" ")
        );
        control = select;
        focusTarget = select;
        read = () => (select.selectedIndex === 0 ? undefined : select.value);
      }
    } else {
      const group = this.doc.createElement("fieldset");
      group.id = controlId;
      group.className = "acp-elicitation-options";
      group.setAttribute("aria-describedby", describedBy.join(" "));
      const legend = this.doc.createElement("legend");
      legend.textContent = `${field.label}${field.required ? " (required)" : ""}`;
      group.appendChild(legend);
      const selected = new Set(field.defaultValue ?? []);
      for (const option of field.options) {
        const optionLabel = this.doc.createElement("label");
        optionLabel.className = "acp-elicitation-option";
        const input = this.doc.createElement("input");
        input.type = "checkbox";
        input.value = option.value;
        input.id = `${controlId}-${option.value}`;
        input.checked = selected.has(option.value);
        const text = this.optionText(option);
        optionLabel.append(input, text);
        group.appendChild(optionLabel);
      }
      control = group;
      focusTarget = group.querySelector("input") ?? group;
      read = () =>
        Array.from(
          group.querySelectorAll<HTMLInputElement>("input:checked")
        ).map((item) => item.value);
    }

    wrapper.appendChild(control);
    wrapper.appendChild(error);
    this.handles.push({ field, element: control, focusTarget, error, read });
    return wrapper;
  }

  private submit(): void {
    if (!this.current) return;
    const content: ElicitationContent = {};
    const errors: Record<string, string> = {};
    for (const handle of this.handles) {
      const value = handle.read();
      if (value === undefined) {
        if (handle.field.required)
          errors[handle.field.key] = "This field is required.";
        continue;
      }
      if (
        !handle.field.required &&
        (value === "" || (Array.isArray(value) && value.length === 0))
      ) {
        continue;
      }
      if (
        handle.field.kind === "number" &&
        typeof value === "number" &&
        !Number.isFinite(value)
      ) {
        errors[handle.field.key] = "Enter a number.";
        continue;
      }
      content[handle.field.key] =
        value as ElicitationContent[keyof ElicitationContent];
    }
    if (Object.keys(errors).length > 0) {
      this.applyErrors(errors);
      return;
    }
    this.respond("accept", content);
  }

  private respond(
    action: "accept" | "decline" | "cancel",
    content?: ElicitationContent
  ): void {
    if (!this.current) return;
    this.vscode.postMessage({
      type: "feature.acp-elicitation.respond",
      ownerId: this.current.ownerId,
      interactionId: this.current.interactionId,
      action,
      content,
    });
    this.restoreFocus();
  }

  private applyErrors(errors: Record<string, string>): void {
    const summary = this.current
      ? this.doc.getElementById(errorSummaryId(this.current))
      : null;
    const summaryMessages: string[] = [];
    if (errors._form) summaryMessages.push(errors._form);
    for (const handle of this.handles) {
      const message = errors[handle.field.key] ?? "";
      handle.error.textContent = message;
      handle.element.setAttribute("aria-invalid", message ? "true" : "false");
      if (message) summaryMessages.push(`${handle.field.label}: ${message}`);
    }
    if (summary) summary.textContent = summaryMessages.join(" ");
    const first = this.handles.find((handle) => errors[handle.field.key]);
    (first?.focusTarget ?? (isHTMLElement(summary) ? summary : null))?.focus();
  }

  private optionText(option: {
    label: string;
    description?: string;
  }): HTMLElement {
    const content = this.doc.createElement("span");
    content.className = "acp-elicitation-option-content";
    const label = this.doc.createElement("span");
    label.textContent = option.label;
    content.appendChild(label);
    if (option.description) {
      const description = this.doc.createElement("span");
      description.className = "acp-elicitation-option-description";
      description.textContent = option.description;
      content.appendChild(description);
    }
    return content;
  }

  private restoreFocus(): void {
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous?.isConnected) {
      previous.focus();
      return;
    }
    this.doc.getElementById("input")?.focus();
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.respond("cancel");
    }
  };
}

function isHTMLElement(value: Element | null): value is HTMLElement {
  const view = value?.ownerDocument.defaultView;
  return Boolean(value && view && value instanceof view.HTMLElement);
}

function inputType(format: string | undefined): string {
  if (format === "email") return "email";
  if (format === "uri") return "url";
  if (format === "date") return "date";
  if (format === "date-time") return "datetime-local";
  return "text";
}

function controlIdFor(
  interactionId: string,
  key: string,
  fieldIndex: number
): string {
  return `acp-elicitation-${cssSafe(interactionId)}-${fieldIndex}-${cssSafe(key)}`;
}

function errorSummaryId(form: ElicitationFormView): string {
  return `acp-elicitation-${cssSafe(form.interactionId)}-errors`;
}

function cssSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs)
    .toISOString()
    .replace(/Z$/, "")
    .replace(/\.000$/, "");
}

function fromDateTimeLocal(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function injectStyles(doc: Document): void {
  if (doc.getElementById("acp-elicitation-styles")) return;
  const style = doc.createElement("style");
  style.id = "acp-elicitation-styles";
  style.textContent = ACP_ELICITATION_STYLES;
  doc.head.appendChild(style);
}
