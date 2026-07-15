export interface PiContextUsageUnavailableMeta {
  state: "unavailable";
  size?: number;
  reason?: "post_compaction" | "pending_provider_usage";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function getPiContextUsageUnavailableMeta(
  update: unknown
): PiContextUsageUnavailableMeta | null {
  const record = asRecord(update);
  const meta = asRecord(record?._meta);
  const piAcp = asRecord(meta?.piAcp);
  const contextUsage = asRecord(piAcp?.contextUsage);

  if (contextUsage?.state !== "unavailable") {
    return null;
  }

  const result: PiContextUsageUnavailableMeta = { state: "unavailable" };
  if (typeof contextUsage.size === "number" && Number.isFinite(contextUsage.size)) {
    result.size = contextUsage.size;
  }
  if (
    contextUsage.reason === "post_compaction" ||
    contextUsage.reason === "pending_provider_usage"
  ) {
    result.reason = contextUsage.reason;
  }
  return result;
}
