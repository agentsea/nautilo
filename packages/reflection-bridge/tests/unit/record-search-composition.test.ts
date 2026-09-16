import { expect, test } from "bun:test";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import type { RankedRecordCoordinate } from "@nautilo/reflection/search";

import {
  createHmacRecordSearchCommitmentPort,
  createRecordSearchContinuationCodec,
  DualModeAuthorityFilteredRecordSearch,
  DualModeSyntheticRecordEvidence,
  encodeDurableRecordEnvelope,
} from "../../src/server";

const HUMAN = "00000000-0000-4000-8000-000000000001";
const embedding = {
  provenance: {
    provider: "openai" as const,
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536 as const,
    contractVersion: 1 as const,
  },
  vector: Object.freeze(Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0)),
};

function envelope(ref: string, height: number): DurableRecordEnvelope {
  return {
    recordRef: ref,
    semantic: {
      observedContentFingerprint: `sha256:${ref}`,
      posture: "derived",
      statement: `Statement ${ref}`,
      sourceDependencies: [],
      anchors: [],
      childRecordRefs: [],
      producer: { producerRef: "organizer", policyVersion: "v1" },
      terminalAuthorityLeafHandles: [`leaf:${ref}`],
    },
    lifecycle: "current",
    structuralHeight: height,
    processingGeneration: 1,
  };
}

function coordinate(ref: string, score: number, height: number): RankedRecordCoordinate {
  return {
    recordRef: ref,
    score,
    structuralHeight: height,
    recordProcessingGeneration: 1,
    projectionGeneration: 1,
    payloadRepresentationGeneration: 1,
    authorityProjectionGeneration: 1,
  };
}

function currentBinding(recordRef: string, input: Readonly<{
  authorityGeneration?: number;
  representationGeneration?: number;
}> = {}) {
  return {
    originPublicationBindingRef: `read:origin:${recordRef}`,
    currentAccessBindingRefs: [`read:current:${recordRef}`],
    representationGeneration: input.representationGeneration ?? 1,
    authorityProjectionGeneration: input.authorityGeneration ?? 1,
  } as const;
}

test("HMAC commitments always satisfy the portable opaque identifier contract", () => {
  const commitments = createHmacRecordSearchCommitmentPort(
    new Uint8Array(32).fill(19),
  );
  const sampled = Array.from({ length: 256 }, (_, index) =>
    commitments.commit("sample", { index })
  );

  expect(new Set(sampled).size).toBe(sampled.length);
  expect(sampled.every((value) => /^h1\.[A-Za-z0-9_-]{43}$/u.test(value)))
    .toBeTrue();
});

test("streams exact pages so redundant top candidates do not under-fill results", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(7));
  const audience = { humanRefs: [HUMAN], includesPublicBoundary: false } as const;
  const calls: string[] = [];
  const pages = [
    { coordinates: [coordinate("record:a", 0.9, 1), coordinate("record:b", 0.8, 0)], hasMore: true },
    { coordinates: [coordinate("record:c", 0.7, 0)], hasMore: false },
  ];
  const search = new DualModeAuthorityFilteredRecordSearch({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    bindings: {
      resolve: async () => ({
        invocationAudience: audience,
        readBindingRef: "read:one",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    embedding: { embed: async () => ({ status: "available", embedding }) },
    exactSearch: {
      search: async () => {
        calls.push("sql");
        const page = pages.shift()!;
        return { status: "available", corpusStateCoordinate: "3:11:12", ...page };
      },
    } as never,
    eligibility: {
      check: async ({ recordRef }: { recordRef: string }) => {
        calls.push(`eligible:${recordRef}`);
        if (recordRef === "record:hidden-parent") {
          return { status: "unavailable" as const, reason: "not_eligible" as const };
        }
        return { status: "eligible" as const };
      },
    } as never,
    authorityProjections: {
      readCurrent: async (recordRef: string) => ({
        recordRef,
        projectionGeneration: 1,
        representationGeneration: 1,
      }),
    } as never,
    repository: {
      read: async ({ recordRef }: { recordRef: string }) => {
        calls.push(`open:${recordRef}`);
        return { status: "available", record: envelope(recordRef, recordRef === "record:a" ? 1 : 0) };
      },
      readParents: async () => ({
        status: "available",
        page: { items: ["record:hidden-parent", "record:visible-parent"] },
      }),
    } as never,
    eligibleGraph: {
      isEligible: async () => true,
      childrenOf: async ({ recordRef }: { recordRef: string }) => ({
        recordRefs: recordRef === "record:a" ? ["record:b"] : [],
      }),
    },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(8)),
    commitments,
    checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
  });
  const result = await search.search({ query: "postgres decision", limit: 2, searchBindingRef: "bind" });
  expect(result).toMatchObject({
    status: "available",
    results: [
      { recordRef: "record:a", directParentRecordRefs: ["record:visible-parent"] },
      { recordRef: "record:c", directParentRecordRefs: ["record:visible-parent"] },
    ],
  });
  expect(calls.filter((entry) => entry === "sql")).toHaveLength(2);
  expect(calls.indexOf("eligible:record:a")).toBeLessThan(calls.indexOf("open:record:a"));
});

test("returns stale_restart when authority is lost after the exact SQL snapshot", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(13));
  let opened = false;
  const search = new DualModeAuthorityFilteredRecordSearch({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    bindings: {
      resolve: async () => ({
        invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
        readBindingRef: "read:race",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    embedding: { embed: async () => ({ status: "available", embedding }) },
    exactSearch: {
      search: async () => ({
        status: "available",
        coordinates: [coordinate("record:blocked-after-snapshot", 0.9, 0)],
        corpusStateCoordinate: "1:race:race",
        hasMore: true,
      }),
    } as never,
    // Models an immediate direct/leaf block committed after the SQL transaction.
    eligibility: {
      check: async () => ({ status: "unavailable", reason: "not_eligible" }),
    } as never,
    authorityProjections: {
      readCurrent: async () => ({ projectionGeneration: 1, representationGeneration: 1 }),
    } as never,
    repository: {
      read: async () => {
        opened = true;
        return { status: "available", record: envelope("record:blocked-after-snapshot", 0) };
      },
    } as never,
    eligibleGraph: { isEligible: async () => true, childrenOf: async () => ({ recordRefs: [] }) },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(14)),
    commitments,
    checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
  });

  expect(await search.search({
    query: "authority race",
    limit: 1,
    searchBindingRef: "bind",
  })).toEqual({ status: "unavailable", reason: "stale_restart" });
  expect(opened).toBe(false);
});

test("opens full search results through each selected head's current access binding", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(20));
  const openedBindings: string[] = [];
  const search = new DualModeAuthorityFilteredRecordSearch({
    selection: { selectedRepresentation: "protected", migrationGeneration: 5 },
    bindings: {
      resolve: async () => ({
        invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
        readBindingRef: "read:invocation-room",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    embedding: { embed: async () => ({ status: "available", embedding }) },
    exactSearch: {
      search: async () => ({
        status: "available",
        coordinates: [coordinate("record:reprojected", 0.9, 0)],
        corpusStateCoordinate: "1:current:current",
        hasMore: false,
      }),
    } as never,
    eligibility: { check: async () => ({ status: "eligible" }) } as never,
    authorityProjections: {
      readCurrent: async () => ({ projectionGeneration: 1, representationGeneration: 1 }),
    } as never,
    recordBindings: {
      read: async (recordRef) => currentBinding(recordRef),
    },
    repository: {
      read: async ({ recordRef, readBindingRef }: {
        recordRef: string;
        readBindingRef: string;
      }) => {
        openedBindings.push(readBindingRef);
        return { status: "available", record: envelope(recordRef, 0) };
      },
      readParents: async ({ readBindingRef }: { readBindingRef: string }) => {
        openedBindings.push(readBindingRef);
        return { status: "available", page: { items: [] } };
      },
    } as never,
    eligibleGraph: { isEligible: async () => true, childrenOf: async () => ({ recordRefs: [] }) },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(21)),
    commitments,
    checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
  });

  expect(await search.search({
    query: "current protected record",
    limit: 1,
    searchBindingRef: "bind",
  })).toMatchObject({
    status: "available",
    results: [{ recordRef: "record:reprojected" }],
  });
  expect(openedBindings).toEqual([
    "read:current:record:reprojected",
    "read:current:record:reprojected",
  ]);
});

test("does not open a result when its current access binding has a different generation", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(22));
  let opened = false;
  const search = new DualModeAuthorityFilteredRecordSearch({
    selection: { selectedRepresentation: "protected", migrationGeneration: 5 },
    bindings: {
      resolve: async () => ({
        invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
        readBindingRef: "read:invocation-room",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    embedding: { embed: async () => ({ status: "available", embedding }) },
    exactSearch: {
      search: async () => ({
        status: "available",
        coordinates: [coordinate("record:changed", 0.9, 0)],
        corpusStateCoordinate: "1:changed:changed",
        hasMore: false,
      }),
    } as never,
    eligibility: { check: async () => ({ status: "eligible" }) } as never,
    authorityProjections: {
      readCurrent: async () => ({ projectionGeneration: 1, representationGeneration: 1 }),
    } as never,
    recordBindings: {
      read: async (recordRef) => currentBinding(recordRef, { representationGeneration: 2 }),
    },
    repository: {
      read: async () => {
        opened = true;
        return { status: "available", record: envelope("record:changed", 0) };
      },
    } as never,
    eligibleGraph: { isEligible: async () => true, childrenOf: async () => ({ recordRefs: [] }) },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(23)),
    commitments,
    checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
  });

  expect(await search.search({
    query: "stale current binding",
    limit: 1,
    searchBindingRef: "bind",
  })).toEqual({ status: "unavailable", reason: "stale_restart" });
  expect(opened).toBeFalse();
});

test("uses the invocation's explicit current alternative instead of choosing by order", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(26));
  const openedBindings: string[] = [];
  const search = new DualModeAuthorityFilteredRecordSearch({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    bindings: {
      resolve: async () => ({
        invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
        readBindingRef: "read:invocation-room",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    embedding: { embed: async () => ({ status: "available", embedding }) },
    exactSearch: {
      search: async () => ({
        status: "available",
        coordinates: [coordinate("record:shared", 0.9, 0)],
        corpusStateCoordinate: "1:shared:shared",
        hasMore: false,
      }),
    } as never,
    eligibility: { check: async () => ({ status: "eligible" }) } as never,
    authorityProjections: {
      readCurrent: async () => ({ projectionGeneration: 1, representationGeneration: 1 }),
    } as never,
    recordBindings: {
      read: async () => ({
        originPublicationBindingRef: "read:origin",
        currentAccessBindingRefs: ["read:other-room", "read:invocation-room"],
        representationGeneration: 1,
        authorityProjectionGeneration: 1,
      }),
    },
    repository: {
      read: async ({ recordRef, readBindingRef }: {
        recordRef: string;
        readBindingRef: string;
      }) => {
        openedBindings.push(readBindingRef);
        return { status: "available", record: envelope(recordRef, 0) };
      },
      readParents: async () => ({ status: "available", page: { items: [] } }),
    } as never,
    eligibleGraph: { isEligible: async () => true, childrenOf: async () => ({ recordRefs: [] }) },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(27)),
    commitments,
    checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
  });

  expect((await search.search({
    query: "shared current record",
    limit: 1,
    searchBindingRef: "bind",
  })).status).toBe("available");
  expect(openedBindings).toEqual(["read:invocation-room"]);
});

test("ordinary composition selects a reprojected protected structural head without bodies", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(28));
  let protectedGeneration = 2;
  let bindingReads = 0;
  let bodyReads = 0;
  let preferredProtectedHead = false;
  const search = new DualModeAuthorityFilteredRecordSearch({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 5 },
    bindings: {
      resolve: async () => ({
        invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
        readBindingRef: "read:invocation-room",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    embedding: { embed: async () => ({ status: "available", embedding }) },
    exactSearch: {
      search: async (input: { preferProtectedHead?: boolean }) => {
        preferredProtectedHead = input.preferProtectedHead === true;
        return {
          status: "available",
          coordinates: [{
            ...coordinate("record:protected", 0.9, 0),
            payloadRepresentationGeneration: 2,
          }],
          corpusStateCoordinate: "1:protected:protected",
          hasMore: false,
        };
      },
    } as never,
    eligibility: { check: async () => ({ status: "eligible" }) } as never,
    authorityProjections: {
      readCurrent: async () => ({ projectionGeneration: 1, representationGeneration: 1, protectedRepresentationGeneration: protectedGeneration }),
    } as never,
    recordBindings: {
      read: async (recordRef) => {
        bindingReads += 1;
        return currentBinding(recordRef);
      },
    },
    repository: {
      read: async () => {
        bodyReads += 1;
        return { status: "available", record: envelope("record:protected", 0) };
      },
    } as never,
    eligibleGraph: { isEligible: async () => true, childrenOf: async () => ({ recordRefs: [] }) },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(29)),
    commitments,
    checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
  });

  expect(await search.searchStructural({
    query: "protected foreground context",
    limit: 1,
    searchBindingRef: "bind",
  })).toEqual({
    status: "available",
    results: [{
      recordRef: "record:protected",
      score: 0.9,
      structuralHeight: 0,
    }],
  });
  protectedGeneration = 3;
  expect(await search.searchStructural({ query: "protected foreground context", limit: 1, searchBindingRef: "bind" }))
    .toEqual({ status: "unavailable", reason: "stale_restart" });
  expect(bindingReads).toBe(0);
  expect(bodyReads).toBe(0);
  expect(preferredProtectedHead).toBeTrue();
});

test("ordinary after protected reprojection and protected compositions rank, continue, and expand identically", async () => {
  const outcomes = [];
  for (const representation of ["ordinary", "protected"] as const) {
    const commitments = createHmacRecordSearchCommitmentPort(
      new Uint8Array(32).fill(representation === "ordinary" ? 15 : 16),
    );
    const audience = { humanRefs: [HUMAN], includesPublicBoundary: true } as const;
    const binding = {
      invocationAudience: audience,
      readBindingRef: `read:${representation}`,
      invocationAudienceCommitment: commitments.commit("audience", {
        humanRefs: [HUMAN], includesPublicBoundary: true,
      }),
    };
    const repository = {
      read: async ({ recordRef }: { recordRef: string }) => ({
        status: "available" as const,
        record: envelope(recordRef, recordRef === "record:parent" ? 1 : 0),
      }),
      readParents: async () => ({ status: "available" as const, page: { items: [] } }),
      readDependencies: async () => ({ status: "available" as const, page: { items: [] } }),
    };
    const search = new DualModeAuthorityFilteredRecordSearch({
      selection: { selectedRepresentation: representation, migrationGeneration: 7 },
      bindings: { resolve: async () => binding },
      embedding: { embed: async () => ({ status: "available", embedding }) },
      exactSearch: {
        search: async ({ after }: { after?: { recordRef: string } }) => ({
          status: "available",
          coordinates: after === undefined
            ? [coordinate("record:parent", 0.9, 1)]
            : [coordinate("record:leaf", 0.8, 0)],
          corpusStateCoordinate: "2:stable:stable",
          hasMore: after === undefined,
        }),
      } as never,
      eligibility: { check: async () => ({ status: "eligible" }) } as never,
      authorityProjections: {
        readCurrent: async () => ({
          projectionGeneration: 1,
          representationGeneration: 1,
          ...(representation === "ordinary"
            ? {
                protectedCryptoObjectId: "protected:generation:2",
                protectedAuthorityCurrent: true,
              }
            : {}),
        }),
      } as never,
      recordBindings: {
        read: async (recordRef) => currentBinding(recordRef),
      },
      repository: repository as never,
      eligibleGraph: { isEligible: async () => true, childrenOf: async () => ({ recordRefs: [] }) },
      continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(17)),
      commitments,
      checkpoints: { load: async () => null, save: async () => {}, remove: async () => {} },
    });
    const first = await search.search({ query: "postgres", limit: 1, searchBindingRef: "bind" });
    expect(first.status).toBe("available");
    if (first.status !== "available" || first.continuation === undefined) {
      throw new Error("expected the first search page to continue");
    }
    const second = await search.search({
      query: "postgres",
      limit: 1,
      searchBindingRef: "bind",
      continuation: first.continuation,
    });
    const evidence = new DualModeSyntheticRecordEvidence({
      selection: { selectedRepresentation: representation, migrationGeneration: 7 },
      bindings: { resolve: async () => binding },
      eligibility: { check: async () => ({ status: "eligible" }) } as never,
      authorityProjections: {
        readCurrent: async () => ({
          projectionGeneration: 1,
          representationGeneration: 1,
          ...(representation === "ordinary"
            ? {
                protectedCryptoObjectId: "protected:generation:2",
                protectedAuthorityCurrent: true,
              }
            : {}),
        }),
      } as never,
      recordBindings: {
        read: async (recordRef) => currentBinding(recordRef),
      },
      repository: repository as never,
      sources: { read: async () => ({ status: "unavailable", reason: "source_unavailable" }) },
      checkpoints: { save: async () => "unused", load: async () => null, remove: async () => {} },
      continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(18)),
      commitments,
    }).expand({
      rootRecordRef: "record:parent",
      evidenceBindingRef: "bind",
      traversalWorkLimit: 2,
      openedPayloadBytesLimit: 65_536,
      returnedBytesLimit: 65_536,
    });
    outcomes.push({
      first: { ...first, continuation: undefined },
      second,
      evidence: await evidence,
    });
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
});

test("evidence returns capacity_exceeded instead of an unchanged oversized-child continuation", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(11));
  const audience = { humanRefs: [HUMAN], includesPublicBoundary: false } as const;
  const root = envelope("record:root", 1);
  const child = envelope("record:large-child", 0);
  const evidence = new DualModeSyntheticRecordEvidence({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    bindings: {
      resolve: async () => ({
        invocationAudience: audience,
        readBindingRef: "read:ordinary",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    eligibility: { check: async () => ({ status: "eligible" }) } as never,
    authorityProjections: {
      readCurrent: async (recordRef: string) => ({ recordRef, projectionGeneration: 1, representationGeneration: 1 }),
    } as never,
    repository: {
      read: async ({ recordRef }: { recordRef: string }) => ({
        status: "available",
        record: recordRef === root.recordRef ? root : child,
      }),
      readDependencies: async () => ({ status: "available", page: { items: [child.recordRef] } }),
    } as never,
    sources: { read: async () => ({ status: "unavailable", reason: "source_unavailable" }) },
    checkpoints: { save: async () => "checkpoint", load: async () => null, remove: async () => {} },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(12)),
    commitments,
  });
  expect(await evidence.expand({
    rootRecordRef: root.recordRef,
    evidenceBindingRef: "bind",
    traversalWorkLimit: 2,
    openedPayloadBytesLimit: encodeDurableRecordEnvelope(root).byteLength + 1,
    returnedBytesLimit: 65_536,
  })).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
});

test("opens evidence roots and children through their own current access bindings", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(24));
  const audience = { humanRefs: [HUMAN], includesPublicBoundary: false } as const;
  const opened: string[] = [];
  const evidence = new DualModeSyntheticRecordEvidence({
    selection: { selectedRepresentation: "protected", migrationGeneration: 5 },
    bindings: {
      resolve: async () => ({
        invocationAudience: audience,
        readBindingRef: "read:invocation-room",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    eligibility: { check: async () => ({ status: "eligible" }) } as never,
    authorityProjections: {
      readCurrent: async (recordRef: string) => ({
        recordRef,
        projectionGeneration: 1,
        representationGeneration: 1,
      }),
    } as never,
    recordBindings: { read: async (recordRef) => currentBinding(recordRef) },
    repository: {
      read: async ({ recordRef, readBindingRef }: {
        recordRef: string;
        readBindingRef: string;
      }) => {
        opened.push(`${recordRef}:${readBindingRef}`);
        return {
          status: "available",
          record: envelope(recordRef, recordRef === "record:root" ? 1 : 0),
        };
      },
      readDependencies: async ({ readBindingRef }: { readBindingRef: string }) => {
        opened.push(`dependencies:${readBindingRef}`);
        return { status: "available", page: { items: ["record:child"] } };
      },
    } as never,
    sources: { read: async () => ({ status: "unavailable", reason: "source_unavailable" }) },
    checkpoints: { save: async () => "unused", load: async () => null, remove: async () => {} },
    continuations: createRecordSearchContinuationCodec(new Uint8Array(32).fill(25)),
    commitments,
  });

  expect(await evidence.expand({
    rootRecordRef: "record:root",
    evidenceBindingRef: "bind",
    traversalWorkLimit: 3,
    openedPayloadBytesLimit: 65_536,
    returnedBytesLimit: 65_536,
  })).toMatchObject({
    status: "available",
    nodes: [{ recordRef: "record:root" }, { recordRef: "record:child" }],
  });
  expect(opened).toEqual([
    "record:root:read:current:record:root",
    "dependencies:read:current:record:root",
    "record:child:read:current:record:child",
  ]);
});

test("evidence seals mid-page state and resumes without exposing skipped handles", async () => {
  const commitments = createHmacRecordSearchCommitmentPort(new Uint8Array(32).fill(9));
  const codec = createRecordSearchContinuationCodec(new Uint8Array(32).fill(10));
  const audience = { humanRefs: [HUMAN], includesPublicBoundary: false } as const;
  const records = new Map([
    ["record:root", envelope("record:root", 1)],
    ["record:hidden", envelope("record:hidden", 0)],
    ["record:visible", envelope("record:visible", 0)],
  ]);
  const checkpoints = new Map<string, unknown>();
  let checkpointSequence = 0;
  const evidence = new DualModeSyntheticRecordEvidence({
    selection: { selectedRepresentation: "protected", migrationGeneration: 1 },
    bindings: {
      resolve: async () => ({
        invocationAudience: audience,
        readBindingRef: "read:protected",
        invocationAudienceCommitment: commitments.commit("audience", {
          humanRefs: [HUMAN], includesPublicBoundary: false,
        }),
      }),
    },
    eligibility: {
      check: async ({ recordRef }: { recordRef: string }) => recordRef === "record:hidden"
        ? { status: "unavailable" as const, reason: "not_eligible" as const }
        : { status: "eligible" as const },
    } as never,
    authorityProjections: {
      readCurrent: async (recordRef: string) => ({
        recordRef,
        projectionGeneration: 1,
        representationGeneration: 1,
      }),
    } as never,
    repository: {
      read: async ({ recordRef }: { recordRef: string }) => ({
        status: "available",
        record: records.get(recordRef)!,
      }),
      readDependencies: async () => ({
        status: "available",
        page: { items: ["record:hidden", "record:visible"] },
      }),
    } as never,
    sources: { read: async () => ({ status: "unavailable", reason: "source_unavailable" }) },
    checkpoints: {
      save: async (checkpoint) => {
        const ref = `checkpoint:${++checkpointSequence}`;
        checkpoints.set(ref, checkpoint);
        return ref;
      },
      load: async (ref) => checkpoints.get(ref) as never ?? null,
      remove: async (ref) => { checkpoints.delete(ref); },
    },
    continuations: codec,
    commitments,
  });
  const first = await evidence.expand({
    rootRecordRef: "record:root",
    evidenceBindingRef: "bind",
    traversalWorkLimit: 2,
    openedPayloadBytesLimit: 65_536,
    returnedBytesLimit: 65_536,
  });
  expect(first.status).toBe("available");
  if (first.status !== "available") return;
  expect(first.nodes.map((node) => node.recordRef)).toEqual(["record:root"]);
  expect(first.continuation).toBeDefined();
  expect(first.continuation).not.toContain("record:hidden");
  const continuation = first.continuation;
  if (continuation === undefined) throw new Error("expected evidence continuation");
  const second = await evidence.expand({
    rootRecordRef: "record:root",
    evidenceBindingRef: "bind",
    traversalWorkLimit: 3,
    openedPayloadBytesLimit: 65_536,
    returnedBytesLimit: 65_536,
    continuation,
  });
  expect(second).toMatchObject({
    status: "available",
    nodes: [{ recordRef: "record:root" }, { recordRef: "record:visible" }],
    edges: [{ childRecordRef: "record:visible", childPosition: 1 }],
  });
});
