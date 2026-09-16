import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  durableEnvelopeToRecordSnapshot,
  type DurableModelExposureDependency,
  type DurableRecordEnvelope,
  type DurableRecordReadPort,
  type DurableSourceDependency,
} from "@nautilo/reflection/durable";
import type {
  OrganizerRecordInput,
  PartitionedOrganizeProposal,
} from "@nautilo/reflection";

import type { RecordRepositorySelection } from "./contracts";
import {
  assertCrossRoomCandidatePlan,
  crossRoomApplicationPlanToken,
  CROSS_ROOM_EXECUTION_PLAN_LIMITS,
  type CrossRoomApplicationPlanToken,
  type CrossRoomCandidatePlan,
  type CrossRoomInputCoordinate,
} from "./cross-room-execution";
import type {
  CrossRoomMemoryCandidate,
  CrossRoomOrganizerCandidate,
  PostgresCrossRoomOrganizerStore,
} from "./postgres-cross-room-organizer-store";
import type {
  CrossRoomOrganizerPartitionPort,
  CrossRoomOrganizerPublicationPlanningResult,
} from "./durable-semantic-composition";

const TOKEN_PREFIX = "cr1";
const TOKEN_AAD = Buffer.from(
  "nautilo-reflection-cross-room-application-plan-v1",
  "utf8",
);

export interface CrossRoomApplicationPlanCodec {
  seal(plan: CrossRoomCandidatePlan): CrossRoomApplicationPlanToken;
  open(token: CrossRoomApplicationPlanToken): CrossRoomCandidatePlan;
}

/** Authenticated, confidential, process-portable bounded plan; no process cache. */
export function createCrossRoomApplicationPlanCodec(
  key: Uint8Array,
): CrossRoomApplicationPlanCodec {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new TypeError("cross-Room application-plan key must contain at least 32 bytes");
  }
  const encryptionKey = createHash("sha256")
    .update("nautilo-reflection-cross-room-application-plan-key-v1", "utf8")
    .update(key)
    .digest();
  const canonicalBase64Url = (value: string): Buffer => {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new TypeError("invalid encoding");
    return decoded;
  };
  const invalid = (): never => {
    throw new TypeError("cross-Room application plan is invalid");
  };
  return Object.freeze({
    seal(plan: CrossRoomCandidatePlan) {
      assertCrossRoomCandidatePlan(plan);
      const plaintext = Buffer.from(JSON.stringify(plan), "utf8");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(TOKEN_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return crossRoomApplicationPlanToken(
        `${TOKEN_PREFIX}.${Buffer.concat([
          nonce,
          cipher.getAuthTag(),
          ciphertext,
        ]).toString("base64url")}`,
      );
    },
    open(token: CrossRoomApplicationPlanToken) {
      try {
        crossRoomApplicationPlanToken(token);
        const fields = token.split(".");
        if (fields.length !== 2 || fields[0] !== TOKEN_PREFIX) return invalid();
        const sealed = canonicalBase64Url(fields[1]!);
        if (sealed.byteLength < 29) return invalid();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          encryptionKey,
          sealed.subarray(0, 12),
        );
        decipher.setAAD(TOKEN_AAD);
        decipher.setAuthTag(sealed.subarray(12, 28));
        const plaintext = Buffer.concat([
          decipher.update(sealed.subarray(28)),
          decipher.final(),
        ]);
        const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
        assertCrossRoomCandidatePlan(parsed as CrossRoomCandidatePlan);
        return parsed as CrossRoomCandidatePlan;
      } catch {
        return invalid();
      }
    },
  });
}

export interface CrossRoomMemoryOpenPort {
  open(input: Readonly<{
    candidate: CrossRoomMemoryCandidate;
    signal?: AbortSignal;
  }>): Promise<
    | {
        readonly status: "available";
        readonly snapshot: OrganizerRecordInput["snapshot"];
        readonly dependency: DurableSourceDependency;
      }
    | { readonly status: "stale" | "unavailable" }
  >;
}

export interface CrossRoomPublicationPlanBuilderPort {
  plan(input: Readonly<{
    applicationPlanToken: CrossRoomApplicationPlanToken;
    candidatePlan: CrossRoomCandidatePlan;
    proposal: PartitionedOrganizeProposal;
    signal?: AbortSignal;
  }>): Promise<CrossRoomOrganizerPublicationPlanningResult>;
  planExposure?(input: Readonly<{
    applicationPlanToken: CrossRoomApplicationPlanToken;
    candidatePlan: CrossRoomCandidatePlan;
    modelExposureDependencies: readonly DurableModelExposureDependency[];
    signal?: AbortSignal;
  }>): Promise<CrossRoomOrganizerPublicationPlanningResult>;
  planDependencyLoss?(input: Readonly<{
    predecessor: DurableRecordEnvelope;
    proposal: Extract<PartitionedOrganizeProposal, { operation: "supersede_parent" }>;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>): Promise<CrossRoomOrganizerPublicationPlanningResult>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateIdentity(candidate: CrossRoomOrganizerCandidate): string {
  return candidate.kind === "record"
    ? `record\0${candidate.recordRef}`
    : `source\0memory\0${candidate.logicalSourceRef}`;
}

function changedCoordinate(
  candidate: Awaited<ReturnType<PostgresCrossRoomOrganizerStore["discover"]>> extends infer R
    ? R extends { status: "available"; changed: infer C } ? C : never
    : never,
): CrossRoomInputCoordinate {
  return {
    kind: "record",
    role: "changed",
    recordRef: candidate.recordRef,
    processingGeneration: candidate.recordProcessingGeneration,
    representationGeneration: candidate.payloadRepresentationGeneration,
    authorityGeneration: candidate.authorityProjectionGeneration,
    read: {
      namespaceRef: candidate.readNamespaceRef,
      bindingRef: candidate.readBindingRef,
    },
  };
}

function inputCoordinate(candidate: CrossRoomOrganizerCandidate): CrossRoomInputCoordinate {
  return candidate.kind === "record"
    ? {
        kind: "record",
        role: "candidate",
        recordRef: candidate.recordRef,
        processingGeneration: candidate.recordProcessingGeneration,
        representationGeneration: candidate.payloadRepresentationGeneration,
        authorityGeneration: candidate.authorityProjectionGeneration,
        read: {
          namespaceRef: candidate.readNamespaceRef,
          bindingRef: candidate.readBindingRef,
        },
      }
    : {
        kind: "source",
        sourceKind: "memory",
        role: "candidate",
        logicalSourceRef: candidate.logicalSourceRef,
        contentGeneration: candidate.contentRevision,
        representationGeneration: candidate.contentRevision + 1,
        authorityGeneration: candidate.authorityNamespaceRefs.length,
        crossRoomFence: {
          memoryRef: candidate.memoryRef,
          embeddingRevision: candidate.embeddingRevision,
          embeddingProvenance: candidate.embeddingProvenance,
          updatedAtCoordinate: candidate.updatedAtCoordinate,
          authorityNamespaceRefs: candidate.authorityNamespaceRefs,
          audience: candidate.audience,
        },
        read: {
          namespaceRef: candidate.readNamespaceRef,
          bindingRef: candidate.readBindingRef,
        },
      };
}

function mapUnavailable(
  reason: "timeout" | "storage_unavailable" | "changed_input_stale" | "topology_capacity_exceeded",
) {
  if (reason === "changed_input_stale") {
    return {
      status: "unavailable" as const,
      failureCode: "projection_unavailable" as const,
      failureDetail: "candidate_projection_stale" as const,
    };
  }
  if (reason === "topology_capacity_exceeded") {
    return {
      status: "unavailable" as const,
      failureCode: "candidate_unavailable" as const,
      failureDetail: "candidate_topology_capacity_exceeded" as const,
    };
  }
  return {
    status: "unavailable" as const,
    failureCode: "candidate_unavailable" as const,
    failureDetail: reason === "timeout"
      ? "candidate_rank_timeout" as const
      : "candidate_rank_storage_unavailable" as const,
  };
}

/** Ordinary selected-mode cross-Room partition over the existing Organizer. */
export class OrdinaryCrossRoomOrganizerPartition
implements CrossRoomOrganizerPartitionPort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    store: PostgresCrossRoomOrganizerStore;
    repository: DurableRecordReadPort;
    memories: CrossRoomMemoryOpenPort;
    codec: CrossRoomApplicationPlanCodec;
    publicationPlans: CrossRoomPublicationPlanBuilderPort;
  }>) {
    if (ports.selection.selectedRepresentation !== "ordinary") {
      throw new TypeError("ordinary cross-Room partition requires ordinary selection");
    }
  }

  async augment(
    input: Parameters<CrossRoomOrganizerPartitionPort["augment"]>[0],
  ): ReturnType<CrossRoomOrganizerPartitionPort["augment"]> {
    const discovered = await this.ports.store.discover({
      embedding: input.queryEmbedding,
      invocationAudience: input.binding.invocationAudience,
      selection: this.ports.selection,
      changedRecordRef: input.changed.recordRef,
      changedPublicationBindingRef: input.binding.publicationBindingRef,
      authorityParentSeeds: input.authorityParentSeeds,
    });
    if (discovered.status === "unavailable") return mapUnavailable(discovered.reason);
    // An empty cross-Room rank is not an empty authority plan. The changed
    // Record and selected same-Room inputs may themselves carry several
    // terminal authority leaves. Keep them on the exact-plan path so derived
    // parents never fall back to the legacy single-leaf publisher.
    const fenced = await this.ports.store.fence({
      selection: this.ports.selection,
      changed: discovered.changed,
      candidates: discovered.candidates,
    });
    if (fenced.status !== "current") {
      return {
        status: "unavailable",
        failureCode: "candidate_unavailable",
        failureDetail: fenced.status === "stale"
          ? "candidate_fence_stale"
          : fenced.reason === "timeout"
            ? "candidate_fence_timeout"
            : "candidate_fence_storage_unavailable",
      };
    }

    const candidates: OrganizerRecordInput[] = [];
    const existingParents: OrganizerRecordInput[] = [];
    for (const candidate of discovered.candidates) {
      if (input.signal?.aborted) {
        return { status: "unavailable", failureCode: "candidate_unavailable" };
      }
      let opened: OrganizerRecordInput;
      if (candidate.kind === "record") {
        const result = await this.ports.repository.read({
          recordRef: candidate.recordRef,
          readBindingRef: candidate.readBindingRef,
        });
        if (
          result.status !== "available"
          || result.record.lifecycle !== "current"
          || result.record.processingGeneration !== candidate.recordProcessingGeneration
        ) {
          return {
            status: "unavailable",
            failureCode: "candidate_unavailable",
            failureDetail: "candidate_record_changed",
          };
        }
        opened = {
          handle: "unused",
          snapshot: durableEnvelopeToRecordSnapshot(result.record),
          dependency: { kind: "record", recordRef: candidate.recordRef },
        };
      } else {
        const result = await this.ports.memories.open({
          candidate,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (result.status !== "available") {
          return {
            status: "unavailable",
            failureCode: "candidate_unavailable",
            failureDetail: result.status === "stale"
              ? "candidate_record_changed"
              : "candidate_selection_invalid",
          };
        }
        opened = {
          handle: "unused",
          snapshot: result.snapshot,
          dependency: { kind: "source", dependency: result.dependency },
        };
      }
      if (
        candidate.kind === "record"
        && candidate.structuralHeight > 0
      ) existingParents.push(opened);
      else candidates.push(opened);
    }

    const inputs = [
      changedCoordinate(discovered.changed),
      ...input.sameRoomPlanInputs,
      ...discovered.candidates.map(inputCoordinate),
    ].filter((coordinate, index, all) => all.findIndex((candidate) =>
      candidate.kind === coordinate.kind
      && (candidate.kind === "record"
        ? coordinate.kind === "record" && candidate.recordRef === coordinate.recordRef
        : coordinate.kind === "source"
          && candidate.logicalSourceRef === coordinate.logicalSourceRef
        )
    ) === index).sort((left, right) => {
      if (left.role !== right.role) return left.role === "changed" ? -1 : 1;
      const leftIdentity = left.kind === "record"
        ? `record\0${left.recordRef}`
        : `source\0${left.logicalSourceRef}`;
      const rightIdentity = right.kind === "record"
        ? `record\0${right.recordRef}`
        : `source\0${right.logicalSourceRef}`;
      return compareStrings(leftIdentity, rightIdentity);
    });
    let plan: CrossRoomCandidatePlan = {
      workRef: input.claim.logicalObjectRef,
      workGeneration: input.claim.generation,
      policyVersion: "candidate-policy-v1",
      inputs,
      commitments: {
        authority: createHash("sha256")
          .update("nautilo-reflection-cross-room-authority-plan-v1\0", "utf8")
          .update(discovered.candidates
            .map((candidate) => `${candidateIdentity(candidate)}:${candidate.audience.humanRefs.length}:${candidate.audience.includesPublicBoundary}`)
            .sort(compareStrings)
            .join("\0"), "utf8")
          .digest("hex"),
        search: `${input.queryEmbedding.provenance.provider}:${input.queryEmbedding.provenance.canonicalModel}:${input.queryEmbedding.provenance.contractVersion}`,
        representation: `${this.ports.selection.selectedRepresentation}:v${this.ports.selection.migrationGeneration}`,
      },
      budget: {
        maxInputItems: Math.max(1, inputs.length),
        maxInputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes,
        maxModelCalls: 2,
        maxOutputItems: 1,
        maxOutputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes,
      },
      idempotencyKey: `cross-room:${input.claim.logicalObjectRef}:${input.claim.generation}`,
    };
    if (this.ports.publicationPlans.planExposure !== undefined) {
      const sources = new Map(
        [
          ...input.sameRoomCandidates,
          ...input.sameRoomParents,
          ...candidates,
          ...existingParents,
        ].flatMap((entry) => entry.dependency?.kind === "source"
          ? [[entry.dependency.dependency.logicalSourceRef, entry.dependency.dependency] as const]
          : []),
      );
      const modelExposureDependencies: DurableModelExposureDependency[] = [];
      for (const coordinate of inputs) {
        if (coordinate.kind === "record") {
          const current = await this.ports.repository.read({
            recordRef: coordinate.recordRef,
            readBindingRef: coordinate.read.bindingRef,
          });
          if (
            current.status !== "available"
            || current.record.lifecycle !== "current"
            || current.record.processingGeneration !== coordinate.processingGeneration
          ) {
            return {
              status: "unavailable",
              failureCode: "candidate_unavailable",
              failureDetail: "candidate_record_changed",
            };
          }
          modelExposureDependencies.push({
            kind: "record",
            recordRef: coordinate.recordRef,
            observedProcessingGeneration: coordinate.processingGeneration,
            terminalAuthorityLeafHandles:
              current.record.semantic.terminalAuthorityLeafHandles,
          });
        } else {
          const source = sources.get(coordinate.logicalSourceRef);
          if (
            source === undefined
            || source.observedRevision !== String(coordinate.contentGeneration)
          ) {
            return {
              status: "unavailable",
              failureCode: "candidate_unavailable",
              failureDetail: "candidate_record_changed",
            };
          }
          modelExposureDependencies.push({
            kind: "source",
            sourceKind: coordinate.sourceKind,
            logicalSourceRef: coordinate.logicalSourceRef,
            ...(source.observedRevision === undefined
              ? {}
              : { observedRevision: source.observedRevision }),
            ...(source.observedContentFingerprint === undefined
              ? {}
              : { observedContentFingerprint: source.observedContentFingerprint }),
            terminalAuthorityLeafHandle: source.terminalAuthorityLeafHandle,
          });
        }
      }
      const fixed = await this.ports.publicationPlans.planExposure({
        applicationPlanToken: crossRoomApplicationPlanToken(
          "pre-model-exposure-plan",
        ),
        candidatePlan: plan,
        modelExposureDependencies,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (fixed.status === "no_change") {
        return { status: "no_change", reason: fixed.reason };
      }
      if (fixed.status !== "planned") {
        return {
          status: "unavailable",
          failureCode: fixed.status === "stale"
            ? "projection_unavailable"
            : "candidate_unavailable",
          failureDetail: fixed.failureDetail,
        };
      }
      const { applicationPlanToken: _applicationPlanToken, ...publicationPlan } =
        fixed.plan;
      plan = { ...plan, publicationPlan };
    }
    assertCrossRoomCandidatePlan(plan);
    return {
      status: "available",
      candidates,
      existingParents,
      applicationPlanToken: this.ports.codec.seal(plan),
      unsupportedAuthorityShapes: discovered.metrics.unsupportedAuthorityShapes,
      authorityParentsResolved: discovered.metrics.authorityParentsResolved,
      authorityParentsSkipped: discovered.metrics.authorityParentsSkipped,
      protectedExecutionUnavailable: 0,
    };
  }

  planPublication(
    input: Parameters<CrossRoomOrganizerPartitionPort["planPublication"]>[0],
  ): Promise<CrossRoomOrganizerPublicationPlanningResult> {
    const candidatePlan = this.ports.codec.open(input.applicationPlanToken);
    if (candidatePlan.publicationPlan !== undefined) {
      return Promise.resolve({
        status: "planned",
        plan: {
          applicationPlanToken: input.applicationPlanToken,
          ...candidatePlan.publicationPlan,
        },
      });
    }
    return this.ports.publicationPlans.plan({
      applicationPlanToken: input.applicationPlanToken,
      candidatePlan,
      proposal: input.proposal,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  planDependencyLoss(
    input: Parameters<NonNullable<
      CrossRoomOrganizerPartitionPort["planDependencyLoss"]
    >>[0],
  ): ReturnType<NonNullable<
    CrossRoomOrganizerPartitionPort["planDependencyLoss"]
  >> {
    return this.ports.publicationPlans.planDependencyLoss?.(input)
      ?? Promise.resolve({
        status: "unavailable",
        failureDetail: "publication_plan_invalid",
      });
  }
}

/** Protected selection still performs content-free discovery, never an open. */
export class ProtectedUnavailableCrossRoomOrganizerPartition
implements CrossRoomOrganizerPartitionPort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    store: PostgresCrossRoomOrganizerStore;
  }>) {
    if (ports.selection.selectedRepresentation !== "protected") {
      throw new TypeError("protected cross-Room partition requires protected selection");
    }
  }

  async augment(
    input: Parameters<CrossRoomOrganizerPartitionPort["augment"]>[0],
  ): ReturnType<CrossRoomOrganizerPartitionPort["augment"]> {
    const discovered = await this.ports.store.discover({
      embedding: input.queryEmbedding,
      invocationAudience: input.binding.invocationAudience,
      selection: this.ports.selection,
      changedRecordRef: input.changed.recordRef,
      changedPublicationBindingRef: input.binding.publicationBindingRef,
      authorityParentSeeds: input.authorityParentSeeds,
    });
    // This excluded partition owns no same-Room freshness decision. In
    // particular, authority reprojection can have a current head without a
    // new semantic publication receipt. The prepared same-Room gate and
    // publisher independently fence that head before disclosure/attachment.
    if (discovered.status === "unavailable") return {
      status: "empty", unsupportedAuthorityShapes: 0, authorityParentsResolved: 0,
      authorityParentsSkipped: 0, protectedExecutionUnavailable: 1,
    };
    return {
      status: "empty",
      unsupportedAuthorityShapes: discovered.metrics.unsupportedAuthorityShapes,
      authorityParentsResolved: discovered.metrics.authorityParentsResolved,
      authorityParentsSkipped: discovered.metrics.authorityParentsSkipped,
      // Cross-Room protected execution is unavailable in this wave, but it
      // must not replace or suppress the existing protected same-Room view.
      protectedExecutionUnavailable: discovered.candidates.length === 0 ? 0 : 1,
    };
  }

  planPublication(): Promise<CrossRoomOrganizerPublicationPlanningResult> {
    return Promise.resolve({
      status: "unavailable",
      failureDetail: "publication_plan_invalid",
    });
  }

  planDependencyLoss(): Promise<CrossRoomOrganizerPublicationPlanningResult> {
    return Promise.resolve({
      status: "unavailable",
      failureDetail: "publication_plan_invalid",
    });
  }
}
