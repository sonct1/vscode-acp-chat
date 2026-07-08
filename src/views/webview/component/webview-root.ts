import type { WebviewContext } from "../context";
import { AuxiliaryPanelsComponent } from "./auxiliary-panels";
import { InputPanelComponent } from "./input-panel";
import { MessageListComponent } from "./message-list";
import { ChipRendererComponent } from "./chip-renderer";
import { SessionToolbarComponent } from "./session-toolbar";

/**
 * Top-level DOM composition for the webview. Constructs the component-owned
 * element groups; each component owns its own DOM handles.
 *
 * Refactored to accept a {@link WebviewContext} instead of a raw Document.
 */
export class WebviewRootComponent {
  readonly messageList: MessageListComponent;
  readonly inputPanel: InputPanelComponent;
  readonly sessionToolbar: SessionToolbarComponent;
  readonly auxiliaryPanels: AuxiliaryPanelsComponent;
  readonly chipRenderer: ChipRendererComponent;

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
  }
}
