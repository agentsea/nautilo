import { createHmac } from "node:crypto";
import type { CapabilityFundingSession, ForegroundChatFundingSession } from "@nautilo/agent";
import type { OrganizerEvidenceBudget } from "@nautilo/reflection";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import { classifyPersonalMemoryEvidence, assertSamePersonalMemoryEvidence, PersonalMemoryEvidenceChangedError,
  type PersonalMemoryEvidencePort } from "@nautilo/reflection-bridge/server";
import { parseMemoryOperationBinding, type MemoryCapabilityRole, type MemoryOperationBinding } from "@nautilo/types";
import { createCapabilityFundingSession } from "./capability-funding";

export interface OpenMemoryOperationInput {
  readonly role: MemoryCapabilityRole;
  readonly operationKey: string;
  readonly dependencies: () => Promise<readonly DurableModelExposureDependency[] | undefined>;
  readonly ports: PersonalMemoryEvidencePort;
  readonly readHistoricalOrganizerPredecessor?: PersonalMemoryEvidencePort["readRecord"];
  readonly readRetiredJournalPredecessor?: PersonalMemoryEvidencePort["readRecord"];
  readonly budget: OrganizerEvidenceBudget;
  readonly commitmentKey: Uint8Array;
  /** A replacement compaction must qualify for service funding on every recheck. */
  readonly requireCurrentServicePayer?: boolean;
  /** Reflection batches retain one accepted payer/model across proven claim subsets. */
  readonly bindingScope?: "exact_operation" | "claim_family";
  /** CAS owner normally returns its binding; explicit manual service recovery may request a trusted rebind. */
  readonly bind: (resolve: (
    legacyServiceModelId?: string,
    previousServiceBinding?: Extract<MemoryOperationBinding, { kind: "service" }>,
  ) => Promise<MemoryOperationBinding>) => Promise<MemoryOperationBinding>;
  readonly assertCurrent: () => Promise<void>;
  readonly resolveServiceModel: () => string;
  readonly openHumanSession?: (humanUserId: string, recheck: () => Promise<void>) => CapabilityFundingSession;
}
export interface AdmittedMemoryOperation {
  readonly binding: MemoryOperationBinding;
  readonly modelId: string;
  readonly humanUserId: string | null;
  readonly fundingSession?: ForegroundChatFundingSession;
  assertCurrent(): Promise<void>;
  assertExposure(dependencies: readonly DurableModelExposureDependency[] | undefined): Promise<void>;
}

/** Explicit manual service recovery proved that its accepted evidence changed. */
export class MemoryReviewRecoveryEvidenceChangedError extends PersonalMemoryEvidenceChangedError {
  override name = "MemoryReviewRecoveryEvidenceChangedError";
}

type HistoricalMemoryEvidenceReaders = Pick<
  OpenMemoryOperationInput,
  "readHistoricalOrganizerPredecessor" | "readRetiredJournalPredecessor"
>;

/** Protected questions own their exact evidence port and never cross-open ordinary history. */
export function ordinaryHistoricalMemoryEvidenceReaders(
  protectedEvidence: PersonalMemoryEvidencePort | undefined,
  readers: HistoricalMemoryEvidenceReaders,
): Partial<HistoricalMemoryEvidenceReaders> {
  return protectedEvidence === undefined ? readers : {};
}

/** Personal eligibility is proved from actual inputs, never a Room owner. */
export async function openMemoryOperation(input: OpenMemoryOperationInput): Promise<AdmittedMemoryOperation> {
  if (input.commitmentKey.byteLength < 32) throw new TypeError("Memory commitment key is unavailable");
  await input.assertCurrent();
  const dependencies = await input.dependencies();
  const classify = async (current: readonly DurableModelExposureDependency[] | undefined) => {
    const payer = await classifyPersonalMemoryEvidence({
      dependencies: current,
      ports: input.ports,
      budget: input.budget,
      ...(input.readHistoricalOrganizerPredecessor === undefined ? {} : {
        readHistoricalOrganizerPredecessor:
          input.readHistoricalOrganizerPredecessor,
      }),
      ...(input.readRetiredJournalPredecessor === undefined ? {} : {
        readRetiredJournalPredecessor: input.readRetiredJournalPredecessor,
      }),
    });
    if (input.requireCurrentServicePayer && (!current?.length || payer.kind !== "service")) {
      throw new PersonalMemoryEvidenceChangedError();
    }
    return payer;
  };
  const initial = await classify(dependencies);
  const commitment = (current: readonly DurableModelExposureDependency[] | undefined): string =>
    `hmac-sha256:${createHmac("sha256", input.commitmentKey).update(JSON.stringify([
      "nautilo/memory-operation-input/v1", input.operationKey, input.role, current ?? null,
    ])).digest("base64url")}`;
  const inputCommitment = commitment(dependencies);
  const openSession = input.openHumanSession ?? createCapabilityFundingSession;
  let manualServiceRecovery = false;
  let reboundServiceOperation = false;
  const recheckEvidence = async () => {
    await input.assertCurrent();
    const current = await input.dependencies();
    try {
      if (commitment(current) !== inputCommitment) throw new PersonalMemoryEvidenceChangedError();
      const payer = await classify(current);
      assertSamePersonalMemoryEvidence(initial, payer);
      if (reboundServiceOperation && (!current?.length || payer.kind !== "service")) {
        throw new PersonalMemoryEvidenceChangedError();
      }
    } catch (error) {
      if (manualServiceRecovery && error instanceof PersonalMemoryEvidenceChangedError) {
        throw new MemoryReviewRecoveryEvidenceChangedError();
      }
      throw error;
    }
  };
  let resolverEvaluated = false;
  const binding = parseMemoryOperationBinding(await input.bind(async (legacyServiceModelId, previousServiceBinding) => {
    resolverEvaluated = true;
    if (previousServiceBinding !== undefined) {
      manualServiceRecovery = true;
      if (previousServiceBinding.role !== input.role) throw new MemoryReviewRecoveryEvidenceChangedError();
      if (previousServiceBinding.inputCommitment === inputCommitment) return previousServiceBinding;
      if (!dependencies?.length || initial.kind !== "service") throw new MemoryReviewRecoveryEvidenceChangedError();
      reboundServiceOperation = true;
      return { ...previousServiceBinding, inputCommitment };
    }
    if (initial.kind === "service" || legacyServiceModelId !== undefined) return {
      version: 1, kind: "service", role: input.role, modelId: legacyServiceModelId ?? input.resolveServiceModel(), inputCommitment,
    };
    const session = openSession(initial.humanUserId, recheckEvidence);
    const selection = await session.resolveModel(input.role);
    const admitted = await session.openModel(selection.modelId, "memory");
    return { version: 1, kind: "human", role: input.role, modelId: selection.modelId,
      humanUserId: initial.humanUserId, preferenceRevision: selection.preferenceRevision,
      funding: admitted.binding, inputCommitment };
  }));
  if (binding.role !== input.role
    || (binding.inputCommitment !== inputCommitment
      && (input.bindingScope !== "claim_family" || resolverEvaluated))
    || (binding.kind === "human" && (initial.kind !== "human" || initial.humanUserId !== binding.humanUserId))) {
    throw new PersonalMemoryEvidenceChangedError();
  }
  // A previously accepted service operation remains service even if a later
  // producer can prove exclusivity. Only a newly admitted work item may choose.
  const assertCurrent = async () => {
    await recheckEvidence();
    if (binding.kind === "human") assertSamePersonalMemoryEvidence(
      { kind: "human", humanUserId: binding.humanUserId }, await classify(await input.dependencies()));
  };
  const admitted = binding.kind === "human"
    ? await openSession(binding.humanUserId, assertCurrent).openModel(binding.modelId, "memory", binding.funding)
    : undefined;
  return {
    binding, modelId: binding.modelId, humanUserId: binding.kind === "human" ? binding.humanUserId : null,
    ...(admitted === undefined ? {} : { fundingSession: admitted.fundingSession }),
    assertCurrent,
    async assertExposure(exposure) {
      await assertCurrent();
      if (input.requireCurrentServicePayer || reboundServiceOperation || binding.kind === "human") {
        assertSamePersonalMemoryEvidence(initial, await classify(exposure));
      }
    },
  };
}
