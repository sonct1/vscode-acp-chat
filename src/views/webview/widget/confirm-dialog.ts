/**
 * Confirmation dialog widget.
 *
 * Displays a modal overlay asking the user to confirm an action that would
 * interrupt the currently generating agent response.  Returns a
 * `Promise<boolean>` that resolves to `true` when the user confirms and
 * `false` when they cancel or dismiss the dialog.
 */

/**
 * Show a confirmation dialog and wait for the user's decision.
 *
 * @param doc         The document to attach the overlay to.
 * @param actionLabel Human-readable label describing the action that triggered
 *                    the dialog (e.g. "New Chat", "Clear Chat").
 * @returns           `true` if the user confirmed, `false` otherwise.
 */
export function showConfirmDialog(
  doc: Document,
  actionLabel: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = doc.createElement("div");
    overlay.className = "confirm-dialog-overlay";

    const dialog = doc.createElement("div");
    dialog.className = "confirm-dialog";

    const header = doc.createElement("div");
    header.className = "confirm-dialog-header";
    const icon = doc.createElement("span");
    icon.className = "codicon codicon-warning";
    const title = doc.createElement("span");
    title.textContent = "Agent is generating";
    header.appendChild(icon);
    header.appendChild(title);

    const body = doc.createElement("div");
    body.className = "confirm-dialog-body";

    const message = doc.createElement("div");
    message.className = "confirm-dialog-message";
    message.textContent = `The agent is currently generating a response. "${actionLabel}" will stop the current generation. Do you want to proceed?`;

    const actions = doc.createElement("div");
    actions.className = "confirm-dialog-actions";

    const confirmBtn = doc.createElement("button");
    confirmBtn.className = "confirm-dialog-btn confirm-dialog-btn-confirm";
    confirmBtn.textContent = "Stop & Continue";

    const cancelBtn = doc.createElement("button");
    cancelBtn.className = "confirm-dialog-btn confirm-dialog-btn-cancel";
    cancelBtn.textContent = "Cancel";

    const cleanup = () => {
      overlay.remove();
    };

    confirmBtn.addEventListener("click", () => {
      cleanup();
      resolve(true);
    });

    cancelBtn.addEventListener("click", () => {
      cleanup();
      resolve(false);
    });

    // Dismiss when clicking the backdrop outside the dialog.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(false);
      }
    });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    body.appendChild(message);
    body.appendChild(actions);
    dialog.appendChild(header);
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    doc.body.appendChild(overlay);
    confirmBtn.focus();
  });
}
