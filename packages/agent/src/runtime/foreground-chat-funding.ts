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
  /**
   * Trusted foreground-only admission for the bounded native Task controls.
   * Background workers and sessions whose signed model cannot call functions
   * leave this absent, so personal execution remains tool-free by default.
   */
  readonly personalTaskControls?: boolean;
  /**
   * Non-secret current union of caller-runnable Task model ids. Projected into
   * Task discovery for either parent funding class; every create/fire attempt
   * is rechecked by the server funding owner.
   */
  readonly runnableModelIds?: readonly string[];
  /**
   * Trusted subset of {@link runnableModelIds} that the caller can fund but
   * the server cannot. An exact selection from this set may be admitted only
   * as a native root tool-free Task; canonical creation rechecks live funding.
   */
  readonly personalOnlyTaskModelIds?: readonly string[];
  runAttempt<T>(
    modelId: string,
    callback: (attempt: ForegroundChatFundingAttempt) => Promise<T>,
    transport?: "direct" | "surplus",
  ): Promise<T>;
  recheckAttempt(modelId: string, transport?: "direct" | "surplus"): Promise<void>;
}
