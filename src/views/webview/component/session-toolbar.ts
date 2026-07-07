import { updateContextUsageRing } from "../widget/context-usage";
import { Dropdown } from "../widget/dropdown";
import type {
  DropdownOption,
  ExtensionMessage,
  SessionToolbarElements,
  VsCodeApi,
} from "../types";
import { getRequiredElement } from "../widget/dom";

function cssEscapeAttr(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/**
 * Maps ACP `SessionConfigOptionCategory` values to codicon class names used
 * in the dropdown trigger.
 */
const CATEGORY_ICONS: Record<string, string> = {
  thought_level: "codicon-lightbulb",
};

/**
 * Owns the session option strip: mode/model pickers, generic ACP config
 * options, and context usage. It translates extension metadata into Dropdown
 * widget state and posts selection changes back through the VS Code bridge.
 */
export class SessionToolbarComponent {
  readonly elements: SessionToolbarElements;
  private doc: Document;
  private vscode?: VsCodeApi;
  private modeDropdown?: Dropdown;
  private modelDropdown?: Dropdown;
  private configOptionDropdowns = new Map<string, Dropdown>();
  private starredModels = new Set<string>();
  private lastModelsMsg: ExtensionMessage["models"] = null;

  constructor(
    doc: Document,
    options?: {
      elements?: SessionToolbarElements;
      vscode?: VsCodeApi;
    }
  ) {
    this.doc = doc;
    this.elements = options?.elements ?? {
      modeDropdown: getRequiredElement(doc, "mode-dropdown"),
      modelDropdown: getRequiredElement(doc, "model-dropdown"),
      configOptionsContainer: getRequiredElement(
        doc,
        "config-options-container"
      ),
      contextUsageRing: getRequiredElement<HTMLDivElement>(
        doc,
        "context-usage-ring"
      ),
    };

    if (options?.vscode) {
      this.attach(options.vscode);
    }
  }

  attach(vscode: VsCodeApi): void {
    if (this.vscode) return;
    this.vscode = vscode;

    // Dropdown widgets attach document-level click listeners, so initialize
    // them once even if tests or future lifecycle hooks call attach again.
    this.modeDropdown = new Dropdown(this.elements.modeDropdown, (id) => {
      this.vscode?.postMessage({ type: "selectMode", modeId: id });
    });

    this.modelDropdown = new Dropdown(
      this.elements.modelDropdown,
      (id) => {
        this.vscode?.postMessage({ type: "selectModel", modelId: id });
      },
      (id, isStarred) => {
        this.vscode?.postMessage({
          type: "toggleModelStar",
          modelId: id,
          isStarred,
        });
      }
    );
  }

  updateMetadata(msg: ExtensionMessage): void {
    const hasModes =
      msg.modes &&
      msg.modes.availableModes &&
      msg.modes.availableModes.length > 0;
    const hasModels =
      msg.models &&
      msg.models.availableModels &&
      msg.models.availableModels.length > 0;

    if (Array.isArray(msg.starredModels)) {
      this.starredModels = new Set(msg.starredModels);
    }

    if (hasModes && msg.modes) {
      this.elements.modeDropdown.style.display = "flex";
      this.modeDropdown?.setOptions(
        msg.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name || mode.id,
        })),
        msg.modes.currentModeId
      );
    } else {
      this.elements.modeDropdown.style.display = "none";
    }

    if (hasModels && msg.models) {
      this.elements.modelDropdown.style.display = "flex";
      this.lastModelsMsg = msg.models;
      this.updateModelDropdown(msg.models);
    } else {
      this.elements.modelDropdown.style.display = "none";
      this.lastModelsMsg = null;
    }

    this.renderGenericConfigOptions(msg.genericConfigOptions ?? []);
  }

  setModeValue(modeId: string): void {
    this.modeDropdown?.setValue(modeId);
  }

  setModelValue(modelId: string): void {
    this.modelDropdown?.setValue(modelId);
  }

  updateContextUsage(msg: ExtensionMessage): void {
    updateContextUsageRing(this.elements.contextUsageRing, {
      used: msg.used,
      size: msg.size,
      cost: msg.cost,
    });
  }

  private updateModelDropdown(
    modelsMsg: NonNullable<ExtensionMessage["models"]>
  ): void {
    const options: DropdownOption[] = [];
    const availableModels = modelsMsg.availableModels || [];

    const starred = availableModels.filter((model) =>
      this.starredModels.has(model.modelId)
    );

    if (starred.length > 0) {
      options.push({ id: "header-starred", name: "Starred", type: "header" });
      starred.forEach((model) => {
        options.push({
          id: model.modelId,
          name: model.name || model.modelId,
          isStarred: true,
          canStar: true,
        });
      });
      options.push({ id: "divider-1", name: "", type: "divider" });
      options.push({ id: "header-all", name: "All Models", type: "header" });
    }

    availableModels.forEach((model) => {
      options.push({
        id: model.modelId,
        name: model.name || model.modelId,
        isStarred: this.starredModels.has(model.modelId),
        canStar: true,
      });
    });

    this.modelDropdown?.setOptions(options, modelsMsg.currentModelId);
  }

  private renderGenericConfigOptions(
    options: NonNullable<ExtensionMessage["genericConfigOptions"]>
  ): void {
    const container = this.elements.configOptionsContainer;
    const incomingIds = new Set(options.map((option) => option.id));

    // Remove stale dynamic controls before rendering updates so hidden agent
    // options cannot keep posting old config IDs.
    for (const id of this.configOptionDropdowns.keys()) {
      if (!incomingIds.has(id)) {
        const element = container.querySelector<HTMLElement>(
          `[data-config-id="${cssEscapeAttr(id)}"]`
        );
        if (element) element.remove();
        this.configOptionDropdowns.delete(id);
      }
    }

    // Reuse wrappers by config id to preserve dropdown instances and their
    // outside-click listeners across metadata refreshes.
    for (const option of options) {
      const safeId = option.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      let wrapper = container.querySelector<HTMLElement>(
        `[data-config-id="${cssEscapeAttr(option.id)}"]`
      );

      if (!wrapper) {
        wrapper = this.createGenericConfigOptionElement(option, safeId);
        container.appendChild(wrapper);
      }

      const dropdown = this.ensureConfigOptionDropdown(option.id, wrapper);
      const titleText = option.description
        ? `${option.name}\n${option.description}`
        : option.name;
      dropdown.setCustomTitle(titleText);
      dropdown.setOptions(
        option.options.map((item) => ({
          id: item.value,
          name: item.name || item.value,
        })),
        option.currentValue
      );
    }
  }

  private createGenericConfigOptionElement(
    option: NonNullable<ExtensionMessage["genericConfigOptions"]>[number],
    safeId: string
  ): HTMLElement {
    const wrapper = this.doc.createElement("div");
    wrapper.className = "custom-dropdown";
    wrapper.setAttribute("data-config-id", option.id);
    wrapper.id = `config-option-${safeId}`;
    wrapper.style.display = "flex";

    const trigger = this.doc.createElement("div");
    trigger.className = "dropdown-trigger";

    const iconClass = option.category
      ? CATEGORY_ICONS[option.category]
      : undefined;
    if (iconClass) {
      const icon = this.doc.createElement("span");
      icon.className = `dropdown-icon codicon ${iconClass}`;
      icon.setAttribute("aria-hidden", "true");
      trigger.appendChild(icon);
    }

    const label = this.doc.createElement("span");
    label.className = "selected-label";
    label.textContent = option.name || option.id;
    trigger.appendChild(label);

    const chevron = this.doc.createElement("span");
    chevron.className = "dropdown-chevron";
    const chevronIcon = this.doc.createElement("span");
    chevronIcon.className = "codicon codicon-chevron-down";
    chevron.appendChild(chevronIcon);
    trigger.appendChild(chevron);

    const popover = this.doc.createElement("div");
    popover.className = "dropdown-popover";

    wrapper.appendChild(trigger);
    wrapper.appendChild(popover);
    return wrapper;
  }

  private ensureConfigOptionDropdown(
    configId: string,
    wrapper: HTMLElement
  ): Dropdown {
    const existing = this.configOptionDropdowns.get(configId);
    if (existing) return existing;

    const dropdown = new Dropdown(wrapper, (value) => {
      this.vscode?.postMessage({
        type: "selectConfigOption",
        configId,
        value,
      });
    });
    this.configOptionDropdowns.set(configId, dropdown);
    return dropdown;
  }
}
