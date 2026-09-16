/**
 * M134 — conversational-focus substrate (append-only event log + derived
 * active-focus projection). See ISSUE-M134.
 *
 * Single-writer rule: only the Conductor (`packages/runtime/src/conductor/*`)
 * and the focus HTTP routes may import `./writer`. Read helpers (`./read`,
 * `./derive`) are unrestricted.
 */
export { deriveActiveFoci, type ActiveFocus } from "./derive";
export {
  openOrExtendFocus,
  clearFocus,
  materializeExpiry,
  type FocusDb,
} from "./writer";
export {
  deriveRecentFocusBotActorIds,
  loadActiveFoci,
  loadRecentFocusBotActorIds,
} from "./read";

/**
 * D426 Phase 2 — durable, requester-private Thread Responder substrate.
 * `./focus/writer` is single-writer restricted (Conductor + focus routes
 * only); the responder helpers here are the validated read/replace/clear/
 * invalidation surface for the persistent per-(Subthread, human) Genie
 * selection. See `./responder`.
 */
export {
  readSubthreadResponder,
  replaceSubthreadResponder,
  clearSubthreadResponder,
  invalidateSubthreadResponders,
  invalidateRespondersForBotInParentChildren,
  ResponderOpError,
  type ResponderDb,
  type SubthreadResponderRow,
  type SubthreadResponderRead,
  type SubthreadResponderStatus,
  type SubthreadResponderSource,
  type SubthreadResponderUnavailableReason,
} from "./responder";
