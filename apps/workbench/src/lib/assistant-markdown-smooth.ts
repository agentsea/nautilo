/**
 * D326 — assistant-ui resets smooth text to empty when the message id changes
 * while status is still running. Our streamed assistant bubbles start with a
 * temporary `assistant-...` id and later reconcile to the numeric DB id via
 * `message.new`; smoothing must stop at that point or the completed text
 * "fast streams" from the beginning again.
 */
export function shouldSmoothAssistantMarkdown(messageId: unknown): boolean {
  const n = Number(messageId);
  return !(Number.isInteger(n) && n > 0);
}
