/**
 * Context-usage ring widget.
 *
 * Renders a small SVG ring that visualises how much of the model's context
 * window has been consumed.  The ring changes colour at configurable
 * thresholds and shows a tooltip with the exact numbers.
 */

/**
 * Format a monetary amount using `Intl.NumberFormat`, falling back to a
 * simple template if the currency code is not supported.
 */
export function formatContextCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(4)}`;
  }
}

/** Payload accepted by {@link updateContextUsageRing}. */
export interface ContextUsageData {
  used?: number | null;
  size?: number | null;
  cost?: { amount: number; currency: string } | null;
}

/**
 * Update the context-usage ring element.
 *
 * @param wrapper  The `#context-usage-ring` container element.
 * @param data     Current token usage numbers from the extension host.
 */
export function updateContextUsageRing(
  wrapper: HTMLDivElement,
  data: ContextUsageData
): void {
  if (!wrapper) {
    return;
  }
  const fg = wrapper.querySelector(
    ".context-usage__fg"
  ) as SVGCircleElement | null;
  if (!fg) {
    return;
  }

  const { used, size } = data;
  if (
    used === null ||
    used === undefined ||
    size === null ||
    size === undefined ||
    typeof used !== "number" ||
    typeof size !== "number" ||
    size <= 0
  ) {
    wrapper.hidden = true;
    wrapper.classList.remove(
      "usage-low",
      "usage-medium",
      "usage-high",
      "usage-full"
    );
    wrapper.removeAttribute("acp-title");
    wrapper.removeAttribute("aria-label");
    return;
  }

  const ratio = used / size;
  let tier: "usage-low" | "usage-medium" | "usage-high" | "usage-full";
  if (ratio < 0.6) {
    tier = "usage-low";
  } else if (ratio < 0.85) {
    tier = "usage-medium";
  } else if (ratio < 1) {
    tier = "usage-high";
  } else {
    tier = "usage-full";
  }
  wrapper.classList.remove(
    "usage-low",
    "usage-medium",
    "usage-high",
    "usage-full"
  );
  wrapper.classList.add(tier);
  wrapper.hidden = false;

  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(ratio, 1);
  fg.style.strokeDasharray = `${clamped * circumference} ${circumference}`;

  const pct = (ratio * 100).toFixed(1);
  const lines: string[] = [
    `Context window: ${size.toLocaleString()}`,
    `Used: ${used.toLocaleString()} (${pct}%)`,
  ];
  if (data.cost && typeof data.cost.amount === "number" && data.cost.currency) {
    lines.push(
      `Cost: ${formatContextCost(data.cost.amount, data.cost.currency)}`
    );
  }
  const text = lines.join("\n");
  wrapper.setAttribute("acp-title", text);
  wrapper.setAttribute("aria-label", text);
}
