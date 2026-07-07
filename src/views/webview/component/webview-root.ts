import type { WebviewElements } from "../types";
import { AuxiliaryPanelsComponent } from "./auxiliary-panels";
import { InputPanelComponent } from "./input-panel";
import { MessageListComponent } from "./message-list";

/**
 * Top-level DOM composition for the webview. It builds component-owned element
 * groups first, then exposes the legacy flat aliases that existing controller
 * code and tests still consume during the incremental migration.
 */
export class WebviewRootComponent {
  readonly messageList: MessageListComponent;
  readonly inputPanel: InputPanelComponent;
  readonly auxiliaryPanels: AuxiliaryPanelsComponent;
  readonly elements: WebviewElements;

  constructor(doc: Document) {
    this.messageList = new MessageListComponent(doc);
    this.inputPanel = new InputPanelComponent(doc);
    this.auxiliaryPanels = new AuxiliaryPanelsComponent(doc);

    // Keep this alias map explicit so future migrations can remove flat fields
    // one component at a time without changing DOM lookup behavior.
    const messageList = this.messageList.elements;
    const inputPanel = this.inputPanel.elements;
    const sessionToolbar = inputPanel.toolbar;
    const auxiliaryPanels = this.auxiliaryPanels.elements;

    this.elements = {
      messageList,
      inputPanel,
      sessionToolbar,
      auxiliaryPanels,

      messagesContainerEl: messageList.containerEl,
      messagesEl: messageList.messagesEl,
      inputEl: inputPanel.inputEl,
      attachImageBtn: inputPanel.attachImageBtn,
      imagePreviewPopover: inputPanel.imagePreviewPopover,
      sendBtn: inputPanel.sendBtn,
      stopBtn: inputPanel.stopBtn,
      modeDropdown: sessionToolbar.modeDropdown,
      modelDropdown: sessionToolbar.modelDropdown,
      configOptionsContainer: sessionToolbar.configOptionsContainer,
      contextUsageRing: sessionToolbar.contextUsageRing,
      welcomeView: messageList.welcomeView,
      commandAutocomplete: inputPanel.commandAutocomplete,
      planContainer: auxiliaryPanels.planContainer,
      typingIndicatorEl: messageList.typingIndicatorEl,
      diffSummaryContainer: auxiliaryPanels.diffSummaryContainer,
    };
  }
}

export function createWebviewRoot(doc: Document): WebviewElements {
  return new WebviewRootComponent(doc).elements;
}
