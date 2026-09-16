import type {
  DurableSleepClaim,
  DurableSleepClaimOptions,
  DurableSleepClaimResult,
  DurableSleepOrganizationAttempt,
  DurableSleepSemanticPort,
  DurableSleepStage,
  DurableSleepWorkPort,
} from "@nautilo/reflection/durable";

import {
  ClassifiedDataOperationError, classifyDataOperationFailure, fallbackEligible,
  type DataOperationFailureClass,
  type DataOperationPolicyBinding,
  type DataOperationPolicySnapshot,
} from "../../transition/encryption-data-operation-owner.ts";
import { selectLiveEncryptionRepresentationPolicy } from
  "../../transition/encryption-transition-policy.ts";

type RepresentationAdmission = NonNullable<
  DurableSleepClaimOptions["representationAdmission"]
>;

type ClaimSelection = Readonly<{
  snapshot: DataOperationPolicySnapshot;
  executionRepresentation: "ordinary" | "protected";
  maximumStage: DurableSleepStage;
  ordinaryFallbackReason?: "recoverable_availability" | "key_waiting";
}>;

const STAGE_RANK: Readonly<Record<DurableSleepStage, number>> = Object.freeze({
  authority_projection: 0,
  search_projection: 1,
  organization: 2,
});

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function claimMaximumStage(options?: DurableSleepClaimOptions): DurableSleepStage {
  const stage = options?.maximumStage
    ?? (options?.includeOrganization === false
      ? "search_projection"
      : "organization");
  if (STAGE_RANK[stage] === undefined) {
    throw new TypeError("Invalid Reflection claim maximum stage");
  }
  return stage;
}

function admissionFor(snapshot: DataOperationPolicySnapshot, semanticAvailable = false):
  RepresentationAdmission {
  const representation = selectLiveEncryptionRepresentationPolicy(
    snapshot.policy,
  );
  if (representation.read === "ordinary_only") {
    return Object.freeze({ ordinary: "any", protected: "none" });
  }
  if (representation.allowOrdinaryFallback) {
    return Object.freeze({
      ordinary: "without_protected_head",
      protected: semanticAvailable ? "organization" : "authority_projection",
    });
  }
  return Object.freeze({
    ordinary: "none",
    protected: semanticAvailable ? "organization" : "authority_projection",
  });
}

function snapshotCopy(
  snapshot: DataOperationPolicySnapshot,
): DataOperationPolicySnapshot {
  return Object.freeze({
    policy: Object.freeze({ ...snapshot.policy }),
    revalidationToken: snapshot.revalidationToken,
  });
}

function invalidClaimResult(message: string): TypeError {
  return new TypeError(`Invalid Reflection claimed cohort: ${message}`);
}

function validateClaimResult(
  result: Extract<DurableSleepClaimResult, { status: "claimed" }>,
  admission: RepresentationAdmission,
  requestedMaximumStage: DurableSleepStage,
): Readonly<{
  executionRepresentation: "ordinary" | "protected";
  maximumStage: DurableSleepStage;
}> {
  const representation = result.executionRepresentation;
  const maximumStage = result.maximumStage;
  if (representation !== "ordinary" && representation !== "protected") {
    throw invalidClaimResult("execution representation is absent");
  }
  if (maximumStage === undefined || STAGE_RANK[maximumStage] === undefined) {
    throw invalidClaimResult("execution ceiling is absent or invalid");
  }
  if (STAGE_RANK[result.claim.stage] === undefined) {
    throw invalidClaimResult("claimed stage is invalid");
  }
  if (STAGE_RANK[result.claim.stage] > STAGE_RANK[maximumStage]) {
    throw invalidClaimResult("claimed stage exceeds its execution ceiling");
  }
  if (representation === "ordinary") {
    if (admission.ordinary === "none") {
      throw invalidClaimResult("ordinary execution is not admitted");
    }
    if (maximumStage !== requestedMaximumStage) {
      throw invalidClaimResult("ordinary execution ceiling was substituted");
    }
  } else {
    if (admission.protected === "none") {
      throw invalidClaimResult("protected execution is not admitted");
    }
    const expectedStage = admission.protected === "organization" ? requestedMaximumStage : "authority_projection";
    if (maximumStage !== expectedStage) {
      throw invalidClaimResult("protected execution ceiling was substituted");
    }
  }
  return { executionRepresentation: representation, maximumStage };
}

function unsupportedProtectedOperation(): never {
  throw new ClassifiedDataOperationError(
    "unsupported",
    "Protected Reflection execution is limited to authority projection",
  );
}

export interface ReflectionSemanticDataOperationPorts {
  readonly work: DurableSleepWorkPort;
  readonly semantic: DurableSleepSemanticPort;
  readonly maintain?: (input: Readonly<{limit: number; signal?: AbortSignal}>) => Promise<void>;
}

/**
 * Selects one complete operation representation and keeps its policy token
 * attached to the process-local claim. A verified unused protected wait may
 * switch the whole question to ordinary under Fallback Shadow. Reflection
 * receives its ordinary semantic shape unchanged and never selects a mode.
 */
export function bindReflectionSemanticDataOperationPort(input: Readonly<{
  policy: DataOperationPolicyBinding;
  work: DurableSleepWorkPort;
  ordinary: DurableSleepSemanticPort;
  /** Shared provider dispatch consumes already prepared independent questions.
   * Installed with the complete protected path; it must not reopen content. */
  invokePreparedOrganizerBatch?: NonNullable<DurableSleepSemanticPort["invokeOrganizerBatch"]>;
  protected: Pick<DurableSleepSemanticPort, "ensureAuthority"> & Readonly<{
    /** Present only when the complete protected semantic path is installed. */
    semantic?: DurableSleepSemanticPort;
    /** Proves no semantic execution began and atomically cancels pending grant attempts. */
    releaseWaitingSemantic?(claim: DurableSleepClaim, stage: "search_projection" | "organization",
      failure?: DataOperationFailureClass): Promise<boolean>;
    maintain?: (input: Readonly<{limit: number; signal?: AbortSignal}>) => Promise<void>;
  }>;
}>): ReflectionSemanticDataOperationPorts {
  const claims = new WeakMap<DurableSleepClaim, ClaimSelection>();
  const readyQuestions = new WeakSet<DurableSleepClaim>();
  const attempts = new WeakMap<DurableSleepClaim, DurableSleepOrganizationAttempt>();

  const selectionFor = (claim: DurableSleepClaim): ClaimSelection => {
    const selection = claims.get(claim);
    if (selection === undefined) {
      throw new ClassifiedDataOperationError(
        "authority",
        "Reflection claim was not issued by this data operation",
      );
    }
    return selection;
  };

  const revalidate = async (
    selection: ClaimSelection,
    signal?: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal);
    await input.policy.revalidate(selection.snapshot.revalidationToken);
    throwIfAborted(signal);
  };

  const useSelection = async <Value>(
    selection: ClaimSelection,
    signal: AbortSignal | undefined,
    use: () => Promise<Value>,
  ): Promise<Value> => {
    await revalidate(selection, signal);
    const value = await use();
    await revalidate(selection, signal);
    return value;
  };

  const useClaim = async <Value>(
    claim: DurableSleepClaim,
    requiredStage: DurableSleepStage,
    signal: AbortSignal | undefined,
    use: (selection: ClaimSelection) => Promise<Value>,
  ): Promise<Value> => {
    const selection = selectionFor(claim);
    if (STAGE_RANK[requiredStage] > STAGE_RANK[selection.maximumStage]) {
      if (selection.executionRepresentation === "protected") {
        unsupportedProtectedOperation();
      }
      throw invalidClaimResult("semantic method exceeds claim ceiling");
    }
    return useSelection(selection, signal, () => use(selection));
  };

  const work: DurableSleepWorkPort = Object.freeze({
    async claimNext(signal?: AbortSignal, options?: DurableSleepClaimOptions) {
      throwIfAborted(signal);
      const snapshot = snapshotCopy(await input.policy.resolve());
      throwIfAborted(signal);
      const admission = admissionFor(snapshot, input.protected.semantic !== undefined);
      const requestedMaximumStage = claimMaximumStage(options);
      await input.policy.revalidate(snapshot.revalidationToken);
      throwIfAborted(signal);
      const result = await input.work.claimNext(signal, {
        ...options,
        maximumStage: requestedMaximumStage,
        representationAdmission: admission,
      });
      try {
        await input.policy.revalidate(snapshot.revalidationToken);
        throwIfAborted(signal);
        if (result.status === "empty") return result;
        const validated = validateClaimResult(
          result,
          admission,
          requestedMaximumStage,
        );
        claims.set(result.claim, Object.freeze({
          snapshot,
          ...validated,
        }));
        return result;
      } catch (error) {
        if (result.status === "claimed") {
          try {
            await input.work.pause({ claim: result.claim });
          } catch {
            // Preserve the policy or adapter-integrity failure that made the
            // claim unusable; the durable lease remains independently bounded.
          }
        }
        throw error;
      }
    },
    checkpoint: input.work.checkpoint.bind(input.work),
    pause: input.work.pause.bind(input.work),
    complete: (operation: Parameters<DurableSleepWorkPort["complete"]>[0]) => {
      const reason = selectionFor(operation.claim).ordinaryFallbackReason;
      return input.work.complete({...operation, ...(reason === undefined ? {} : {ordinaryFallbackReason: reason})});
    },
    defer: input.work.defer.bind(input.work),
    enqueue: input.work.enqueue.bind(input.work),
  });

  const useSemantic = async <Value>(
    claim: DurableSleepClaim,
    requiredStage: DurableSleepStage,
    signal: AbortSignal | undefined,
    use: (port: DurableSleepSemanticPort) => Promise<Value>,
  ): Promise<Value> => useClaim(
    claim,
    requiredStage,
    signal,
    (selection) => {
      const port = selection.executionRepresentation === "protected" ? input.protected.semantic : input.ordinary;
      if (port === undefined) unsupportedProtectedOperation();
      return use(port);
    },
  );

  const tryOrdinaryFallback = async (claim: DurableSleepClaim, stage: "search_projection" | "organization",
    signal?: AbortSignal, failure?: DataOperationFailureClass): Promise<boolean> => {
    const selection = selectionFor(claim);
    if (selection.executionRepresentation !== "protected" || readyQuestions.has(claim)
      || !selectLiveEncryptionRepresentationPolicy(selection.snapshot.policy).allowOrdinaryFallback
      || failure !== undefined && !fallbackEligible(failure)
      || input.protected.releaseWaitingSemantic === undefined) return false;
    await revalidate(selection, signal);
    const previous = attempts.get(claim);
    if (previous !== undefined && input.ordinary.openOrganizationAttempt === undefined) return false;
    // Close the whole question before selecting an ordinary operation. No input
    // substitution or fallback after a prepared question/provider invocation.
    await previous?.close("unavailable");
    if (!await input.protected.releaseWaitingSemantic(claim, stage, failure)) return false;
    await revalidate(selection, signal);
    const reason = failure !== undefined && fallbackEligible(failure) ? failure : "key_waiting";
    claims.set(claim, Object.freeze({...selection, executionRepresentation: "ordinary", ordinaryFallbackReason: reason}));
    if (previous !== undefined) attempts.set(claim, await input.ordinary.openOrganizationAttempt!(claim, signal));
    return true;
  };

  const semantic: DurableSleepSemanticPort = {
    async ensureAuthority(claim, signal) {
      return useClaim(claim, "authority_projection", signal, (selection) =>
        selection.executionRepresentation === "protected"
          ? input.protected.ensureAuthority(claim, signal)
          : input.ordinary.ensureAuthority(claim, signal));
    },
    async ensureSearchProjection(claim, signal) {
      try {
        const result = await useSemantic(claim, "search_projection", signal, port => port.ensureSearchProjection(claim, signal));
        if (result.status !== "waiting" || !await tryOrdinaryFallback(claim, "search_projection", signal)) return result;
      } catch (error) {
        if (!await tryOrdinaryFallback(claim, "search_projection", signal, classifyDataOperationFailure(error))) throw error;
      }
      return useSemantic(claim, "search_projection", signal, port => port.ensureSearchProjection(claim, signal));
    },
    async loadOrganizerView(claim, signal) {
      readyQuestions.delete(claim);
      let result: Awaited<ReturnType<DurableSleepSemanticPort["loadOrganizerView"]>>;
      try {
        result = await useSemantic(claim, "organization", signal, port => port.loadOrganizerView(claim, signal));
        if (result.status === "waiting" && await tryOrdinaryFallback(claim, "organization", signal)) {
          result = await useSemantic(claim, "organization", signal, port => port.loadOrganizerView(claim, signal));
        }
      } catch (error) {
        if (!await tryOrdinaryFallback(claim, "organization", signal, classifyDataOperationFailure(error))) throw error;
        result = await useSemantic(claim, "organization", signal, port => port.loadOrganizerView(claim, signal));
      }
      if (result.status === "ready") readyQuestions.add(claim);
      return result;
    },
    async resolveParentConflict(operation) {
      return useSemantic(
        operation.claim,
        "organization",
        operation.signal,
        port => port.resolveParentConflict(operation),
      );
    },
    async resolveDependencyLoss(operation) {
      try {
        const result = await useSemantic(operation.claim, "organization", operation.signal, port => port.resolveDependencyLoss(operation));
        if (result.status !== "waiting" || !await tryOrdinaryFallback(operation.claim, "organization", operation.signal)) return result;
      } catch (error) {
        if (!await tryOrdinaryFallback(operation.claim, "organization", operation.signal, classifyDataOperationFailure(error))) throw error;
      }
      return useSemantic(operation.claim, "organization", operation.signal, port => port.resolveDependencyLoss(operation));
    },
    async invokeOrganizer(claim, prompt, signal) {
      if (input.invokePreparedOrganizerBatch !== undefined) {
        return invokePrepared([claim], prompt, signal);
      }
      return useSemantic(claim, "organization", signal, port =>
        port.invokeOrganizer(claim, prompt, signal));
    },
    async applyProposal(operation) {
      return useSemantic(
        operation.claim,
        "organization",
        operation.signal,
        port => port.applyProposal(operation),
      );
    },
    async modelLaneReadiness(signal) {
      throwIfAborted(signal);
      const snapshot = snapshotCopy(await input.policy.resolve());
      throwIfAborted(signal);
      const admission = admissionFor(snapshot, input.protected.semantic !== undefined);
      await input.policy.revalidate(snapshot.revalidationToken);
      throwIfAborted(signal);
      const port = admission.ordinary === "none" ? input.protected.semantic : input.ordinary;
      const readiness = port?.modelLaneReadiness === undefined
        ? { status: "ready" as const }
        : await port.modelLaneReadiness(signal);
      await input.policy.revalidate(snapshot.revalidationToken);
      throwIfAborted(signal);
      return readiness;
    },
  };

  if (input.ordinary.openOrganizationAttempt !== undefined || input.protected.semantic?.openOrganizationAttempt !== undefined) {
    semantic.openOrganizationAttempt = async (claim, signal) => {
      let opened: DurableSleepOrganizationAttempt | undefined;
      let attempt: DurableSleepOrganizationAttempt;
      try {
        attempt = await useSemantic(
          claim,
          "organization",
          signal,
          async port => {
            if (port.openOrganizationAttempt === undefined) unsupportedProtectedOperation();
            opened = await port.openOrganizationAttempt(claim, signal);
            return opened;
          },
        );
      } catch (error) {
        // A policy change or cancellation after opening must still release the
        // lifetime. Cleanup never requires permission to access new content.
        try { await opened?.close("unavailable"); } catch { /* Preserve admission failure. */ }
        throw error;
      }
      attempts.set(claim, attempt);
      const currentAttempt = () => {const current = attempts.get(claim); if (current === undefined) throw invalidClaimResult("Organization attempt is closed"); return current;};
      return Object.freeze({
        assertCurrent: () => useSelection(selectionFor(claim), signal, () => currentAttempt().assertCurrent()),
        publish: <Value>(publish: () => Promise<Value>) => useSelection(
          selectionFor(claim), signal, () => currentAttempt().publish(() => useSelection(selectionFor(claim), signal, publish)),
        ),
        close: (outcome) => {
          readyQuestions.delete(claim);
          const current = attempts.get(claim); attempts.delete(claim);
          return current?.close(outcome) ?? Promise.resolve();
        },
      } satisfies DurableSleepOrganizationAttempt);
    };
  }

  async function invokePrepared(batch: readonly DurableSleepClaim[], prompt: string, signal?: AbortSignal): Promise<string> {
    if (batch.length === 0 || new Set(batch).size !== batch.length) {
      throw invalidClaimResult("Prepared Organizer batch is empty or duplicated");
    }
    const selections = batch.map(selectionFor);
    const token = selections[0]!.snapshot.revalidationToken;
    for (const [index, selection] of selections.entries()) {
      if (!readyQuestions.has(batch[index]!) || selection.maximumStage !== "organization"
        || selection.snapshot.revalidationToken !== token) {
        throw invalidClaimResult("Organizer question is not ready under the current policy");
      }
      await revalidate(selection, signal);
      const attempt = attempts.get(batch[index]!);
      if (selection.executionRepresentation === "protected" && attempt === undefined) {
        throw invalidClaimResult("Protected Organizer question has no live grant lifetime");
      }
      await attempt?.assertCurrent();
    }
    const result = await input.invokePreparedOrganizerBatch!(batch, prompt, signal);
    for (const selection of selections) await revalidate(selection, signal);
    return result;
  }

  if (input.invokePreparedOrganizerBatch !== undefined || input.ordinary.invokeOrganizerBatch !== undefined || input.protected.semantic?.invokeOrganizerBatch !== undefined) {
    semantic.invokeOrganizerBatch = async (batch, prompt, signal) => {
      if (input.invokePreparedOrganizerBatch !== undefined) return invokePrepared(batch, prompt, signal);
      if (batch.length === 0) {
        throw invalidClaimResult("Organizer batch is empty");
      }
      const selections = batch.map((claim) => selectionFor(claim));
      if (new Set(batch).size !== batch.length) {
        throw invalidClaimResult("Organizer batch contains a duplicate claim");
      }
      const representation = selections[0]!.executionRepresentation;
      const port = representation === "protected" ? input.protected.semantic : input.ordinary;
      if (port?.invokeOrganizerBatch === undefined) unsupportedProtectedOperation();
      const token = selections[0]!.snapshot.revalidationToken;
      if (selections.some((selection) =>
        selection.snapshot.revalidationToken !== token
        || selection.executionRepresentation !== representation
        || selection.maximumStage !== "organization")) {
        throw invalidClaimResult("Organizer batch mixes policy or representation");
      }
      for (const selection of selections) await revalidate(selection, signal);
      const value = await port.invokeOrganizerBatch(
        batch,
        prompt,
        signal,
      );
      for (const selection of selections) await revalidate(selection, signal);
      return value;
    };
  }

  return Object.freeze({ work, semantic: Object.freeze(semantic),
    async maintain(operation: Readonly<{limit: number; signal?: AbortSignal}>) {
      throwIfAborted(operation.signal);
      const snapshot = snapshotCopy(await input.policy.resolve());
      await revalidate({snapshot, executionRepresentation: "protected", maximumStage: "authority_projection"}, operation.signal);
      if (admissionFor(snapshot, input.protected.semantic !== undefined).protected === "none") return;
      await input.protected.maintain?.(operation);
      await input.policy.revalidate(snapshot.revalidationToken);
      throwIfAborted(operation.signal);
    },
  });
}

/** Bootstrap uses the same Lattice admission policy as claims. */
export async function resolveReflectionSemanticStageAdmission(
  policy: DataOperationPolicyBinding,
  signal?: AbortSignal,
  semanticAvailable = false,
): Promise<Readonly<{maximumStage: DurableSleepStage}>> {
  throwIfAborted(signal);
  const snapshot = snapshotCopy(await policy.resolve());
  const admission = admissionFor(snapshot, semanticAvailable);
  await policy.revalidate(snapshot.revalidationToken);
  throwIfAborted(signal);
  return {maximumStage: admission.ordinary === "none" && admission.protected !== "organization" ? "authority_projection" : "organization"};
}
