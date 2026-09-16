import {
  selectLiveEncryptionRepresentationPolicy,
  type LiveShadowEncryptionTransitionPolicy,
} from "./encryption-transition-policy.ts";

export type DataOperationFailureClass =
  | "recoverable_availability"
  | "key_waiting"
  | "stale"
  | "unsupported"
  | "integrity"
  | "authority"
  | "cancelled"
  | "unknown";

export class ClassifiedDataOperationError extends Error {
  override readonly name = "ClassifiedDataOperationError";

  constructor(
    readonly failureClass: DataOperationFailureClass,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function classifyDataOperationFailure(
  error: unknown,
): DataOperationFailureClass {
  return error instanceof ClassifiedDataOperationError
    ? error.failureClass
    : "unknown";
}

export type DataOperationPolicySnapshot = Readonly<{
  policy: LiveShadowEncryptionTransitionPolicy;
  /** Opaque admission/policy generation used only by the binding that issued it. */
  revalidationToken: number;
}>;

export interface DataOperationPolicyBinding {
  resolve(): Promise<DataOperationPolicySnapshot>;
  revalidate(revalidationToken: number): Promise<void>;
}

export type DataOperationReadResult<Value> = Readonly<{
  representation: "ordinary" | "protected";
  value: Value;
  revalidationToken: number;
}>;

export type DataOperationPublicationContext = Readonly<{
  /** Local composition fence, not a server policy revision or wire value. */
  revalidationToken: number;
}>;

type FailureClassifier = (error: unknown) => DataOperationFailureClass;

export type DataOperationReadInput<Ordinary, Protected, Value> = Readonly<{
  ordinary?: () => Promise<Ordinary>;
  protected?: () => Promise<Protected>;
  consumeOrdinary(value: Ordinary): Promise<Value> | Value;
  consumeProtected(value: Protected): Promise<Value> | Value;
  repair?: Readonly<{
    forward?: () => Promise<Protected>;
    reverse?: (value: Protected) => Promise<void>;
  }>;
  classifyFailure?: FailureClassifier;
}>;

export type DataOperationMutationInput<Plan, Result> = Readonly<{
  ordinary?: () => Promise<Plan>;
  protected?: () => Promise<Plan>;
  dual?: () => Promise<Plan>;
  publish(
    plan: Plan,
    context: DataOperationPublicationContext,
  ): Promise<Result>;
  classifyFailure?: FailureClassifier;
}>;

export type AtomicDataOperationMutationInput<Result> = Readonly<{
  ordinary?: (context: DataOperationPublicationContext) => Promise<Result>;
  protected?: (context: DataOperationPublicationContext) => Promise<Result>;
  dual?: (context: DataOperationPublicationContext) => Promise<Result>;
  classifyFailure?: FailureClassifier;
}>;

export interface EncryptionDataOperationOwner {
  read<Ordinary, Protected, Value>(
    input: DataOperationReadInput<Ordinary, Protected, Value>,
  ): Promise<DataOperationReadResult<Value>>;
  mutate<Plan, Result>(
    input: DataOperationMutationInput<Plan, Result>,
  ): Promise<Result>;
  runMutation<Result>(
    input: AtomicDataOperationMutationInput<Result>,
  ): Promise<Result>;
  metadata<Result>(
    operation: (context: DataOperationPublicationContext) => Promise<Result>,
  ): Promise<Result>;
}

function requiredPort<Args extends readonly unknown[], Result>(
  port: ((...args: Args) => Promise<Result>) | undefined,
): (...args: Args) => Promise<Result> {
  if (port === undefined) {
    throw new ClassifiedDataOperationError(
      "unsupported",
      "The selected encryption data operation is not supported",
    );
  }
  return port;
}

export function fallbackEligible(failure: DataOperationFailureClass): failure is "recoverable_availability" | "key_waiting" {
  return failure === "recoverable_availability" || failure === "key_waiting";
}

/**
 * Browser-safe policy owner for confidential data operations. Entity adapters
 * retain structural selection, codecs, exact revision identity and atomic
 * publication; this owner alone chooses which lazy body ports may be invoked.
 */
export function bindEncryptionDataOperationOwner(
  input: Readonly<{
    policy: DataOperationPolicyBinding;
  }>,
): EncryptionDataOperationOwner {
  return Object.freeze({
    async read<Ordinary, Protected, Value>(
      operation: DataOperationReadInput<Ordinary, Protected, Value>,
    ): Promise<DataOperationReadResult<Value>> {
      const snapshot = await input.policy.resolve();
      const representation = selectLiveEncryptionRepresentationPolicy(
        snapshot.policy,
      );
      await input.policy.revalidate(snapshot.revalidationToken);
      if (representation.read === "ordinary_only") {
        const ordinary = await requiredPort(operation.ordinary)();
        await input.policy.revalidate(snapshot.revalidationToken);
        const value = await operation.consumeOrdinary(ordinary);
        await input.policy.revalidate(snapshot.revalidationToken);
        return Object.freeze({
          representation: "ordinary" as const,
          value,
          revalidationToken: snapshot.revalidationToken,
        });
      }

      const loadProtected = requiredPort(operation.protected);
      const classify =
        operation.classifyFailure ?? classifyDataOperationFailure;
      const runReverseRepair = async (value: Protected): Promise<void> => {
        if (!representation.allowReverseRepair || operation.repair?.reverse === undefined) return;
        try {
          await input.policy.revalidate(snapshot.revalidationToken);
          await operation.repair.reverse(value);
        } catch (error) {
          if (!representation.allowOrdinaryFallback || !fallbackEligible(classify(error))) {
            throw error;
          }
        }
      };
      let protectedValue: Protected;
      try {
        protectedValue = await loadProtected();
      } catch (initialError) {
        const initialFailure = classify(initialError);
        if (!fallbackEligible(initialFailure)) throw initialError;
        if (
          representation.allowForwardRepair &&
          operation.repair?.forward !== undefined
        ) {
          let repaired: Protected | undefined;
          let repairSucceeded = false;
          let repairFailure: unknown;
          try {
            await input.policy.revalidate(snapshot.revalidationToken);
            repaired = await operation.repair.forward();
            repairSucceeded = true;
          } catch (repairError) {
            if (!fallbackEligible(classify(repairError))) throw repairError;
            repairFailure = repairError;
          }
          if (repairSucceeded) {
            await runReverseRepair(repaired as Protected);
            await input.policy.revalidate(snapshot.revalidationToken);
            const value = await operation.consumeProtected(
              repaired as Protected,
            );
            await input.policy.revalidate(snapshot.revalidationToken);
            return Object.freeze({
              representation: "protected" as const,
              value,
              revalidationToken: snapshot.revalidationToken,
            });
          }
          if (!representation.allowOrdinaryFallback) throw repairFailure;
        }
        if (!representation.allowOrdinaryFallback) throw initialError;
        await input.policy.revalidate(snapshot.revalidationToken);
        const ordinary = await requiredPort(operation.ordinary)();
        await input.policy.revalidate(snapshot.revalidationToken);
        const value = await operation.consumeOrdinary(ordinary);
        await input.policy.revalidate(snapshot.revalidationToken);
        return Object.freeze({
          representation: "ordinary" as const,
          value,
          revalidationToken: snapshot.revalidationToken,
        });
      }

      await runReverseRepair(protectedValue);
      await input.policy.revalidate(snapshot.revalidationToken);
      const value = await operation.consumeProtected(protectedValue);
      await input.policy.revalidate(snapshot.revalidationToken);
      return Object.freeze({
        representation: "protected" as const,
        value,
        revalidationToken: snapshot.revalidationToken,
      });
    },

    async mutate<Plan, Result>(
      operation: DataOperationMutationInput<Plan, Result>,
    ): Promise<Result> {
      const snapshot = await input.policy.resolve();
      const representation = selectLiveEncryptionRepresentationPolicy(
        snapshot.policy,
      );
      const classify =
        operation.classifyFailure ?? classifyDataOperationFailure;
      let publicationToken = snapshot.revalidationToken;
      let plan: Plan;
      if (representation.write === "ordinary_only") {
        await input.policy.revalidate(snapshot.revalidationToken);
        plan = await requiredPort(operation.ordinary)();
      } else if (representation.write === "protected_only") {
        await input.policy.revalidate(snapshot.revalidationToken);
        plan = await requiredPort(operation.protected)();
      } else {
        try {
          await input.policy.revalidate(snapshot.revalidationToken);
          plan = await requiredPort(operation.dual)();
        } catch (error) {
          if (
            !representation.allowOrdinaryFallback ||
            !fallbackEligible(classify(error))
          ) {
            throw error;
          }
          const current = await input.policy.resolve();
          const currentRepresentation =
            selectLiveEncryptionRepresentationPolicy(current.policy);
          if (!currentRepresentation.allowOrdinaryFallback) throw error;
          await input.policy.revalidate(current.revalidationToken);
          publicationToken = current.revalidationToken;
          plan = await requiredPort(operation.ordinary)();
        }
      }
      await input.policy.revalidate(publicationToken);
      return operation.publish(
        plan,
        Object.freeze({
          revalidationToken: publicationToken,
        }),
      );
    },

    async runMutation<Result>(
      operation: AtomicDataOperationMutationInput<Result>,
    ): Promise<Result> {
      const snapshot = await input.policy.resolve();
      const representation = selectLiveEncryptionRepresentationPolicy(
        snapshot.policy,
      );
      const context = Object.freeze({
        revalidationToken: snapshot.revalidationToken,
      });
      const selected =
        representation.write === "ordinary_only"
          ? requiredPort(operation.ordinary)
          : representation.write === "protected_only"
            ? requiredPort(operation.protected)
            : requiredPort(operation.dual);
      await input.policy.revalidate(snapshot.revalidationToken);
      try {
        return await selected(context);
      } catch (error) {
        const classify =
          operation.classifyFailure ?? classifyDataOperationFailure;
        if (
          !representation.allowOrdinaryFallback ||
          !fallbackEligible(classify(error))
        ) {
          throw error;
        }
        // Publication and crypto preparation can be one existing atomic adapter
        // operation. Re-resolve before the ordinary retry so a concurrent switch
        // to Strict or Full cannot widen access.
        const current = await input.policy.resolve();
        const currentRepresentation = selectLiveEncryptionRepresentationPolicy(
          current.policy,
        );
        if (!currentRepresentation.allowOrdinaryFallback) throw error;
        await input.policy.revalidate(current.revalidationToken);
        return requiredPort(operation.ordinary)(
          Object.freeze({
            revalidationToken: current.revalidationToken,
          }),
        );
      }
    },

    async metadata<Result>(
      operation: (context: DataOperationPublicationContext) => Promise<Result>,
    ): Promise<Result> {
      const snapshot = await input.policy.resolve();
      await input.policy.revalidate(snapshot.revalidationToken);
      return operation(
        Object.freeze({ revalidationToken: snapshot.revalidationToken }),
      );
    },
  });
}
