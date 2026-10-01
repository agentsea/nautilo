import type { PersonalProviderCredential } from "../providers/types";
import type { UsageFundingProvenance } from "../usage/usage-context";

/**
 * Secret-bearing inputs for one admitted foreground provider attempt.
 * The callback boundary keeps the decrypted credential out of graph state,
 * checkpoints, and caller-owned configuration.
 */
export interface ForegroundChatFundingAttempt {
  readonly usageFunding: UsageFundingProvenance;
  readonly personalCredential?: PersonalProviderCredential;
}

/**
 * Request-local funding authority for one foreground chat operation.
 * Implementations pin the initially admitted funding class and re-evaluate
 * live policy and credential revision before later provider attempts.
 */
export interface ForegroundChatFundingSession {
  readonly kind: "personal" | "server";
  runAttempt<T>(
    modelId: string,
    callback: (attempt: ForegroundChatFundingAttempt) => Promise<T>,
  ): Promise<T>;
  recheckAttempt(modelId: string): Promise<void>;
}
