import type { ForegroundChatFundingAttempt, ForegroundChatFundingSession } from "./foreground-chat-funding";

/**
 * Called only after an admitted marketplace attempt permits direct recovery.
 * A missing server route may use the exact personal recovery authority minted
 * by the server. An error after a direct callback begins cannot change payer.
 */
export async function runAdmittedDirectModelRecovery<T>(
  session: ForegroundChatFundingSession,
  modelId: string,
  run: (attempt: ForegroundChatFundingAttempt, session: ForegroundChatFundingSession) => Promise<T>,
): Promise<T> {
  let directAttemptStarted = false;
  try {
    return await session.runAttempt(modelId, (attempt) => {
      directAttemptStarted = true;
      return run(attempt, session);
    }, "direct");
  } catch (error) {
    if (directAttemptStarted || session.kind !== "server" || !session.openPersonalDirectRecovery
      || typeof error !== "object" || error === null
      || !("code" in error) || error.code !== "provider_credentials_missing") throw error;
    const recovery = await session.openPersonalDirectRecovery(modelId);
    return recovery.runAttempt(modelId, (attempt) => run(attempt, recovery), "direct");
  }
}
