/**
 * M134 Phase 1 — focus sliding-TTL window.
 *
 * Hard-coded for M134; a room-settings override is future work. A focus
 * link opened or extended at time `t` stays active until `t + FOCUS_TTL_MS`
 * unless a later `extended` pushes it forward or a `cleared` ends it.
 */
export const FOCUS_TTL_MS = 90_000;
