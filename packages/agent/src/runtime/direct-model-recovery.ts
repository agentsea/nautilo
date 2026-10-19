import type { ForegroundChatFundingAttempt, ForegroundChatFundingSession } from "./foreground-chat-funding";

/**
 * Called only after an admitted marketplace attempt permits direct recovery.
 * A missing server route may enter the exact personal sequence minted by the
 * server. A direct callback failure is handled by the caller's output guards.
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
    if (directAttemptStarted || session.kind !== "server"
      || (!session.openPersonalRecovery && !session.openPersonalDirectRecovery)
      || typeof error !== "object" || error === null
      || !("code" in error) || error.code !== "provider_credentials_missing") throw error;
    const recovery = session.openPersonalRecovery
      ? await session.openPersonalRecovery(modelId)
      : await session.openPersonalDirectRecovery!(modelId);
    return recovery.runAttempt(modelId, (attempt) => run(attempt, recovery),
      session.openPersonalRecovery ? undefined : "direct");
  }
}
