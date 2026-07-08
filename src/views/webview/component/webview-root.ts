import type { WebviewContext } from "../context";
import type { WebviewElements } from "../types";
import { AuxiliaryPanelsComponent } from "./auxiliary-panels";
import { InputPanelComponent } from "./input-panel";
import { MessageListComponent } from "./message-list";
import { ChipRendererComponent } from "./chip-renderer";
import { SessionToolbarComponent } from "./session-toolbar";

/**
 * Top-level DOM composition for the webview. It builds component-owned element
 * groups first, then exposes the legacy flat aliases that existing controller
 * code and tests still consume during the incremental migration.
 *
 * Refactored to accept a {@link WebviewContext} instead of a raw Document.
 */
export class WebviewRootComponent {
  readonly messageList: MessageListComponent;
  readonly inputPanel: InputPanelComponent;
  readonly sessionToolbar: SessionToolbarComponent;
  readonly auxiliaryPanels: AuxiliaryPanelsComponent;
  readonly chipRenderer: ChipRendererComponent;
  readonly elements: WebviewElements;

  constructor(ctx: WebviewContext) {
    this.chipRenderer = new ChipRendererComponent(ctx);
    this.messageList = new MessageListComponent(ctx, {
      chipRenderer: this.chipRenderer,
    });
    this.inputPanel = new InputPanelComponent(ctx, {
      chipRenderer: this.chipRenderer,
    });
    this.sessionToolbar = new SessionToolbarComponent(ctx, {
      elements: this.inputPanel.elements.toolbar,
    });
    this.auxiliaryPanels = new AuxiliaryPanelsComponent(ctx);

    // Keep this alias map so existing code can consume flat fields while
    // the migration to component-owned elements proceeds.
    const messageList = this.messageList.elements;
    const inputPanel = this.inputPanel.elements;
    const sessionToolbar = this.sessionToolbar.elements;
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
