import {
  DurableSleepOrganizationUnavailableError,
  type DurableSleepClaim,
  type DurableSleepOrganizationAttempt,
} from "@nautilo/reflection/durable";

import {
  BackgroundAttemptUnavailableError,
  openBackgroundAttempt,
  type BackgroundAccessSession,
  type BackgroundAttemptIdentity,
  type BackgroundAttemptObservation,
} from "../background-processing/attempt";

/** The durable claim remains the owner of retry and publication state. */
export function createReflectionOrganizationAttemptOpener(options: {
  checkAvailable(): Promise<boolean>;
  assertClaimCurrent(claim: DurableSleepClaim): Promise<boolean>;
  openAccess?(
    identity: BackgroundAttemptIdentity,
    signal: AbortSignal,
    claim: DurableSleepClaim,
  ): Promise<BackgroundAccessSession>;
  observe?(observation: BackgroundAttemptObservation): void | Promise<void>;
}): (claim: DurableSleepClaim, signal?: AbortSignal) => Promise<DurableSleepOrganizationAttempt> {
  return async (claim, signal) => {
    const identity: BackgroundAttemptIdentity = {
      family: "reflection",
      stage: claim.changeReason === "dependency_lost" ? "dependency_rewrite" : "organization",
      workId: `sleep:${claim.logicalObjectRef}:${claim.generation}`,
      attemptId: claim.leaseToken,
    };
    const assertClaimCurrent = async () => {
      if (!(await options.checkAvailable()) || !(await options.assertClaimCurrent(claim))) {
        throw new BackgroundAttemptUnavailableError();
      }
    };
    try {
      const attempt = await openBackgroundAttempt({
        identity,
        ...(signal === undefined ? {} : { signal }),
        checkAvailable: () => options.checkAvailable(),
        openAccess: async (coordinates, attemptSignal) => {
          await assertClaimCurrent();
          const session = await options.openAccess?.(coordinates, attemptSignal, claim);
          return {
            assertCurrent: async () => {
              await assertClaimCurrent();
              await session?.assertCurrent();
            },
            close: async () => { await session?.close(); },
          };
        },
        ...(options.observe === undefined ? {} : { observe: (observation) => options.observe!(observation) }),
      });
      const mapUnavailable = async <T>(action: () => Promise<T>): Promise<T> => {
        try { return await action(); }
        catch (error) {
          if (error instanceof BackgroundAttemptUnavailableError) throw new DurableSleepOrganizationUnavailableError();
          throw error;
        }
      };
      return {
        assertCurrent: () => mapUnavailable(() => attempt.assertCurrent()),
        publish: (publish) => mapUnavailable(() => attempt.publish(publish)),
        close: (outcome) => attempt.close(outcome),
      };
    } catch (error) {
      if (error instanceof BackgroundAttemptUnavailableError) {
        throw new DurableSleepOrganizationUnavailableError();
      }
      throw error;
    }
  };
}
