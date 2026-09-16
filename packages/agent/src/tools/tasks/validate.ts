/**
 * M146 (R3) — VALIDATE-REJECT guard for not-yet-wired `task` params.
 *
 * Params whose ENGINE lands in a later phase are rejected with a clear
 * "lands in Phase N" message rather than silently persisted. These fields are
 * deliberately absent from the tool's wire schema (so the model never reaches
 * for them); this guard is the safety net for the HTTP payload (R5), where a
 * field could be hand-supplied, and for any direct dispatcher call.
 *
 * The columns already exist on `tasks` (M141) but stay inert until their phase:
 *   - await_response                         → Phase 7 (await-response engine)
 *   - target_chat ∈ {last_dm, new_dm}        → Phase 7 (DM routing)
 *   - target_chat_handle                     → Phase 7 (DM routing)
 *   - target_user_ids (cross-user, non-empty)→ Phase 7 (cross-user namespace)
 *
 * (`time_limit_seconds` graduated out of this list in M147 / Phase 6 — its
 * watchdog engine now exists; `privacy_mode` was replaced by the M152
 * `model_selection_profile` / `model_selection_spec` fields, which are wired
 * and validated at create time, so it is no longer rejected here.)
 */

/** Accepts both wire-shaped (snake_case) and a few camelCase aliases so the
 *  guard catches the field regardless of which surface supplied it. */
function pick(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (payload[k] !== undefined) return payload[k];
  }
  return undefined;
}

/**
 * Returns a friendly rejection string if the payload carries a not-yet-wired
 * param, else `null`. Pure — no IO.
 */
export function rejectNotYetWiredTaskParams(
  payload: Record<string, unknown>,
): string | null {
  if (pick(payload, "await_response", "awaitResponse")) {
    return "await_response is not available yet (lands in Phase 7).";
  }
  if (pick(payload, "target_chat_handle", "targetChatHandle") !== undefined) {
    return "target_chat_handle is not available yet (lands in Phase 7).";
  }
  const targetChat = pick(payload, "target_chat", "targetChat");
  if (targetChat === "last_dm" || targetChat === "new_dm") {
    return `target_chat "${String(targetChat)}" (direct messages) is not available yet (lands in Phase 7).`;
  }
  const targetUserIds = pick(payload, "target_user_ids", "targetUserIds");
  if (Array.isArray(targetUserIds) && targetUserIds.length > 0) {
    return "target_user_ids (cross-user tasks) is not available yet (lands in Phase 7).";
  }
  return null;
}
