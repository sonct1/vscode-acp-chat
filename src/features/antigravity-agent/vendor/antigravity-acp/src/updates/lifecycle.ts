import type { StepRow } from "../types/index.js";

/**
 * Lifecycle / system-internal steps that have no user-facing ACP representation.
 * These are recorded by agy for its own bookkeeping and should be silently
 * skipped (returning `null`) rather than surfaced to the client:
 *
 *   - 90  ephemeral_message     — system reminders injected into the model
 *                                 context (e.g. `bash_command_reminder`),
 *                                 explicitly "not sent by the user".
 *   - 98  conversation_history  — prior-conversation summaries injected as
 *                                 context at the start of a turn.
 *   - 101 stop_hook             — termination / auto-proceed decisions and
 *                                 task notifications emitted by stop hooks.
 *
 * Kept as an explicit, documented no-op (instead of a bare `default`) so the
 * dispatcher distinguishes "known but intentionally ignored" from "unknown".
 */
export const LIFECYCLE_STEP_TYPES = new Set<number>([90, 98, 101]);

export function lifecycleUpdate(_stepRow: StepRow): null {
	return null;
}
