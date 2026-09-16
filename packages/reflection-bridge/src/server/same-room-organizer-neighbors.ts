import {
  CANDIDATE_POLICY_V1,
  type DurableSleepFailureDetail,
  type OrganizerRecordInput,
} from "@nautilo/reflection";
import {
  durableEnvelopeToRecordSnapshot,
  type DurableRecordEnvelope,
  type DurableRecordReadPort,
} from "@nautilo/reflection/durable";
import type {
  RankedRecordCoordinate,
  RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import type { RecordRepositorySelection } from "./contracts";
import type { SameRoomSemanticBinding } from "./durable-semantic-composition";
import {
  SAME_ROOM_ORGANIZER_QUERY_POLICY_V1,
  type PostgresSameRoomOrganizerStore,
  type SameRoomOrganizerQueryIntent,
} from "./postgres-same-room-organizer-store";
import type { PostgresRecordSearchProjectionStore } from "./postgres-record-search-projection-store";

export interface SameRoomOrganizerDiscovery {
  readonly queryEmbedding: RecordEmbeddingV1;
  readonly candidateCoordinates: readonly RankedRecordCoordinate[];
  /** Ranked leaves/parents whose unique current parent leaves this binding. */
  readonly authorityParentCandidateCoordinates: readonly RankedRecordCoordinate[];
  readonly parentTargetCoordinates: readonly RankedRecordCoordinate[];
  /** Parent targets that must be resolved and opened through their own binding. */
  readonly authorityParentTargetCoordinates: readonly RankedRecordCoordinate[];
  readonly changedAlreadyParented: boolean;
  readonly metrics: Readonly<{
    rowsConsidered: number;
    rowsSelected: number;
    topologyWork: number;
  }>;
}

export interface OpenedSameRoomOrganizerRecord {
  readonly coordinate: RankedRecordCoordinate;
  readonly snapshot: OrganizerRecordInput["snapshot"];
}

export interface SameRoomOrganizerNeighborPort {
  discover(input: Readonly<{
    changed: Pick<DurableRecordEnvelope, "recordRef" | "processingGeneration">;
    binding: SameRoomSemanticBinding;
    intent: SameRoomOrganizerQueryIntent;
    signal?: AbortSignal;
  }>): Promise<
    | { readonly status: "available"; readonly discovery: SameRoomOrganizerDiscovery }
    | { readonly status: "unavailable"; readonly reason: DurableSleepFailureDetail }
  >;
  openSelected(input: Readonly<{
    binding: SameRoomSemanticBinding;
    coordinates: readonly RankedRecordCoordinate[];
    signal?: AbortSignal;
  }>): Promise<
    | {
        readonly status: "available";
        readonly records: readonly OpenedSameRoomOrganizerRecord[];
      }
    | { readonly status: "unavailable"; readonly reason: DurableSleepFailureDetail }
  >;
}

function uniqueCoordinates(
  coordinates: readonly RankedRecordCoordinate[],
): readonly RankedRecordCoordinate[] {
  const seen = new Set<string>();
  return coordinates.filter((coordinate) => {
    if (seen.has(coordinate.recordRef)) return false;
    seen.add(coordinate.recordRef);
    return true;
  });
}

function exactRoom(snapshot: OrganizerRecordInput["snapshot"], roomAnchorRef: string): boolean {
  return snapshot.anchors.includes(roomAnchorRef);
}

/**
 * Two-phase background adapter. Discovery is content-free after embedding;
 * selected payloads are opened only after one exact batch fence.
 */
export class PostgresSameRoomOrganizerNeighbors
implements SameRoomOrganizerNeighborPort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    projections: Pick<PostgresRecordSearchProjectionStore, "readCurrentEmbedding">;
    store: PostgresSameRoomOrganizerStore;
    repository: DurableRecordReadPort;
  }>) {}

  async discover(input: Readonly<{
    changed: Pick<DurableRecordEnvelope, "recordRef" | "processingGeneration">;
    binding: SameRoomSemanticBinding;
    intent: SameRoomOrganizerQueryIntent;
    signal?: AbortSignal;
  }>): Promise<
    | { readonly status: "available"; readonly discovery: SameRoomOrganizerDiscovery }
    | { readonly status: "unavailable"; readonly reason: DurableSleepFailureDetail }
  > {
    if (input.signal?.aborted) {
      return { status: "unavailable", reason: "candidate_selection_invalid" };
    }
    const projection = await this.ports.projections.readCurrentEmbedding(
      input.changed.recordRef,
    );
    if (
      projection === null
      || projection.recordProcessingGeneration !== input.changed.processingGeneration
    ) return { status: "unavailable", reason: "candidate_projection_stale" };
    const ranked = await this.ports.store.rank({
      embedding: projection.embedding,
      invocationAudience: input.binding.invocationAudience,
      selection: this.ports.selection,
      publicationBindingRef: input.binding.publicationBindingRef,
      changedRecordRef: input.changed.recordRef,
      intent: input.intent,
      limit: SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.selectedOverfetch,
    });
    if (ranked.status === "unavailable") {
      return {
        status: "unavailable",
        reason: ranked.reason === "timeout"
          ? "candidate_rank_timeout"
          : "candidate_rank_storage_unavailable",
      };
    }
    const topology = await this.ports.store.topology({
      invocationAudience: input.binding.invocationAudience,
      selection: this.ports.selection,
      publicationBindingRef: input.binding.publicationBindingRef,
      changedRecordRef: input.changed.recordRef,
      intent: input.intent,
      rankedCoordinates: ranked.coordinates,
    });
    if (topology.status === "unavailable") {
      return {
        status: "unavailable",
        reason: topology.reason === "timeout"
          ? "candidate_topology_timeout"
          : topology.reason === "topology_capacity_exceeded"
            ? "candidate_topology_capacity_exceeded"
            : "candidate_topology_storage_unavailable",
      };
    }

    const redundant = new Set(topology.topology.redundantRecordRefs);
    const authorityParentRefs = new Set(
      topology.topology.authorityParentRecordRefs,
    );
    const coordinateByRef = new Map([
      ...ranked.coordinates,
      ...topology.topology.normalizedCoordinates,
    ].map((coordinate) => [coordinate.recordRef, coordinate]));
    const normalizedRanked = ranked.coordinates.flatMap((coordinate) => {
      const representativeRef = topology.topology.normalizedRecordRefs.get(
        coordinate.recordRef,
      ) ?? coordinate.recordRef;
      const representative = coordinateByRef.get(representativeRef);
      return representative === undefined
        ? []
        : [{ ...representative, score: coordinate.score }];
    }).filter((coordinate, index, all) =>
      all.findIndex((candidate) => candidate.recordRef === coordinate.recordRef) === index
    );
    const nonredundant = normalizedRanked.filter(
      (coordinate) =>
        coordinate.recordRef !== input.changed.recordRef
        && !redundant.has(coordinate.recordRef)
        && !authorityParentRefs.has(coordinate.recordRef),
    );
    const authorityParentRanked = ranked.coordinates.filter(
      (coordinate) =>
        authorityParentRefs.has(coordinate.recordRef)
        && !redundant.has(coordinate.recordRef),
    );
    const candidateCoordinates = input.intent === "promotion"
      ? nonredundant.filter((coordinate) => coordinate.structuralHeight > 0)
      : nonredundant.filter((coordinate) => coordinate.structuralHeight === 0);
    const authorityParentCandidateCoordinates = input.intent === "promotion"
      ? authorityParentRanked.filter((coordinate) => coordinate.structuralHeight > 0)
      : authorityParentRanked.filter((coordinate) => coordinate.structuralHeight === 0);
    const candidateRefs = new Set(
      candidateCoordinates.map((coordinate) => coordinate.recordRef),
    );
    const parentTargets = input.intent === "promotion"
      ? []
      : uniqueCoordinates([
          ...topology.topology.directParents,
          ...nonredundant.filter((coordinate) => coordinate.structuralHeight > 0),
          ...authorityParentRanked.filter((coordinate) =>
            coordinate.structuralHeight > 0
          ),
        ])
        .filter((coordinate) => !candidateRefs.has(coordinate.recordRef))
        .slice(0, CANDIDATE_POLICY_V1.sameRoomBound);
    const parentTargetCoordinates = parentTargets.filter(
      (coordinate) => !authorityParentRefs.has(coordinate.recordRef),
    );
    const authorityParentTargetCoordinates = parentTargets.filter(
      (coordinate) => authorityParentRefs.has(coordinate.recordRef),
    );
    return Object.freeze({
      status: "available" as const,
      discovery: Object.freeze({
        queryEmbedding: projection.embedding,
        candidateCoordinates: Object.freeze(candidateCoordinates),
        authorityParentCandidateCoordinates: Object.freeze(
          authorityParentCandidateCoordinates,
        ),
        parentTargetCoordinates: Object.freeze(parentTargetCoordinates),
        authorityParentTargetCoordinates: Object.freeze(
          authorityParentTargetCoordinates,
        ),
        metrics: Object.freeze({
          rowsConsidered: ranked.rowsConsidered,
          rowsSelected:
            candidateCoordinates.length
            + authorityParentCandidateCoordinates.length
            + parentTargetCoordinates.length
            + authorityParentTargetCoordinates.length,
          topologyWork: topology.topology.traversalWork,
        }),
        changedAlreadyParented: topology.topology.changedAlreadyParented,
      }),
    });
  }

  async openSelected(input: Readonly<{
    binding: SameRoomSemanticBinding;
    coordinates: readonly RankedRecordCoordinate[];
    signal?: AbortSignal;
  }>): Promise<
    | {
        readonly status: "available";
        readonly records: readonly OpenedSameRoomOrganizerRecord[];
      }
    | { readonly status: "unavailable"; readonly reason: DurableSleepFailureDetail }
  > {
    if (input.signal?.aborted) {
      return { status: "unavailable", reason: "candidate_selection_invalid" };
    }
    const coordinates = uniqueCoordinates(input.coordinates);
    if (coordinates.length !== input.coordinates.length || coordinates.length > 8) {
      return { status: "unavailable", reason: "candidate_selection_invalid" };
    }
    const fenced = await this.ports.store.fence({
      invocationAudience: input.binding.invocationAudience,
      selection: this.ports.selection,
      publicationBindingRef: input.binding.publicationBindingRef,
      coordinates,
    });
    if (fenced.status !== "current") {
      return {
        status: "unavailable",
        reason: fenced.status === "stale"
          ? "candidate_fence_stale"
          : fenced.reason === "timeout"
            ? "candidate_fence_timeout"
            : "candidate_fence_storage_unavailable",
      };
    }

    const records: OpenedSameRoomOrganizerRecord[] = [];
    for (const coordinate of coordinates) {
      if (input.signal?.aborted) {
        return { status: "unavailable", reason: "candidate_selection_invalid" };
      }
      const opened = await this.ports.repository.read({
        recordRef: coordinate.recordRef,
        readBindingRef: input.binding.readBindingRef,
      });
      if (
        opened.status !== "available"
        || opened.record.processingGeneration
          !== coordinate.recordProcessingGeneration
      ) return { status: "unavailable", reason: "candidate_record_changed" };
      const snapshot = durableEnvelopeToRecordSnapshot(opened.record);
      if (
        opened.record.lifecycle !== "current"
        || !exactRoom(snapshot, input.binding.roomAnchorRef)
      ) return { status: "unavailable", reason: "candidate_record_changed" };
      records.push(Object.freeze({ coordinate, snapshot }));
    }
    return Object.freeze({
      status: "available" as const,
      records: Object.freeze(records),
    });
  }
}
