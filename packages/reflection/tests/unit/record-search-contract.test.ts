import { describe, expect, test } from "bun:test";
import {
  RECORD_SEARCH_POLICY_V1,
  assertCanonicalRecordEmbeddingV1,
  assertRecordEmbeddingRequest,
  assertRecordEvidenceContinuationStateV1,
  assertRecordEvidenceContinuationToken,
  assertRecordEvidenceRequest,
  assertRecordRedundancyContinuationStateV1,
  assertRecordSearchContinuationStateV1,
  assertRecordSearchContinuationToken,
  assertRecordSearchRequest,
  canonicalizeCosineScore,
  canonicalizeRecordEmbeddingV1,
  rankRecordSearchCoordinates,
  redactHiddenEvidenceEdges,
  recordEmbeddingProvenanceMatches,
  resetRecordRedundancyCallBudget,
  strictUtf8ByteLength,
  suppressRedundantHierarchyResults,
  validateRecordSearchProjectionV1,
  type EligibleHierarchyCoordinatePort,
  type RankedRecordCoordinate,
  type RecordEmbeddingV1,
  type RecordRedundancyContinuationStateV1,
  type SyntheticRecordEvidenceReaderPort,
} from "../../src/search";

const provenance = {
  provider: "provider.v1",
  canonicalModel: "model.v1",
  dimensions: 1_536,
  contractVersion: 1,
} as const;

function vector(value = 1): number[] {
  const result = new Array<number>(RECORD_SEARCH_POLICY_V1.embeddingDimensions).fill(0);
  result[0] = value;
  return result;
}

function embedding(value = 1): RecordEmbeddingV1 {
  return {
    provenance,
    vector: canonicalizeRecordEmbeddingV1(vector(value)),
  };
}

function coordinate(
  recordRef: string,
  score: number,
  structuralHeight = 0,
): RankedRecordCoordinate {
  return {
    recordRef,
    score,
    structuralHeight,
    recordProcessingGeneration: 1,
    projectionGeneration: 1,
    payloadRepresentationGeneration: 1,
    authorityProjectionGeneration: 1,
  };
}

function graph(input: {
  readonly children?: Readonly<Record<string, readonly string[]>>;
  readonly eligible: readonly string[];
}): EligibleHierarchyCoordinatePort {
  const eligible = new Set(input.eligible);
  return {
    childrenOf: async ({ recordRef, limit, continuation }) => {
      const offset = continuation === undefined
        ? 0
        : Number.parseInt(continuation.slice("page:".length), 10);
      const children = input.children?.[recordRef] ?? [];
      const recordRefs = children.slice(offset, offset + limit);
      const nextOffset = offset + recordRefs.length;
      return {
        recordRefs,
        ...(nextOffset >= children.length
          ? {}
          : { continuation: `page:${nextOffset}` }),
      };
    },
    isEligible: async (recordRef) => eligible.has(recordRef),
  };
}

describe("RECORD_SEARCH_POLICY_V1", () => {
  test("locks every Wave-6 byte and work bound in one immutable object", () => {
    expect(Object.isFrozen(RECORD_SEARCH_POLICY_V1)).toBe(true);
    expect(RECORD_SEARCH_POLICY_V1).toEqual({
      policyVersion: 1,
      projectionVersion: 1,
      embeddingContractVersion: 1,
      referenceIdentifierMinimumUtf8Bytes: 1,
      referenceIdentifierMaximumUtf8Bytes: 128,
      providerIdentifierMinimumUtf8Bytes: 1,
      providerIdentifierMaximumUtf8Bytes: 256,
      canonicalModelIdentifierMinimumUtf8Bytes: 1,
      canonicalModelIdentifierMaximumUtf8Bytes: 256,
      embeddingDimensions: 1_536,
      pgvectorPayloadBytes: 6_152,
      pgvectorExternalPayloadBytes: 6_148,
      queryMinimumUtf8Bytes: 1,
      queryMaximumUtf8Bytes: 4_096,
      recordStatementMaximumUtf8Bytes: 64 * 1_024,
      resultPageMinimum: 1,
      resultPageMaximum: 64,
      exactScanStatementTimeoutMilliseconds: 5_000,
      traversalWorkMaximum: 4_096,
      evidenceAdditionalDepthMaximum: 1,
      openedRecordPayloadBytesMaximum: 4 * 1_024 * 1_024,
      returnedBytesMaximum: 256 * 1_024,
      searchContinuationBytesMaximum: 4 * 1_024,
      evidenceContinuationBytesMaximum: 64 * 1_024,
      graphPageMaximum: 256,
      cosineScoreTolerance: 1e-6,
    });
    expect(4 * RECORD_SEARCH_POLICY_V1.embeddingDimensions + 8).toBe(
      RECORD_SEARCH_POLICY_V1.pgvectorPayloadBytes,
    );
    expect(4 * RECORD_SEARCH_POLICY_V1.embeddingDimensions + 4).toBe(
      RECORD_SEARCH_POLICY_V1.pgvectorExternalPayloadBytes,
    );
  });
});

describe("strict byte and request validation", () => {
  test("counts Unicode UTF-8 bytes and rejects malformed UTF-16", () => {
    expect(strictUtf8ByteLength("a💭é")).toBe(7);
    expect(strictUtf8ByteLength("💭".repeat(1_024))).toBe(4_096);
    expect(() => strictUtf8ByteLength("\ud800")).toThrow(/unpaired high surrogate/);
    expect(() => strictUtf8ByteLength("\udc00")).toThrow(/unpaired low surrogate/);
  });

  test("enforces query bytes and result pages without character-count drift", () => {
    const base = { searchBindingRef: "binding:v1", limit: 64 };
    expect(() => assertRecordSearchRequest({ ...base, query: "a".repeat(4_096) })).not.toThrow();
    expect(() => assertRecordSearchRequest({ ...base, query: "💭".repeat(1_024) })).not.toThrow();
    expect(() => assertRecordSearchRequest({ ...base, query: "a".repeat(4_097) })).toThrow(RangeError);
    expect(() => assertRecordSearchRequest({ ...base, query: "💭".repeat(1_024) + "a" })).toThrow(RangeError);
    expect(() => assertRecordSearchRequest({ ...base, query: "" })).toThrow(RangeError);
    expect(() => assertRecordSearchRequest({ ...base, query: "\ud800" })).toThrow(TypeError);
    expect(() => assertRecordSearchRequest({ ...base, query: "ok", limit: 0 })).toThrow(RangeError);
    expect(() => assertRecordSearchRequest({ ...base, query: "ok", limit: 65 })).toThrow(RangeError);
  });

  test("enforces embedding purpose and plaintext bytes", () => {
    expect(() => assertRecordEmbeddingRequest({
      purpose: "record.query_embedding",
      plaintext: "q",
    })).not.toThrow();
    expect(() => assertRecordEmbeddingRequest({
      purpose: "record.statement_embedding",
      plaintext: "s".repeat(64 * 1_024),
    })).not.toThrow();
    expect(() => assertRecordEmbeddingRequest({
      purpose: "record.query_embedding",
      plaintext: "s".repeat(4_097),
    })).toThrow(RangeError);
    expect(() => assertRecordEmbeddingRequest({
      purpose: "record.statement_embedding",
      plaintext: "s".repeat(64 * 1_024 + 1),
    })).toThrow(RangeError);
  });

  test("enforces continuation and evidence budgets by UTF-8 bytes", () => {
    expect(() => assertRecordSearchContinuationToken("a".repeat(4_096))).not.toThrow();
    expect(() => assertRecordSearchContinuationToken("💭".repeat(1_024))).not.toThrow();
    expect(() => assertRecordSearchContinuationToken("a".repeat(4_097))).toThrow(RangeError);
    expect(() => assertRecordEvidenceContinuationToken("a".repeat(64 * 1_024))).not.toThrow();
    expect(() => assertRecordEvidenceContinuationToken("a".repeat(64 * 1_024 + 1))).toThrow(RangeError);

    const maximumRequest = {
      rootRecordRef: "record:root",
      evidenceBindingRef: "binding:evidence",
      traversalWorkLimit: 4_096,
      openedPayloadBytesLimit: 4 * 1_024 * 1_024,
      returnedBytesLimit: 256 * 1_024,
      continuation: "checkpoint",
    };
    expect(() => assertRecordEvidenceRequest(maximumRequest)).not.toThrow();
    for (const changed of [
      { traversalWorkLimit: 4_097 },
      { openedPayloadBytesLimit: 4 * 1_024 * 1_024 + 1 },
      { returnedBytesLimit: 256 * 1_024 + 1 },
      { continuation: "a".repeat(64 * 1_024 + 1) },
    ]) {
      expect(() => assertRecordEvidenceRequest({ ...maximumRequest, ...changed })).toThrow();
    }
  });
});

describe("float32 embedding contract", () => {
  test("canonicalizes exactly 1,536 finite components and freezes the result", () => {
    const input = new Float64Array(vector(0.1));
    const canonical = canonicalizeRecordEmbeddingV1(input);
    expect(canonical).toHaveLength(1_536);
    expect(canonical[0]).toBe(Math.fround(0.1));
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  test("rejects dimensions, non-finite values, overflow, and zero after float32 conversion", () => {
    expect(() => canonicalizeRecordEmbeddingV1(new Array(1_535).fill(1))).toThrow(RangeError);
    expect(() => canonicalizeRecordEmbeddingV1(new Array(1_537).fill(1))).toThrow(RangeError);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalizeRecordEmbeddingV1(vector(value))).toThrow(TypeError);
    }
    expect(() => canonicalizeRecordEmbeddingV1(vector(Number.MAX_VALUE))).toThrow(/float32/);
    expect(() => canonicalizeRecordEmbeddingV1(new Array(1_536).fill(0))).toThrow(/non-zero norm/);
    expect(() => canonicalizeRecordEmbeddingV1(vector(Number.MIN_VALUE))).toThrow(/non-zero norm/);
  });

  test("detects float32 drift rather than silently accepting a noncanonical projection", () => {
    const drifted: RecordEmbeddingV1 = { provenance, vector: vector(0.1) };
    expect(() => assertCanonicalRecordEmbeddingV1(drifted)).toThrow(/not canonical float32/);
    expect(() => assertCanonicalRecordEmbeddingV1(embedding(0.1))).not.toThrow();
  });

  test("validates versions, byte bounds, generations, and exact provenance", () => {
    const projection = {
      recordRef: "r".repeat(128),
      recordProcessingGeneration: 1,
      projectionVersion: 1,
      projectionGeneration: 2,
      embedding: embedding(),
    } as const;
    expect(() => validateRecordSearchProjectionV1(projection)).not.toThrow();
    expect(() => validateRecordSearchProjectionV1({
      ...projection,
      recordRef: "r".repeat(129),
    })).toThrow(TypeError);
    expect(() => validateRecordSearchProjectionV1({
      ...projection,
      embedding: {
        ...projection.embedding,
        provenance: { ...provenance, provider: "p".repeat(257) },
      },
    })).toThrow(TypeError);
    expect(recordEmbeddingProvenanceMatches(provenance, { ...provenance })).toBe(true);
    expect(recordEmbeddingProvenanceMatches(provenance, {
      ...provenance,
      canonicalModel: "model.v2",
    })).toBe(false);
  });
});

describe("stable all-height ranking", () => {
  test("orders score descending, then height descending, then Record ID ascending", () => {
    const ranked = rankRecordSearchCoordinates([
      coordinate("z", 0.5, 100),
      coordinate("b", 0.8, 0),
      coordinate("a", 0.8, 7),
      coordinate("c", 0.8, 7),
      coordinate("leaf", -0.4, 0),
    ]);
    expect(ranked.map((entry) => entry.recordRef)).toEqual(["a", "c", "b", "z", "leaf"]);
    expect(Object.isFrozen(ranked)).toBe(true);
  });

  test("accepts only the declared float32 cosine tolerance", () => {
    expect(canonicalizeCosineScore(1 + 0.5e-6)).toBe(1);
    expect(canonicalizeCosineScore(-1 - 0.5e-6)).toBe(-1);
    expect(() => canonicalizeCosineScore(1 + 2e-6)).toThrow(RangeError);
    expect(() => canonicalizeCosineScore(Number.NaN)).toThrow(TypeError);
  });

  test("preserves Wave-3 earlier-result suppression and valuable leaves", async () => {
    const ranked = rankRecordSearchCoordinates([
      coordinate("postgres", 0.95),
      coordinate("parent-database", 0.9, 1),
      coordinate("leaf", 0.7),
    ]);
    const result = await suppressRedundantHierarchyResults({
      rankedCoordinates: ranked,
      graph: graph({
        children: { "parent-database": ["postgres", "neon"] },
        eligible: ["postgres", "parent-database", "leaf"],
      }),
      resultLimit: 5,
      traversalWorkLimit: 100,
      rankCommitment: "rank:v1",
      rankPageCommitment: "page:v1",
      hasMoreRankedCoordinates: false,
    });
    expect(result.results.map((entry) => entry.recordRef)).toEqual(["postgres", "leaf"]);
    expect(result.redundancySuppressedCount).toBe(1);
    expect(result.continuation).toBeUndefined();
  });

  test("traverses an eligible intermediate Record absent from the rank page", async () => {
    const ranked = rankRecordSearchCoordinates([
      coordinate("A", 0.9, 2),
      coordinate("C", 0.8, 0),
    ]);
    const result = await suppressRedundantHierarchyResults({
      rankedCoordinates: ranked,
      graph: graph({ children: { A: ["B"], B: ["C"] }, eligible: ["A", "B", "C"] }),
      resultLimit: 5,
      traversalWorkLimit: 100,
      rankCommitment: "rank:intermediate",
      rankPageCommitment: "page:intermediate",
      hasMoreRankedCoordinates: false,
    });
    expect(result.results.map((entry) => entry.recordRef)).toEqual(["A"]);
    expect(result.redundancySuppressedCount).toBe(1);
  });

  test("reads every bounded child page without canonical truncation", async () => {
    const intermediates = Array.from({ length: 256 }, (_, index) => `B-${index}`);
    const children = { A: [...intermediates, "C"] };
    const requestedLimits: number[] = [];
    const hierarchy: EligibleHierarchyCoordinatePort = {
      childrenOf: async ({ recordRef, limit, continuation }) => {
        requestedLimits.push(limit);
        const offset = continuation === undefined
          ? 0
          : Number.parseInt(continuation.slice("page:".length), 10);
        const all = children[recordRef as keyof typeof children] ?? [];
        const recordRefs = all.slice(offset, offset + limit);
        const nextOffset = offset + recordRefs.length;
        return {
          recordRefs,
          ...(nextOffset < all.length ? { continuation: `page:${nextOffset}` } : {}),
        };
      },
      isEligible: async () => true,
    };
    const result = await suppressRedundantHierarchyResults({
      rankedCoordinates: rankRecordSearchCoordinates([
        coordinate("A", 0.9, 2),
        coordinate("C", 0.8, 0),
      ]),
      graph: hierarchy,
      resultLimit: 5,
      traversalWorkLimit: 4_096,
      rankCommitment: "rank:paged",
      rankPageCommitment: "page:paged",
      hasMoreRankedCoordinates: false,
    });
    expect(result.results.map((entry) => entry.recordRef)).toEqual(["A"]);
    expect(requestedLimits.every((limit) => limit === 256)).toBe(true);
    expect(requestedLimits.length).toBeGreaterThan(1);
  });

  test("rejects over-limit and non-progressing child pages", async () => {
    const ranked = rankRecordSearchCoordinates([
      coordinate("A", 0.9, 1),
      coordinate("C", 0.8, 0),
    ]);
    for (const childrenOf of [
      async () => ({ recordRefs: new Array<string>(257).fill("x") }),
      async () => ({ recordRefs: ["x"], continuation: "page:0" }),
    ]) {
      let failure: unknown;
      try {
        await suppressRedundantHierarchyResults({
          rankedCoordinates: ranked,
          graph: { childrenOf, isEligible: async () => true },
          resultLimit: 5,
          traversalWorkLimit: 100,
          rankCommitment: "rank:invalid-page",
          rankPageCommitment: "page:invalid",
          hasMoreRankedCoordinates: false,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
    }
  });

  test("fills a result page across stable rank pages after suppression", async () => {
    const hierarchy = graph({ children: { A: ["B"] }, eligible: ["A", "B", "C"] });
    const first = await suppressRedundantHierarchyResults({
      rankedCoordinates: rankRecordSearchCoordinates([
        coordinate("A", 0.9, 1),
        coordinate("B", 0.8, 0),
      ]),
      graph: hierarchy,
      resultLimit: 2,
      traversalWorkLimit: 100,
      rankCommitment: "rank:stream",
      rankPageCommitment: "page:stream:1",
      hasMoreRankedCoordinates: true,
    });
    expect(first.results.map((entry) => entry.recordRef)).toEqual(["A"]);
    expect(first.continuation?.resumeKind).toBe("next_rank_page");
    expect(first.redundancySuppressedCount).toBe(1);

    const second = await suppressRedundantHierarchyResults({
      rankedCoordinates: rankRecordSearchCoordinates([coordinate("C", 0.7, 0)]),
      graph: hierarchy,
      resultLimit: 2,
      traversalWorkLimit: 100,
      rankCommitment: "rank:stream",
      rankPageCommitment: "page:stream:2",
      hasMoreRankedCoordinates: false,
      continuation: first.continuation!,
    });
    expect(second.results.map((entry) => entry.recordRef)).toEqual(["A", "C"]);
    expect(second.continuation).toBeUndefined();
    expect(second.redundancySuppressedCount).toBe(1);
    expect(second.cumulativeVisitedCoordinates).toBeGreaterThan(
      second.visitedCoordinates,
    );
  });

  test("pauses and resumes bounded traversal without changing the result", async () => {
    const ranked = rankRecordSearchCoordinates([
      coordinate("A", 0.9, 2),
      coordinate("C", 0.8, 0),
      coordinate("D", 0.7, 0),
    ]);
    const hierarchy = graph({
      children: { A: ["B"], B: ["C"] },
      eligible: ["A", "B", "C", "D"],
    });
    const expected = (await suppressRedundantHierarchyResults({
      rankedCoordinates: ranked,
      graph: hierarchy,
      resultLimit: 5,
      traversalWorkLimit: 100,
      rankCommitment: "rank:resume",
      rankPageCommitment: "page:resume",
      hasMoreRankedCoordinates: false,
    })).results.map((entry) => entry.recordRef);

    for (const workLimit of [1, 2, 3, 4, 5]) {
      let continuation: RecordRedundancyContinuationStateV1 | undefined;
      let final: readonly RankedRecordCoordinate[] = [];
      let suppressed = 0;
      let calls = 0;
      do {
        const result = await suppressRedundantHierarchyResults({
          rankedCoordinates: ranked,
          graph: hierarchy,
          resultLimit: 5,
          traversalWorkLimit: workLimit,
          rankCommitment: "rank:resume",
          rankPageCommitment: "page:resume",
          hasMoreRankedCoordinates: false,
          ...(continuation === undefined ? {} : { continuation }),
        });
        expect(result.visitedCoordinates).toBeLessThanOrEqual(workLimit);
        final = result.results;
        suppressed = result.redundancySuppressedCount;
        continuation = result.continuation === undefined
          ? undefined
          : resetRecordRedundancyCallBudget(result.continuation);
        calls += 1;
      } while (continuation !== undefined && calls < 20);

      if (workLimit === 1) expect(calls).toBeGreaterThan(1);
      expect(continuation).toBeUndefined();
      expect(final.map((entry) => entry.recordRef)).toEqual(expected);
      expect(suppressed).toBe(1);
    }
  });

  test("never traverses or serializes an authority-hidden intermediate", async () => {
    const ranked = rankRecordSearchCoordinates([
      coordinate("A", 0.9, 2),
      coordinate("C", 0.8, 0),
    ]);
    const hierarchy = graph({
      children: { A: ["secret"], secret: ["C"] },
      eligible: ["A", "C"],
    });
    const result = await suppressRedundantHierarchyResults({
      rankedCoordinates: ranked,
      graph: hierarchy,
      resultLimit: 5,
      traversalWorkLimit: 1,
      rankCommitment: "rank:hidden",
      rankPageCommitment: "page:hidden",
      hasMoreRankedCoordinates: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.results.map((entry) => entry.recordRef)).toEqual(["A"]);
    expect(result.continuation).toBeDefined();
    const exhausted = await suppressRedundantHierarchyResults({
      rankedCoordinates: ranked,
      graph: hierarchy,
      resultLimit: 5,
      traversalWorkLimit: 1,
      rankCommitment: "rank:hidden",
      rankPageCommitment: "page:hidden",
      hasMoreRankedCoordinates: false,
      continuation: result.continuation!,
    });
    expect(exhausted.visitedCoordinates).toBe(0);
    expect(exhausted.cumulativeVisitedCoordinates).toBe(1);
    expect(exhausted.continuation).toBeDefined();
    let failure: unknown;
    try {
      await assertRecordRedundancyContinuationStateV1({
        ...result.continuation!,
      path: {
        ...result.continuation!.path!,
        pendingRecordRefs: ["secret"],
        },
      }, ranked, "rank:hidden", "page:hidden", hierarchy);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("hidden reference");
  });
});

describe("logical continuation and evidence redaction", () => {
  test("source evidence readers receive exact immutable source provenance", async () => {
    let observed: Parameters<SyntheticRecordEvidenceReaderPort["read"]>[0] | undefined;
    const reader: SyntheticRecordEvidenceReaderPort = {
      read: (input) => {
        observed = input;
        return Promise.resolve({ status: "unavailable", reason: "source_changed" });
      },
    };
    const sourceDependency = {
      sourceKind: "memory/v1",
      logicalSourceRef: "memory:logical",
      observedRevision: "revision:7",
      observedContentFingerprint: "fingerprint:7",
      terminalAuthorityLeafHandle: "authority:room",
      authorityBearing: true,
    } as const;
    const result = await reader.read({
      sourceDependency,
      evidenceBindingRef: "binding:evidence",
      returnedBytesRemaining: 1_024,
    });
    expect(observed?.sourceDependency).toEqual(sourceDependency);
    expect(result).toEqual({ status: "unavailable", reason: "source_changed" });
  });

  test("validates commitment-only search and evidence states", () => {
    const searchState = {
      version: 1,
      policyVersion: 1,
      queryCommitment: "query:commitment",
      invocationAudienceCommitment: "audience:commitment",
      repositorySelectionCommitment: "repository:commitment",
      corpusStateCommitment: "corpus:commitment",
      lastEligiblePosition: { recordRef: "visible", score: 0.25, structuralHeight: 42 },
    } as const;
    const evidenceState = {
      version: 1,
      policyVersion: 1,
      rootCommitment: "root:commitment",
      invocationAudienceCommitment: "audience:commitment",
      repositorySelectionCommitment: "repository:commitment",
      graphStateCommitment: "graph:commitment",
      traversalCheckpointRef: "sealed:checkpoint",
    } as const;
    expect(() => assertRecordSearchContinuationStateV1(searchState)).not.toThrow();
    expect(() => assertRecordEvidenceContinuationStateV1(evidenceState)).not.toThrow();
    const serialized = JSON.stringify({ searchState, evidenceState });
    for (const forbidden of ["query text", "statement body", "source:secret", "hidden-record"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() => assertRecordSearchContinuationStateV1({
      ...searchState,
      policyVersion: 2 as 1,
    })).toThrow(/incompatible/);
  });

  test("redacts every edge with a hidden endpoint and preserves stable order", () => {
    const edges = [
      { parentRecordRef: "root", childRecordRef: "visible-a", childPosition: 0 },
      { parentRecordRef: "root", childRecordRef: "hidden-child", childPosition: 1 },
      { parentRecordRef: "hidden-parent", childRecordRef: "visible-b", childPosition: 2 },
      { parentRecordRef: "visible-a", childRecordRef: "visible-b", childPosition: 3 },
    ];
    const visible = redactHiddenEvidenceEdges(
      edges,
      new Set(["root", "visible-a", "visible-b"]),
    );
    expect(visible).toEqual([edges[0]!, edges[3]!]);
    expect(JSON.stringify(visible)).not.toContain("hidden-");
    expect(Object.isFrozen(visible)).toBe(true);
  });
});
