import {
  classifyDataOperationFailure,
  type DataOperationPublicationContext,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import type { TaskObserverDeps } from "@nautilo/runtime";

type ProtectedOwner = NonNullable<TaskObserverDeps["protectedOccurrencePort"]>;
type ProtectedPort = Parameters<Parameters<ProtectedOwner["withCurrent"]>[0]>[0];

type TaskObserverHealthObservation = Readonly<{
  policyRevision: number;
  state: "verified" | "waiting_for_authority" | "unsupported" | "failed";
  reason: "none" | "recovery_required" | "unsupported_operation" | "unknown_result";
  retryable: boolean;
}>;

export type TaskOccurrencePolicyHealth = Readonly<{
  /** Resolve only when the concrete live-policy token is still this revision. */
  resolveExactPolicyRevision(revalidationToken: number): Promise<number | null>;
  record(observation: TaskObserverHealthObservation): Promise<void>;
  retireLegacyUnsupported(policyRevision: number): Promise<void>;
}>;

function failureObservation(error: unknown): Omit<
  TaskObserverHealthObservation,
  "policyRevision"
> {
  const failure = classifyDataOperationFailure(error);
  if (failure === "recoverable_availability" || failure === "key_waiting") {
    return {
      state: "waiting_for_authority",
      reason: "recovery_required",
      retryable: true,
    };
  }
  // This boundary itself is supported. A current port rejecting one selected
  // occurrence is a failed handoff, not the retired whole-boundary gate.
  return { state: "failed", reason: "unknown_result", retryable: false };
}

/** Select each occurrence family before its queries, using the shared owner. */
export function createTaskOccurrencePolicyPorts(
  owner: EncryptionDataOperationOwner,
  initializeProtected: () => Promise<ProtectedPort | null>,
  health?: TaskOccurrencePolicyHealth,
): Readonly<{
  ordinary: NonNullable<TaskObserverDeps["ordinaryOccurrencePort"]>;
  protected: ProtectedOwner;
}> {
  return Object.freeze({
    ordinary: Object.freeze({
      withCurrent<Result>(use: () => Promise<Result>): Promise<Result | null> {
        return owner.selectReadMetadata({
          ordinary: use,
          fallback: use,
          protected: () => Promise.resolve(null),
        });
      },
    }),
    protected: Object.freeze({
      withCurrent<Result>(use: (port: ProtectedPort) => Promise<Result>): Promise<Result | null> {
        const useInitialized = async (
          context: DataOperationPublicationContext,
        ): Promise<Result | null> => {
          const currentHealth = health;
          const withExactRevision = async (
            operation: (policyRevision: number) => Promise<void>,
          ): Promise<void> => {
            if (currentHealth === undefined) return;
            try {
              const policyRevision = await currentHealth.resolveExactPolicyRevision(
                context.revalidationToken,
              );
              if (policyRevision !== null) await operation(policyRevision);
            } catch {
              // Health metadata cannot change a protected occurrence result.
            }
          };
          const record = (
            observation: Omit<TaskObserverHealthObservation, "policyRevision">,
          ) => withExactRevision(async policyRevision => {
            await currentHealth?.record({ policyRevision, ...observation });
          });
          let port: ProtectedPort | null;
          try {
            port = await initializeProtected();
          } catch (error) {
            await record(failureObservation(error));
            throw error;
          }
          if (port === null) {
            await record({
              state: "waiting_for_authority",
              reason: "recovery_required",
              retryable: true,
            });
            return null;
          }
          if (currentHealth === undefined) return use(port);
          let attempts = 0;
          const recoverBeforeObservation = port.recoverBeforeObservation?.bind(port);
          const observedPort: ProtectedPort = Object.freeze({
            ...(recoverBeforeObservation === undefined ? {} : {
              recoverBeforeObservation: (limit: number) =>
                recoverBeforeObservation(limit),
            }),
            observeProtectedTaskOccurrence: async (
              occurrence: Parameters<
                ProtectedPort["observeProtectedTaskOccurrence"]
              >[0],
            ) => {
              attempts += 1;
              try {
                await port.observeProtectedTaskOccurrence(occurrence);
              } catch (error) {
                await record(failureObservation(error));
                throw error;
              }
              await record({ state: "verified", reason: "none", retryable: false });
            },
          });
          const result = await use(observedPort);
          if (attempts === 0) {
            await withExactRevision(async policyRevision => {
              await currentHealth?.retireLegacyUnsupported(policyRevision);
            });
          }
          return result;
        };
        return owner.runMutation({
          ordinary: () => Promise.resolve(null),
          protected: useInitialized,
          dual: useInitialized,
        });
      },
    }),
  });
}
