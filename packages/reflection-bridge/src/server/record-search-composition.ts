import { createHmac } from "node:crypto";

import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";
import {
  RECORD_SEARCH_POLICY_V1,
  assertRecordEvidenceRequest,
  assertRecordSearchRequest,
  resetRecordRedundancyCallBudget,
  suppressRedundantHierarchyResults,
  type EligibleHierarchyCoordinatePort,
  type RecordEmbeddingPort,
  type RecordEvidencePort,
  type RecordEvidenceNodeV1,
  type RecordEvidenceResponse,
  type RankedRecordCoordinate,
  type RecordRedundancyContinuationStateV1,
  type RecordSearchContinuationStateV1,
  type RecordSearchPort,
  type RecordSearchResponse,
  type SyntheticRecordEvidenceReaderPort,
} from "@nautilo/reflection/search";

import type { AuthorityProjectionStorePort } from "./authority-contracts";
import { encodeDurableRecordEnvelope } from "./record-mapping";
import type { RecordRepositoryPort, RecordRepositorySelection } from "./contracts";
import type { ProjectedAuthorityEligibility } from "./authority-eligibility";
import type {
  PostgresAuthorityFilteredRecordSearchStore,
  RecordSearchRankCursor,
} from "./postgres-record-search-store";
import type { RecordSearchContinuationCodec } from "./record-search-continuation-codec";
import type { CurrentRecordPublicationBindingPort } from "./postgres-current-record-publication-binding";

export interface ResolvedRecordSearchBinding {
  readonly invocationAudience: EffectiveAudienceAlternative;
  readonly readBindingRef: string;
  readonly invocationAudienceCommitment: string;
}

export interface RecordSearchBindingPort {
  resolve(bindingRef: string): Promise<ResolvedRecordSearchBinding | null>;
}

export interface RecordEvidenceTraversalCheckpoint {
  readonly rootRecordRef: string;
  readonly rootAuthorityGeneration: number;
  readonly rootProcessingGeneration: number;
  readonly rootRepresentationGeneration: number;
  /** Cursor used to read the current durable child page. */
  readonly currentPageContinuation?: string;
  /** Index within the current page, including hidden/unavailable children. */
  readonly currentPageIndex: number;
  /** Stable edge position across all durable child pages. */
  readonly absoluteChildPosition: number;
  readonly childrenComplete: boolean;
  readonly sourceOffset: number;
}

export interface RecordEvidenceTraversalCheckpointPort {
  save(checkpoint: RecordEvidenceTraversalCheckpoint): Promise<string>;
  load(ref: string): Promise<RecordEvidenceTraversalCheckpoint | null>;
  remove(ref: string): Promise<void>;
}

export interface RecordSearchCommitmentPort {
  commit(kind: string, value: unknown): string;
}

export interface RecordSearchTraversalCheckpoint {
  readonly rankAfter?: RecordSearchRankCursor;
  readonly redundancy: RecordRedundancyContinuationStateV1;
  readonly alreadyEmittedRecordRefs: readonly string[];
}

export interface RecordSearchTraversalCheckpointPort {
  load(ref: string): Promise<RecordSearchTraversalCheckpoint | null>;
  save(ref: string, checkpoint: RecordSearchTraversalCheckpoint): Promise<void>;
  remove(ref: string): Promise<void>;
}

export function createHmacRecordSearchCommitmentPort(
  key: Uint8Array,
): RecordSearchCommitmentPort {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new TypeError("Record search commitment key must contain at least 32 bytes");
  }
  const owned = key.slice();
  return Object.freeze({
    commit(kind: string, value: unknown): string {
      const digest = createHmac("sha256", owned)
        .update("nautilo-reflection-record-search-commitment-v1\0", "utf8")
        .update(kind, "utf8")
        .update("\0", "utf8")
        .update(JSON.stringify(value), "utf8")
        .digest("base64url");
      // Raw base64url may begin with '-' or '_', while Reflection's opaque
      // identifier contract deliberately requires an alphanumeric prefix.
      return `h1.${digest}`;
    },
  });
}

function selectionValue(selection: RecordRepositorySelection): object {
  return {
    representation: selection.selectedRepresentation,
    migrationGeneration: selection.migrationGeneration,
  };
}

function audienceValue(audience: EffectiveAudienceAlternative): object {
  return {
    humanRefs: [...audience.humanRefs],
    includesPublicBoundary: audience.includesPublicBoundary,
  };
}

function returnedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function authorityMatches(input: {
  readonly projection: Awaited<ReturnType<AuthorityProjectionStorePort["readCurrent"]>>;
  readonly authorityGeneration: number;
  readonly representationGeneration: number;
  readonly preferProtectedHead?: boolean;
}): boolean {
  return input.projection !== null
    && input.projection.projectionGeneration === input.authorityGeneration
    && (input.preferProtectedHead
      ? input.projection.protectedRepresentationGeneration ?? input.projection.representationGeneration
      : input.projection.representationGeneration) === input.representationGeneration;
}

async function currentReadBinding(input: Readonly<{
  bindings: CurrentRecordPublicationBindingPort | undefined;
  recordRef: string;
  fallback: string;
  authorityGeneration: number;
  representationGeneration: number;
}>): Promise<string | null> {
  if (input.bindings === undefined) return input.fallback;
  const current = await input.bindings.read(input.recordRef);
  if (
    current === null
    || current.authorityProjectionGeneration !== input.authorityGeneration
    || current.representationGeneration !== input.representationGeneration
  ) return null;
  if (current.currentAccessBindingRefs.length === 1) {
    return current.currentAccessBindingRefs[0]!;
  }
  // A same-Room invocation is an explicit choice among multiple current
  // authority alternatives. Never pick an unrelated alternative by order.
  return current.currentAccessBindingRefs.includes(input.fallback)
    ? input.fallback
    : null;
}

export class DualModeAuthorityFilteredRecordSearch implements RecordSearchPort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    embedding: RecordEmbeddingPort;
    bindings: RecordSearchBindingPort;
    exactSearch: PostgresAuthorityFilteredRecordSearchStore;
    eligibility: ProjectedAuthorityEligibility;
    authorityProjections: AuthorityProjectionStorePort;
    recordBindings?: CurrentRecordPublicationBindingPort;
    repository: RecordRepositoryPort;
    eligibleGraph: EligibleHierarchyCoordinatePort;
    continuations: RecordSearchContinuationCodec;
    commitments: RecordSearchCommitmentPort;
    checkpoints: RecordSearchTraversalCheckpointPort;
  }>) {}

  async search(input: Parameters<RecordSearchPort["search"]>[0]): Promise<RecordSearchResponse> {
    return this.executeSearch(input, false) as Promise<RecordSearchResponse>;
  }

  async searchStructural(
    input: Parameters<RecordSearchPort["search"]>[0],
  ): ReturnType<NonNullable<RecordSearchPort["searchStructural"]>> {
    return this.executeSearch(input, true) as ReturnType<
      NonNullable<RecordSearchPort["searchStructural"]>
    >;
  }

  private async executeSearch(
    input: Parameters<RecordSearchPort["search"]>[0],
    structural: boolean,
  ) {
    assertRecordSearchRequest(input);
    const binding = await this.ports.bindings.resolve(input.searchBindingRef);
    if (binding === null) return { status: "available", results: [] };
    const audienceCommitment = this.ports.commitments.commit(
      "audience",
      audienceValue(binding.invocationAudience),
    );
    if (binding.invocationAudienceCommitment !== audienceCommitment) {
      return { status: "available", results: [] };
    }
    const queryCommitment = this.ports.commitments.commit("query", input.query);
    const repositorySelectionCommitment = this.ports.commitments.commit(
      "repository",
      selectionValue(this.ports.selection),
    );
    let after: RecordSearchRankCursor | undefined;
    let resumedState: RecordSearchContinuationStateV1 | undefined;
    let redundancy: RecordRedundancyContinuationStateV1 | undefined;
    let alreadyEmittedRecordRefs: readonly string[] = [];
    let consumedSearchCheckpointRef: string | undefined;
    if (input.continuation !== undefined) {
      let state: RecordSearchContinuationStateV1;
      try {
        state = this.ports.continuations.verifySearch(input.continuation);
      } catch {
        return { status: "unavailable", reason: "stale_restart" };
      }
      if (
        state.queryCommitment !== queryCommitment
        || state.invocationAudienceCommitment !== audienceCommitment
        || state.repositorySelectionCommitment !== repositorySelectionCommitment
      ) return { status: "unavailable", reason: "stale_restart" };
      resumedState = state;
      after = state.lastEligiblePosition;
      const checkpointRef = this.ports.commitments.commit("search-checkpoint", state);
      const checkpoint = await this.ports.checkpoints.load(checkpointRef);
      if (checkpoint !== null) {
        after = checkpoint.rankAfter;
        redundancy = resetRecordRedundancyCallBudget(checkpoint.redundancy);
        alreadyEmittedRecordRefs = checkpoint.alreadyEmittedRecordRefs;
        consumedSearchCheckpointRef = checkpointRef;
      }
    }

    const embedded = await this.ports.embedding.embed({
      purpose: "record.query_embedding",
      plaintext: input.query,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (embedded.status === "unavailable") {
      return { status: "unavailable", reason: "embedding_unavailable" };
    }
    const rankCommitment = this.ports.commitments.commit(
      "rank",
      { queryCommitment, audienceCommitment, repositorySelectionCommitment },
    );
    let selected: Awaited<ReturnType<typeof suppressRedundantHierarchyResults>> | undefined;
    let corpusStateCommitment: string | undefined;
    let finalHasMore = false;
    let pageAfter = after;
    // A rank page is at most the requested result limit. Streaming across pages
    // prevents redundant early candidates from under-filling the result page.
    do {
      const ranked = await this.ports.exactSearch.search({
        embedding: embedded.embedding,
        invocationAudience: binding.invocationAudience,
        selection: this.ports.selection,
        ...(structural ? { preferProtectedHead: true } : {}),
        limit: input.limit,
        ...(pageAfter === undefined ? {} : { after: pageAfter }),
      });
      if (ranked.status === "unavailable") {
        return {
          status: "unavailable",
          reason: ranked.reason === "timeout" ? "exact_scan_timeout" : "integrity_failure",
        };
      }
      const currentCorpusCommitment = this.ports.commitments.commit(
        "corpus",
        ranked.corpusStateCoordinate,
      );
      corpusStateCommitment ??= currentCorpusCommitment;
      if (
        currentCorpusCommitment !== corpusStateCommitment
        || (resumedState !== undefined
          && resumedState.corpusStateCommitment !== currentCorpusCommitment)
      ) return { status: "unavailable", reason: "stale_restart" };

      const stillEligible: RankedRecordCoordinate[] = [];
      for (const coordinate of ranked.coordinates) {
        const eligible = await this.ports.eligibility.check({
          recordRef: coordinate.recordRef,
          invocationAudience: binding.invocationAudience,
        });
        const authority = await this.ports.authorityProjections.readCurrent(
          coordinate.recordRef,
        );
        if (!authorityMatches({
          projection: authority,
          preferProtectedHead: structural,
          authorityGeneration: coordinate.authorityProjectionGeneration,
          representationGeneration: coordinate.payloadRepresentationGeneration,
        })) return { status: "unavailable", reason: "stale_restart" };
        // The SQL page and this exact check are separate snapshots. Losing
        // eligibility here (most importantly through an immediate direct/leaf
        // block) invalidates the ranked page; silently dropping the coordinate
        // could under-fill the page or leave `hasMore` attached to an empty
        // page. Restart against current authority instead.
        if (eligible.status !== "eligible") {
          return { status: "unavailable", reason: "stale_restart" };
        }
        stillEligible.push(coordinate);
      }
      const rankPageCommitment = this.ports.commitments.commit(
        "rank-page",
        stillEligible,
      );
      selected = await suppressRedundantHierarchyResults({
        rankedCoordinates: stillEligible,
        graph: this.ports.eligibleGraph,
        resultLimit: input.limit,
        traversalWorkLimit: RECORD_SEARCH_POLICY_V1.traversalWorkMaximum,
        rankCommitment,
        rankPageCommitment,
        hasMoreRankedCoordinates: ranked.hasMore,
        ...(redundancy === undefined ? {} : { continuation: redundancy }),
      });
      redundancy = selected.continuation;
      finalHasMore = ranked.hasMore;
      if (redundancy?.resumeKind === "next_rank_page") {
        const next = redundancy.lastProcessedCoordinate;
        if (next === undefined) return { status: "unavailable", reason: "integrity_failure" };
        pageAfter = {
          recordRef: next.recordRef,
          score: next.score,
          structuralHeight: next.structuralHeight,
        };
      }
    } while (redundancy?.resumeKind === "next_rank_page");

    if (selected === undefined || corpusStateCommitment === undefined) {
      return { status: "unavailable", reason: "integrity_failure" };
    }
    const alreadyEmitted = new Set(alreadyEmittedRecordRefs);
    const newlySelected = selected.results.filter(
      (coordinate) => !alreadyEmitted.has(coordinate.recordRef),
    );
    const results = [];
    let openedBytes = 0;
    for (const coordinate of newlySelected) {
      const eligibleImmediatelyBeforeOpen = await this.ports.eligibility.check({
        recordRef: coordinate.recordRef,
        invocationAudience: binding.invocationAudience,
      });
      if (eligibleImmediatelyBeforeOpen.status !== "eligible") {
        return { status: "unavailable", reason: "stale_restart" };
      }
      const authorityImmediatelyBeforeOpen = await this.ports.authorityProjections
        .readCurrent(coordinate.recordRef);
      if (!authorityMatches({
        projection: authorityImmediatelyBeforeOpen,
        preferProtectedHead: structural,
        authorityGeneration: coordinate.authorityProjectionGeneration,
        representationGeneration: coordinate.payloadRepresentationGeneration,
      })) return { status: "unavailable", reason: "stale_restart" };
      if (structural) {
        results.push({
          recordRef: coordinate.recordRef,
          score: coordinate.score,
          structuralHeight: coordinate.structuralHeight,
        });
        continue;
      }
      const readBindingRef = await currentReadBinding({
        bindings: this.ports.recordBindings,
        recordRef: coordinate.recordRef,
        fallback: binding.readBindingRef,
        authorityGeneration: coordinate.authorityProjectionGeneration,
        representationGeneration: coordinate.payloadRepresentationGeneration,
      });
      if (readBindingRef === null) {
        return { status: "unavailable", reason: "stale_restart" };
      }
      const read = await this.ports.repository.read({
        recordRef: coordinate.recordRef,
        readBindingRef,
      });
      if (read.status !== "available") continue;
      if (read.record.processingGeneration !== coordinate.recordProcessingGeneration) {
        return { status: "unavailable", reason: "stale_restart" };
      }
      openedBytes += encodeDurableRecordEnvelope(read.record).byteLength;
      if (openedBytes > RECORD_SEARCH_POLICY_V1.openedRecordPayloadBytesMaximum) {
        return { status: "unavailable", reason: "capacity_exceeded" };
      }
      const parentPage = await this.ports.repository.readParents({
        recordRef: coordinate.recordRef,
        readBindingRef,
        limit: RECORD_SEARCH_POLICY_V1.graphPageMaximum,
      });
      const directParentRecordRefs: string[] = [];
      if (parentPage.status === "available") {
        for (const parentRef of parentPage.page.items) {
          const parentEligible = await this.ports.eligibility.check({
            recordRef: parentRef,
            invocationAudience: binding.invocationAudience,
          });
          if (parentEligible.status !== "eligible") continue;
          const parentProjection = await this.ports.authorityProjections.readCurrent(parentRef);
          if (parentProjection !== null) directParentRecordRefs.push(parentRef);
        }
      }
      results.push({
        recordRef: coordinate.recordRef,
        statement: read.record.semantic.statement,
        score: coordinate.score,
        structuralHeight: coordinate.structuralHeight,
        lifecycle: read.record.lifecycle,
        directParentRecordRefs,
        backlinksTruncated: parentPage.status === "available"
          && parentPage.page.continuation !== undefined,
      });
    }
    if (returnedBytes(results) > RECORD_SEARCH_POLICY_V1.returnedBytesMaximum) {
      return { status: "unavailable", reason: "capacity_exceeded" };
    }
    const lastEmitted = selected.results.at(-1);
    const needsContinuation = redundancy !== undefined || finalHasMore;
    let continuation: string | undefined;
    if (lastEmitted !== undefined && needsContinuation) {
      const state: RecordSearchContinuationStateV1 = {
          version: 1,
          policyVersion: 1,
          queryCommitment,
          invocationAudienceCommitment: audienceCommitment,
          repositorySelectionCommitment,
          corpusStateCommitment,
          lastEligiblePosition: {
            recordRef: lastEmitted.recordRef,
            score: lastEmitted.score,
            structuralHeight: lastEmitted.structuralHeight,
          },
      };
      continuation = this.ports.continuations.authenticateSearch(state);
      if (redundancy?.resumeKind === "traversal") {
        const checkpointRef = this.ports.commitments.commit("search-checkpoint", state);
        await this.ports.checkpoints.save(checkpointRef, {
          ...(pageAfter === undefined ? {} : { rankAfter: pageAfter }),
          redundancy,
          alreadyEmittedRecordRefs: selected.results.map((entry) => entry.recordRef),
        });
      }
    }
    if (consumedSearchCheckpointRef !== undefined) {
      await this.ports.checkpoints.remove(consumedSearchCheckpointRef);
    }
    const response = {
      status: "available",
      results,
      ...(continuation === undefined ? {} : { continuation }),
    } as const;
    if (returnedBytes(response) > RECORD_SEARCH_POLICY_V1.returnedBytesMaximum) {
      return { status: "unavailable", reason: "capacity_exceeded" };
    }
    return response;
  }
}

export class DualModeSyntheticRecordEvidence implements RecordEvidencePort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    bindings: RecordSearchBindingPort;
    eligibility: ProjectedAuthorityEligibility;
    authorityProjections: AuthorityProjectionStorePort;
    recordBindings?: CurrentRecordPublicationBindingPort;
    repository: RecordRepositoryPort;
    sources: SyntheticRecordEvidenceReaderPort;
    checkpoints: RecordEvidenceTraversalCheckpointPort;
    continuations: RecordSearchContinuationCodec;
    commitments: RecordSearchCommitmentPort;
  }>) {}

  async expand(
    input: Parameters<RecordEvidencePort["expand"]>[0],
  ): Promise<RecordEvidenceResponse> {
    assertRecordEvidenceRequest(input);
    const binding = await this.ports.bindings.resolve(input.evidenceBindingRef);
    if (binding === null) return { status: "unavailable", reason: "unauthorized" };
    const audienceCommitment = this.ports.commitments.commit(
      "audience",
      audienceValue(binding.invocationAudience),
    );
    if (binding.invocationAudienceCommitment !== audienceCommitment) {
      return { status: "unavailable", reason: "unauthorized" };
    }
    const repositoryCommitment = this.ports.commitments.commit(
      "repository",
      selectionValue(this.ports.selection),
    );
    const rootCommitment = this.ports.commitments.commit("root", input.rootRecordRef);

    // The exact authority check and generation read immediately precede the
    // ordinary/protected repository open.
    const rootEligible = await this.ports.eligibility.check({
      recordRef: input.rootRecordRef,
      invocationAudience: binding.invocationAudience,
    });
    if (rootEligible.status !== "eligible") {
      return { status: "unavailable", reason: "unauthorized" };
    }
    const rootProjection = await this.ports.authorityProjections.readCurrent(
      input.rootRecordRef,
    );
    if (rootProjection === null) return { status: "unavailable", reason: "unauthorized" };
    const rootReadBindingRef = await currentReadBinding({
      bindings: this.ports.recordBindings,
      recordRef: input.rootRecordRef,
      fallback: binding.readBindingRef,
      authorityGeneration: rootProjection.projectionGeneration,
      representationGeneration: rootProjection.representationGeneration,
    });
    if (rootReadBindingRef === null) {
      return { status: "unavailable", reason: "stale_restart" };
    }
    const root = await this.ports.repository.read({
      recordRef: input.rootRecordRef,
      readBindingRef: rootReadBindingRef,
    });
    if (root.status !== "available") {
      return { status: "unavailable", reason: "integrity_failure" };
    }
    const graphStateCommitment = this.ports.commitments.commit("graph", {
      root: input.rootRecordRef,
      authority: rootProjection.projectionGeneration,
      processing: root.record.processingGeneration,
      representation: rootProjection.representationGeneration,
    });
    let checkpoint: RecordEvidenceTraversalCheckpoint = {
      rootRecordRef: input.rootRecordRef,
      rootAuthorityGeneration: rootProjection.projectionGeneration,
      rootProcessingGeneration: root.record.processingGeneration,
      rootRepresentationGeneration: rootProjection.representationGeneration,
      currentPageIndex: 0,
      absoluteChildPosition: 0,
      childrenComplete: false,
      sourceOffset: 0,
    };
    let consumedCheckpointRef: string | undefined;
    if (input.continuation !== undefined) {
      let tokenState;
      try {
        tokenState = this.ports.continuations.openEvidence(input.continuation);
      } catch {
        return { status: "unavailable", reason: "stale_restart" };
      }
      const loaded = await this.ports.checkpoints.load(tokenState.traversalCheckpointRef);
      if (
        loaded === null
        || loaded.rootRecordRef !== input.rootRecordRef
        || loaded.rootAuthorityGeneration !== rootProjection.projectionGeneration
        || loaded.rootProcessingGeneration !== root.record.processingGeneration
        || loaded.rootRepresentationGeneration !== rootProjection.representationGeneration
        || tokenState.rootCommitment !== rootCommitment
        || tokenState.invocationAudienceCommitment !== audienceCommitment
        || tokenState.repositorySelectionCommitment !== repositoryCommitment
        || tokenState.graphStateCommitment !== graphStateCommitment
      ) {
        return { status: "unavailable", reason: "stale_restart" };
      }
      checkpoint = loaded;
      consumedCheckpointRef = tokenState.traversalCheckpointRef;
    }
    let openedBytes = encodeDurableRecordEnvelope(root.record).byteLength;
    if (openedBytes > input.openedPayloadBytesLimit) {
      return { status: "unavailable", reason: "capacity_exceeded" };
    }
    let work = 1;
    const rootNode: RecordEvidenceNodeV1 = {
      recordRef: root.record.recordRef,
      statement: root.record.semantic.statement,
      structuralHeight: root.record.structuralHeight,
      lifecycle: root.record.lifecycle,
      depth: 0 as const,
    };
    let outputBytes = returnedBytes(rootNode);
    if (outputBytes > input.returnedBytesLimit) {
      return { status: "unavailable", reason: "capacity_exceeded" };
    }
    const nodes: RecordEvidenceNodeV1[] = [rootNode];
    const edges = [];
    const sources = [];
    let emittedBeyondRoot = false;

    while (!checkpoint.childrenComplete && work < input.traversalWorkLimit) {
      const currentPageContinuation = checkpoint.currentPageContinuation;
      const children = await this.ports.repository.readDependencies({
        recordRef: input.rootRecordRef,
        readBindingRef: rootReadBindingRef,
        limit: RECORD_SEARCH_POLICY_V1.graphPageMaximum,
        ...(currentPageContinuation === undefined
          ? {}
          : { continuation: currentPageContinuation }),
      });
      if (children.status !== "available") {
        return { status: "unavailable", reason: "integrity_failure" };
      }
      let pageIndex = checkpoint.currentPageIndex;
      let pausedForCapacity = false;
      while (pageIndex < children.page.items.length && work < input.traversalWorkLimit) {
        const childRef = children.page.items[pageIndex]!;
        const childPosition = checkpoint.absoluteChildPosition;
        work += 1;
        const childEligible = await this.ports.eligibility.check({
          recordRef: childRef,
          invocationAudience: binding.invocationAudience,
        });
        if (childEligible.status !== "eligible") {
          pageIndex += 1;
          checkpoint = {
            ...checkpoint,
            currentPageIndex: pageIndex,
            absoluteChildPosition: childPosition + 1,
          };
          continue;
        }
        const childAuthority = await this.ports.authorityProjections.readCurrent(childRef);
        if (childAuthority === null) {
          pageIndex += 1;
          checkpoint = {
            ...checkpoint,
            currentPageIndex: pageIndex,
            absoluteChildPosition: childPosition + 1,
          };
          continue;
        }
        const childReadBindingRef = await currentReadBinding({
          bindings: this.ports.recordBindings,
          recordRef: childRef,
          fallback: binding.readBindingRef,
          authorityGeneration: childAuthority.projectionGeneration,
          representationGeneration: childAuthority.representationGeneration,
        });
        if (childReadBindingRef === null) {
          return { status: "unavailable", reason: "stale_restart" };
        }
        const child = await this.ports.repository.read({
          recordRef: childRef,
          readBindingRef: childReadBindingRef,
        });
        if (child.status !== "available") {
          pageIndex += 1;
          checkpoint = {
            ...checkpoint,
            currentPageIndex: pageIndex,
            absoluteChildPosition: childPosition + 1,
          };
          continue;
        }
        const childPayloadBytes = encodeDurableRecordEnvelope(child.record).byteLength;
        if (openedBytes + childPayloadBytes > input.openedPayloadBytesLimit) {
          if (!emittedBeyondRoot) {
            return { status: "unavailable", reason: "capacity_exceeded" };
          }
          pausedForCapacity = true;
          break;
        }
        const node = {
          recordRef: childRef,
          statement: child.record.semantic.statement,
          structuralHeight: child.record.structuralHeight,
          lifecycle: child.record.lifecycle,
          depth: 1 as const,
        };
        const edge = {
          parentRecordRef: input.rootRecordRef,
          childRecordRef: childRef,
          childPosition,
        };
        if (outputBytes + returnedBytes(node) + returnedBytes(edge) > input.returnedBytesLimit) {
          if (!emittedBeyondRoot) {
            return { status: "unavailable", reason: "capacity_exceeded" };
          }
          pausedForCapacity = true;
          break;
        }
        openedBytes += childPayloadBytes;
        outputBytes += returnedBytes(node) + returnedBytes(edge);
        nodes.push(node);
        edges.push(edge);
        emittedBeyondRoot = true;
        pageIndex += 1;
        checkpoint = {
          ...checkpoint,
          currentPageIndex: pageIndex,
          absoluteChildPosition: childPosition + 1,
        };
      }
      if (pausedForCapacity || pageIndex < children.page.items.length) break;
      if (children.page.continuation === undefined) {
        checkpoint = { ...checkpoint, childrenComplete: true, currentPageIndex: 0 };
      } else {
        checkpoint = {
          ...checkpoint,
          currentPageContinuation: children.page.continuation,
          currentPageIndex: 0,
        };
      }
    }

    for (
      let index = checkpoint.sourceOffset;
      checkpoint.childrenComplete
        && index < root.record.semantic.sourceDependencies.length;
      index += 1
    ) {
      if (work >= input.traversalWorkLimit) break;
      work += 1;
      const source = root.record.semantic.sourceDependencies[index]!;
      const sourceEligible = await this.ports.eligibility.check({
        recordRef: input.rootRecordRef,
        invocationAudience: binding.invocationAudience,
      });
      if (sourceEligible.status !== "eligible") {
        return { status: "unavailable", reason: "stale_restart" };
      }
      const sourceAuthority = await this.ports.authorityProjections.readCurrent(
        input.rootRecordRef,
      );
      if (!authorityMatches({
        projection: sourceAuthority,
        authorityGeneration: checkpoint.rootAuthorityGeneration,
        representationGeneration: checkpoint.rootRepresentationGeneration,
      })) return { status: "unavailable", reason: "stale_restart" };
      const result = await this.ports.sources.read({
        sourceDependency: source,
        evidenceBindingRef: input.evidenceBindingRef,
        returnedBytesRemaining: input.returnedBytesLimit - outputBytes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (result.status !== "available") {
        return { status: "unavailable", reason: result.reason };
      }
      const sourceOutputBytes = returnedBytes(result.evidence);
      if (outputBytes + sourceOutputBytes > input.returnedBytesLimit) {
        if (!emittedBeyondRoot) {
          return { status: "unavailable", reason: "capacity_exceeded" };
        }
        break;
      }
      outputBytes += sourceOutputBytes;
      sources.push(result.evidence);
      emittedBeyondRoot = true;
      checkpoint = { ...checkpoint, sourceOffset: index + 1 };
    }
    const incomplete = !checkpoint.childrenComplete
      || checkpoint.sourceOffset < root.record.semantic.sourceDependencies.length;
    let continuation;
    if (incomplete) {
      const checkpointRef = await this.ports.checkpoints.save(checkpoint);
      continuation = this.ports.continuations.sealEvidence({
        version: 1,
        policyVersion: 1,
        rootCommitment,
        invocationAudienceCommitment: audienceCommitment,
        repositorySelectionCommitment: repositoryCommitment,
        graphStateCommitment,
        traversalCheckpointRef: checkpointRef,
      });
    }
    if (consumedCheckpointRef !== undefined) {
      await this.ports.checkpoints.remove(consumedCheckpointRef);
    }
    const response = {
      status: "available",
      nodes,
      edges,
      sources,
      ...(continuation === undefined ? {} : { continuation }),
    } as const;
    if (returnedBytes(response) > input.returnedBytesLimit) {
      return { status: "unavailable", reason: "capacity_exceeded" };
    }
    return response;
  }
}
