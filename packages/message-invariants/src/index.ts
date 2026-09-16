export { assertMessageInvariants } from "./assert.js";
export { assignStableToolMessageId, isStableToolMessageId } from "./stable-ids.js";
export { mergeMessagesPreservingInvariants } from "./merge.js";
export {
  dedupeToolMessagesByCallId,
  dedupeToolCallIdsWithinAIMessages,
  dedupeToolCallIdsAcrossAIMessages,
  validateMessageHistory,
  finalSafetyNetPass,
  type ValidationResult,
  // BaseMessage-shape predicates. Exposed because any consumer that
  // introspects message shape (token estimation, custom merges,
  // dev-mode invariants) wants the same predicates the invariants
  // package itself uses internally — duplicating them in each
  // consumer is the alternative and causes drift.
  hasToolCalls,
  getToolCalls,
  getContentAsString,
} from "./validate.js";
