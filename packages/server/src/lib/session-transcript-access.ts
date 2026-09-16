/**
 * M133 — who may read their own persisted transcript via `/api/sessions/*`
 * and their own rooms via `/api/rooms/*`. Was a role-name list
 * (owner/admin/superuser/member/contributor); now capability-derived.
 * `read_memories` is held by every non-guest rung (permission-model.md §6)
 * and denied to guests — the same boundary, expressed against the canonical
 * authorization axis (Capabilities).
 *
 * Pure + sync so it stays unit-testable without a DB. Callers resolve the
 * capability union first (`getUserCapabilities`, which returns `string[]`)
 * and pass it in.
 */
export function canViewOwnSessionTranscripts(
  capabilities: readonly string[] | undefined,
): boolean {
  return capabilities?.includes("read_memories") ?? false;
}
