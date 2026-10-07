import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskFundingBinding } from "@nautilo/types";
import type { CapabilityFundingSession } from "./capability-funding";
import type { PersonalProviderCredential } from "../providers/types";
import type { UsageFundingProvenance } from "../usage/usage-context";

/**
 * The funding owner proved the original personal Surplus admission is still
 * current, but no separate caller-owned credential exists for the selected
 * model's direct provider. No direct-provider request was started.
 */
export class PersonalDirectFundingUnavailableError extends Error {
  readonly code = "personal_credential_missing" as const;

  constructor() {
    super("The admitted personal funding source has no direct-provider credential for this model.");
    this.name = "PersonalDirectFundingUnavailableError";
  }
}

/** A later configured model has no route funded by the pinned personal payer. */
export class PersonalModelFundingUnavailableError extends Error {
  readonly code = "personal_credential_missing" as const;

  constructor() {
    super("The configured fallback model is unavailable with the admitted personal funding source.");
    this.name = "PersonalModelFundingUnavailableError";
  }
}

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
export interface ForegroundFundingSnapshot {
  readonly modelId: string;
  readonly binding: TaskFundingBinding;
}

export interface ForegroundChatFundingSession {
  readonly admission?: ForegroundFundingSnapshot;
  readonly kind: "personal" | "server";
  /** Server-admitted operation family, never accepted from serialized input. */
  readonly workload?: "research" | "decision";
  /** Independently admitted child research/decision operations. Never serialized. */
  readonly capabilityFunding?: CapabilityFundingSession;
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


const resumeFunding = new AsyncLocalStorage<ForegroundChatFundingSession>();
export function runWithForegroundFundingSession<T>(session: ForegroundChatFundingSession | null, run: () => T): T {
  return session ? resumeFunding.run(session, run) : resumeFunding.exit(run);
}
export function getForegroundFundingSession(): ForegroundChatFundingSession | undefined {
  return resumeFunding.getStore();
}
