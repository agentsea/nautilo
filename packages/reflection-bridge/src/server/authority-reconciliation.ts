import {
  advanceAuthorityAlternatives,
  classifyAuthorityRepresentation,
} from "@nautilo/reflection/authority";
import type {
  AuthorityLeafAlternatives,
  EffectiveAudienceAlternative,
} from "@nautilo/reflection/authority";

import type {
  AuthorityReconciliationPorts,
  AuthorityReconciliationRequest,
  AuthorityReconciliationResult,
  AuthorityProjectionCommitmentPort,
  ClaimedAuthorityReconciliation,
  MaterializedAuthorityAlternative,
  CurrentAuthorityProjection,
} from "./authority-contracts";

interface ReconciliationCheckpoint {
  readonly version: 1;
  readonly recordRef: string;
  readonly projectionGeneration: number;
  readonly terminalAuthorityLeafHandles: readonly string[];
  readonly resolvedLeaves: readonly AuthorityLeafAlternatives[];
  readonly nextLeafIndex: number;
  readonly algebraContinuation?: string;
}

const MAX_SEALED_CHECKPOINT_BYTES = 256 * 1024;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isResolvedAlternative(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const humanRefs = "humanRefs" in value ? value.humanRefs : undefined;
  const publicBoundary = "includesPublicBoundary" in value
    ? value.includesPublicBoundary
    : undefined;
  return isStringArray(humanRefs)
    && new Set(humanRefs).size === humanRefs.length
    && typeof publicBoundary === "boolean";
}

function isResolvedLeaf(value: unknown): value is AuthorityLeafAlternatives {
  return typeof value === "object"
    && value !== null
    && "terminalAuthorityLeafHandle" in value
    && typeof value.terminalAuthorityLeafHandle === "string"
    && value.terminalAuthorityLeafHandle.length > 0
    && "alternatives" in value
    && Array.isArray(value.alternatives)
    && value.alternatives.every(isResolvedAlternative);
}

function parseCheckpoint(
  value: string,
  recordRef: string,
  projectionGeneration: number,
  commitments: AuthorityProjectionCommitmentPort,
): ReconciliationCheckpoint {
  let parsed: unknown;
  try {
    if (value.length > Math.ceil(MAX_SEALED_CHECKPOINT_BYTES * 4 / 3) + 4) {
      throw new TypeError("Authority reconciliation checkpoint is invalid");
    }
    const sealed = Buffer.from(value, "base64url");
    if (
      sealed.byteLength > MAX_SEALED_CHECKPOINT_BYTES
      || Buffer.from(sealed).toString("base64url") !== value
    ) throw new TypeError("Authority reconciliation checkpoint is invalid");
    parsed = JSON.parse(commitments.openSealedCheckpoint(sealed));
  } catch {
    throw new TypeError("Authority reconciliation checkpoint is invalid");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("version" in parsed)
    || parsed.version !== 1
    || !("recordRef" in parsed)
    || parsed.recordRef !== recordRef
    || !("projectionGeneration" in parsed)
    || parsed.projectionGeneration !== projectionGeneration
    || !("terminalAuthorityLeafHandles" in parsed)
    || !isStringArray(parsed.terminalAuthorityLeafHandles)
    || !("resolvedLeaves" in parsed)
    || !Array.isArray(parsed.resolvedLeaves)
    || !parsed.resolvedLeaves.every(isResolvedLeaf)
    || !("nextLeafIndex" in parsed)
    || !Number.isSafeInteger(parsed.nextLeafIndex)
    || (parsed.nextLeafIndex as number) < 0
    || (parsed.nextLeafIndex as number) > parsed.terminalAuthorityLeafHandles.length
    || parsed.resolvedLeaves.length !== parsed.nextLeafIndex
    || parsed.resolvedLeaves.some((leaf, index) =>
      leaf.terminalAuthorityLeafHandle
        !== (parsed.terminalAuthorityLeafHandles as string[])[index])
    || ("algebraContinuation" in parsed
      && parsed.algebraContinuation !== undefined
      && typeof parsed.algebraContinuation !== "string")
  ) throw new TypeError("Authority reconciliation checkpoint is invalid");
  return parsed as ReconciliationCheckpoint;
}

/** Opens and validates only the opaque continuation owned by an exact receipt lease. */
export function readAuthorityReconciliationContinuation(
  claim: Pick<
    ClaimedAuthorityReconciliation,
    "recordRef" | "expectedProjectionGeneration" | "sealedCheckpoint"
  >,
  commitments: AuthorityProjectionCommitmentPort,
): string | undefined {
  if (claim.sealedCheckpoint === undefined) return undefined;
  const continuation = Buffer.from(claim.sealedCheckpoint).toString("base64url");
  parseCheckpoint(
    continuation,
    claim.recordRef,
    claim.expectedProjectionGeneration,
    commitments,
  );
  return continuation;
}

/** Validates a paused result before returning its receipt-owned sealed bytes. */
export function sealedAuthorityReconciliationContinuation(
  input: Readonly<{
    recordRef: string;
    expectedProjectionGeneration: number;
    continuation: string;
  }>,
  commitments: AuthorityProjectionCommitmentPort,
): Uint8Array {
  parseCheckpoint(
    input.continuation,
    input.recordRef,
    input.expectedProjectionGeneration,
    commitments,
  );
  return Uint8Array.from(Buffer.from(input.continuation, "base64url"));
}

function encodeCheckpoint(
  checkpoint: ReconciliationCheckpoint,
  ports: AuthorityReconciliationPorts,
): string {
  const sealed = ports.commitments.sealCheckpoint(JSON.stringify(checkpoint));
  if (sealed.byteLength > MAX_SEALED_CHECKPOINT_BYTES) {
    throw new RangeError("Authority reconciliation checkpoint exceeds the sealed bound");
  }
  return Buffer.from(sealed).toString("base64url");
}

async function materializeAlternatives(
  alternatives: readonly EffectiveAudienceAlternative[],
  ports: AuthorityReconciliationPorts,
): Promise<readonly MaterializedAuthorityAlternative[]> {
  const materialized: MaterializedAuthorityAlternative[] = [];
  for (const alternative of alternatives) {
    const access = await ports.accessAudiences.resolveOrCreateExact(alternative.humanRefs);
    if (JSON.stringify(access.humanRefs) !== JSON.stringify(alternative.humanRefs)) {
      throw new Error("Record access Room exact audience mismatch");
    }
    materialized.push({
      accessNamespaceId: access.accessNamespaceId,
      includesPublicBoundary: alternative.includesPublicBoundary,
      alternativeCommitment: ports.commitments.commitAlternative(alternative),
    });
  }
  return materialized;
}

/** Crypto publication and product attachment stay separate, but the fence never escapes its live gate. */
async function applyMaterializedAuthority(
  request: AuthorityReconciliationRequest,
  ports: AuthorityReconciliationPorts,
  current: CurrentAuthorityProjection,
  expectedProjectionGeneration: number,
  materialized: readonly MaterializedAuthorityAlternative[],
  audienceSetCommitment: Uint8Array,
  waitingCheckpoint?: ReconciliationCheckpoint,
): Promise<AuthorityReconciliationResult> {
  const projection = {recordRef: request.recordRef, expectedProjectionGeneration,
    sourceChangeGeneration: request.sourceChangeGeneration, terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
    audienceSetCommitment, alternatives: materialized};
  if (ports.selection.selectedRepresentation === "ordinary") {
    const applied = await ports.projections.applyProjectionCas(projection);
    return applied === "applied" ? {status: "applied", projectionGeneration: expectedProjectionGeneration + 1,
      alternativeCount: materialized.length, formerCryptoRetirementPending: false} : {status: applied};
  }
  const republisher = ports.protectedRepublisher;
  if (republisher === undefined) throw new TypeError("Protected authority transition requires republisher");
  const existing = await ports.projections.readProtectedReconciliation({recordRef: request.recordRef, sourceChangeGeneration: request.sourceChangeGeneration});
  if (existing?.state === "quarantined" || existing?.targetCryptoRetiredAt != null) return {status: "stale"};
  const targetRepresentationGeneration = existing?.targetRepresentationGeneration ?? current.representationGeneration + 1;
  const access = materialized.map(entry => entry.accessNamespaceId).sort();
  let invoked = false;
  let active = true;
  let attachment: "applied" | "stale" | "blocked" | undefined;
  const published = await republisher.republishExact({recordRef: request.recordRef,
    expectedRepresentationGeneration: targetRepresentationGeneration - 1, targetRepresentationGeneration,
    sourceChangeGeneration: request.sourceChangeGeneration, expectedProjectionGeneration,
    exactAccessNamespaceIds: access, workBindingRef: request.workBindingRef,
    attach: async ({cryptoObjectId, authorizeCommit, projections}) => {
      if (!active || invoked) throw new Error("Protected authority attachment callback is scoped and one-use");
      invoked = true;
      const recorded = await projections.recordProtectedCryptoComplete({recordRef: request.recordRef, expectedProjectionGeneration,
        sourceChangeGeneration: request.sourceChangeGeneration, targetRepresentationGeneration, targetCryptoObjectId: cryptoObjectId,
        targetAccessNamespaceIds: access, targetAudienceSetCommitment: audienceSetCommitment});
      attachment = recorded === "blocked" || recorded === "stale" ? recorded
        : await projections.applyProjectionCas({...projection, protectedTransition: {representationGeneration: targetRepresentationGeneration, cryptoObjectId, authorizeCommit}});
      return attachment;
    },
  }).finally(() => { active = false; });
  if (published.status === "unavailable") return {status: "paused", continuation: encodeCheckpoint(waitingCheckpoint ?? {version: 1,
    recordRef: request.recordRef, projectionGeneration: current.projectionGeneration, terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
    resolvedLeaves: [], nextLeafIndex: 0}, ports)};
  if (!invoked || attachment === undefined || published.attachment !== attachment) throw new Error("Protected authority publication skipped its scoped attachment");
  if (attachment !== "applied") return {status: attachment};
  const receipt = await ports.projections.readProtectedReconciliation({recordRef: request.recordRef, sourceChangeGeneration: request.sourceChangeGeneration});
  let formerCryptoRetirementPending = receipt?.formerCryptoObjectId !== null && receipt?.formerCryptoObjectId !== undefined && receipt.formerCryptoRetiredAt === null;
  if (formerCryptoRetirementPending && receipt?.formerCryptoObjectId !== null && receipt?.formerCryptoObjectId !== undefined) {
    try {
      const former = receipt.formerCryptoObjectId;
      const result = await ports.projections.withProtectedRetirementFence({recordRef: request.recordRef, sourceChangeGeneration: request.sourceChangeGeneration,
        cryptoObjectId: former, kind: "former"}, () => republisher.retire(former));
      formerCryptoRetirementPending = result === "conflict";
    } catch {formerCryptoRetirementPending = true;}
  }
  return {status: "applied", projectionGeneration: expectedProjectionGeneration + 1,
    alternativeCount: materialized.length, formerCryptoRetirementPending};
}

/** Deterministic dormant ordinary/protected authority transition. */
export async function reconcileRecordAuthority(
  request: AuthorityReconciliationRequest,
  ports: AuthorityReconciliationPorts,
): Promise<AuthorityReconciliationResult> {
  if (!Number.isSafeInteger(request.maxOperations) || request.maxOperations < 1) {
    throw new RangeError("Authority reconciliation budget requires at least one operation");
  }
  if (
    !Number.isSafeInteger(ports.selection.migrationGeneration)
    || ports.selection.migrationGeneration < 1
  ) throw new TypeError("Authority reconciliation selection is invalid");
  const current = await ports.projections.readCurrent(request.recordRef);
  if (current === null) return { status: "stale" };
  const immediate = await ports.projections.isImmediatelyBlocked({
    recordRef: request.recordRef,
    terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
  });
  if (immediate !== null) return { status: "blocked" };
  if (request.sourceChangeGeneration < current.sourceChangeGeneration) {
    return { status: "stale" };
  }
  if (request.sourceChangeGeneration === current.sourceChangeGeneration && current.processingState === "current"
    && ports.selection.selectedRepresentation === "protected") {
    if (current.protectedAuthorityCurrent === true) return {status: "applied", projectionGeneration: current.projectionGeneration,
      alternativeCount: current.alternatives.length, formerCryptoRetirementPending: false};
    const receipt = await ports.projections.readProtectedReconciliation({recordRef: request.recordRef, sourceChangeGeneration: request.sourceChangeGeneration});
    if (receipt === null || receipt.completedAt === null || receipt.expectedProjectionGeneration + 1 !== current.projectionGeneration
      || current.audienceSetCommitment === undefined) return {status: "stale"};
    return applyMaterializedAuthority(request, ports, current, receipt.expectedProjectionGeneration, current.alternatives, current.audienceSetCommitment);
  }
  if (
    request.sourceChangeGeneration === current.sourceChangeGeneration
    && current.processingState !== "dirty"
    && current.processingState !== "reconciling"
  ) return { status: "stale" };
  const initial: ReconciliationCheckpoint = {
    version: 1,
    recordRef: request.recordRef,
    projectionGeneration: current.projectionGeneration,
    terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
    resolvedLeaves: [],
    nextLeafIndex: 0,
  };
  let checkpoint = request.continuation === undefined
    ? initial
    : parseCheckpoint(
        request.continuation,
        request.recordRef,
        current.projectionGeneration,
        ports.commitments,
      );

  let work = 0;
  const resolvedLeaves = [...checkpoint.resolvedLeaves];
  while (
    checkpoint.nextLeafIndex < checkpoint.terminalAuthorityLeafHandles.length
    && work < request.maxOperations
  ) {
    const handle = checkpoint.terminalAuthorityLeafHandles[checkpoint.nextLeafIndex]!;
    const resolved = await ports.sourceAuthority.resolve(handle);
    if (resolved.status === "unavailable") {
      const applied = await ports.projections.applyProjectionCas({
        recordRef: request.recordRef,
        expectedProjectionGeneration: current.projectionGeneration,
        sourceChangeGeneration: request.sourceChangeGeneration,
        terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
        audienceSetCommitment: ports.commitments.commitSet([]),
        alternatives: [],
        unavailableReason: "source_unavailable",
      });
      return applied === "applied"
        ? { status: "unavailable", reason: "source_unavailable" }
        : { status: applied === "blocked" ? "blocked" : "stale" };
    }
    if (resolved.leaf.terminalAuthorityLeafHandle !== handle) {
      throw new Error("Canonical source authority handle mismatch");
    }
    resolvedLeaves.push(resolved.leaf);
    checkpoint = {
      ...checkpoint,
      resolvedLeaves,
      nextLeafIndex: checkpoint.nextLeafIndex + 1,
    };
    work += 1;
  }
  if (checkpoint.nextLeafIndex < checkpoint.terminalAuthorityLeafHandles.length) {
    return { status: "paused", continuation: encodeCheckpoint(checkpoint, ports) };
  }
  if (work >= request.maxOperations && checkpoint.algebraContinuation === undefined) {
    return { status: "paused", continuation: encodeCheckpoint(checkpoint, ports) };
  }

  const algebra = advanceAuthorityAlternatives({
    leaves: resolvedLeaves,
    budget: { maxOperations: Math.max(1, request.maxOperations - work) },
    ...(checkpoint.algebraContinuation === undefined
      ? {}
      : { continuation: checkpoint.algebraContinuation }),
  });
  if (algebra.status === "paused") {
    return {
      status: "paused",
      continuation: encodeCheckpoint({
        ...checkpoint,
        algebraContinuation: algebra.continuation,
      }, ports),
    };
  }
  if (algebra.outcome.kind === "unavailable") {
    const reason = algebra.outcome.reason;
    const applied = await ports.projections.applyProjectionCas({
      recordRef: request.recordRef,
      expectedProjectionGeneration: current.projectionGeneration,
      sourceChangeGeneration: request.sourceChangeGeneration,
      terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
      audienceSetCommitment: ports.commitments.commitSet([]),
      alternatives: [],
      unavailableReason: reason,
    });
    return applied === "applied"
      ? { status: "unavailable", reason }
      : { status: applied === "blocked" ? "blocked" : "stale" };
  }

  const logicalAlternatives = algebra.outcome.alternatives;
  const capacity = classifyAuthorityRepresentation(logicalAlternatives.length);
  if (capacity.kind === "unavailable") {
    const repairState = JSON.stringify({
      ...checkpoint,
      algebraContinuation: JSON.stringify({ completeAlternatives: logicalAlternatives }),
    });
    const applied = await ports.projections.applyProjectionCas({
      recordRef: request.recordRef,
      expectedProjectionGeneration: current.projectionGeneration,
      sourceChangeGeneration: request.sourceChangeGeneration,
      terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
      audienceSetCommitment: ports.commitments.commitSet(logicalAlternatives),
      alternatives: [],
      unavailableReason: "representation_capacity_exceeded",
      sealedRepairState: ports.commitments.sealCheckpoint(repairState),
    });
    return applied === "applied"
      ? { status: "unavailable", reason: "representation_capacity_exceeded" }
      : { status: applied === "blocked" ? "blocked" : "stale" };
  }

  const materialized = await materializeAlternatives(logicalAlternatives, ports);
  return applyMaterializedAuthority(request, ports, current, current.projectionGeneration, materialized,
    ports.commitments.commitSet(logicalAlternatives), checkpoint);
}
