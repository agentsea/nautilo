/**
 * Remaining unread ordering feature flag (D286) — single switch point.
 *
 * M238 made authoritative rail and explorer indicators unconditional.
 * Unread-first sort stays gated off pending separate approval.
 */

/** Float unread rows to the top of their explorer section before the sort mode. */
export const EXPLORER_UNREAD_FIRST_SORT_ENABLED = false;
