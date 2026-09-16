import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  CanonicalRecordSourceReadPort,
  RoomLocalMemoryCandidatePort,
} from "@nautilo/reflection-bridge/server";

import {
  SelectedRoomLocalSourceAdapter,
  createHmacOrdinarySourceFingerprintPort,
  type OrdinaryMemorySourceRow,
  type OrdinaryRoomSourceQueryPort,
} from "../../src/reflection/canonical-room-sources";

const ROOM = "55000000-0000-4000-8000-000000000001";
const NAMESPACE = "66000000-0000-4000-8000-000000000001";
const MEMORY = "77000000-0000-4000-8000-000000000001";
const BINDING = `journal:namespace:${NAMESPACE}:ordinary:v1`;
const VECTOR = Object.freeze(new Array<number>(1_536).fill(Math.fround(0.01)));
const QUERY_EMBEDDING = Object.freeze({
  provenance: Object.freeze({
    provider: "openai" as const,
    canonicalModel: "text-embedding-3-small",
    dimensions: 1_536 as const,
    contractVersion: 1 as const,
  }),
  vector: VECTOR,
});
const FINGERPRINTS = createHmacOrdinarySourceFingerprintPort(
  new Uint8Array(32).fill(9),
);

const MEMORY_ROW: OrdinaryMemorySourceRow = Object.freeze({
  id: MEMORY,
  type: "decision",
  content: "Postgres gives us the consistency we need.",
  tier: 1,
  contentRevision: 4,
  updatedAt: new Date("2026-08-14T10:00:00.864Z"),
  updatedAtCoordinate: "2026-08-14T10:00:00.864695Z",
});

function bindings() {
  return {
    resolve: async (bindingRef: string) =>
      bindingRef === BINDING ? { roomId: ROOM, namespaceId: NAMESPACE } : null,
    resolveRoom: async (roomId: string) =>
      roomId === ROOM ? { roomId: ROOM, namespaceId: NAMESPACE } : null,
  };
}

function queries(overrides: Partial<OrdinaryRoomSourceQueryPort> = {}): OrdinaryRoomSourceQueryPort {
  return {
    searchMemories: async () => [{ ...MEMORY_ROW, score: 0.92 }],
    readMemory: async ({ memoryId, namespaceId }) =>
      memoryId === MEMORY && namespaceId === NAMESPACE ? MEMORY_ROW : null,
    readMessage: async ({ messageId, roomId, namespaceId }) =>
      messageId === 42 && roomId === ROOM && namespaceId === NAMESPACE
        ? {
            id: 42,
            roomId: ROOM,
            namespaceId: NAMESPACE,
            content: "Neon is convenient, but Postgres is the durable choice.",
            editRevision: 2,
          }
        : null,
    ...overrides,
  };
}

function adapter(input: Readonly<{
  representation?: "ordinary" | "protected";
  ordinary?: OrdinaryRoomSourceQueryPort;
  protectedMemoryCandidates?: RoomLocalMemoryCandidatePort;
  protectedSource?: CanonicalRecordSourceReadPort;
}> = {}) {
  return new SelectedRoomLocalSourceAdapter({
    selection: {
      selectedRepresentation: input.representation ?? "ordinary",
      migrationGeneration: 1,
    },
    bindings: bindings(),
    ordinary: input.ordinary ?? queries(),
    fingerprints: FINGERPRINTS,
    ...(input.protectedSource === undefined
      ? {}
      : { protectedSource: input.protectedSource }),
    ...(input.protectedMemoryCandidates === undefined
      ? {}
      : { protectedMemoryCandidates: input.protectedMemoryCandidates }),
  });
}

function messageFingerprint(content: string, revision: number): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    "nautilo/stenographer/message-observation/v1",
    42,
    revision,
    content,
  ]), "utf8").digest("hex")}`;
}

describe("selected Room-local Memory and Message source adapter", () => {
  test("returns exact-Room authored Memory candidates with matching provenance", async () => {
    let observed: unknown;
    const ordinary = queries({
      searchMemories: async (input) => {
        observed = input;
        return [{ ...MEMORY_ROW, score: 0.92 }];
      },
    });
    const result = await adapter({ ordinary }).search({
      roomAnchorRef: ROOM,
      embedding: QUERY_EMBEDDING,
      limit: 4,
    });
    expect(observed).toMatchObject({
      namespaceId: NAMESPACE,
      provider: "openai",
      canonicalModel: "text-embedding-3-small",
      dimensions: 1_536,
      contractVersion: 1,
      limit: 4,
    });
    expect(result).toMatchObject({
      status: "available",
      candidates: [{
        score: 0.92,
        snapshot: {
          posture: "authored",
          anchors: [ROOM],
          statement: MEMORY_ROW.content,
          observedRevision: "4",
        },
        dependency: {
          sourceKind: "memory",
          logicalSourceRef: `memory:${MEMORY}`,
          observedRevision: "4",
          terminalAuthorityLeafHandle: NAMESPACE,
          authorityBearing: true,
        },
      }],
    });
  });

  test("drops a Memory changed after vector candidate discovery", async () => {
    const result = await adapter({
      ordinary: queries({
        readMemory: async () => ({
          ...MEMORY_ROW,
          content: "Changed after ranking.",
          contentRevision: 5,
        }),
      }),
    }).search({
      roomAnchorRef: ROOM,
      embedding: QUERY_EMBEDDING,
      limit: 4,
    });
    expect(result).toEqual({ status: "available", candidates: [] });
  });

  test("opens exact current Memory and withholds changed or archived bytes", async () => {
    const dependency = {
      sourceKind: "memory",
      logicalSourceRef: `memory:${MEMORY}`,
      observedRevision: "4",
      observedContentFingerprint: FINGERPRINTS.memory(MEMORY_ROW),
      terminalAuthorityLeafHandle: NAMESPACE,
      authorityBearing: true,
    } as const;
    expect(await adapter().readExact({
      dependency,
      evidenceBindingRef: BINDING,
      returnedBytesMaximum: 8_192,
    })).toEqual({
      status: "available",
      kind: "memory",
      content: MEMORY_ROW.content,
    });
    expect(await adapter({
      ordinary: queries({ readMemory: async () => ({ ...MEMORY_ROW, tier: 3 }) }),
    }).readExact({
      dependency,
      evidenceBindingRef: BINDING,
      returnedBytesMaximum: 8_192,
    })).toEqual({ status: "changed" });
  });

  test("opens a selected cross-Room Memory only at its exact fenced coordinate", async () => {
    const candidate = {
      kind: "memory" as const,
      memoryRef: MEMORY,
      logicalSourceRef: `memory:${MEMORY}` as const,
      score: 0.9,
      contentRevision: 4,
      embeddingRevision: 4,
      embeddingProvenance: QUERY_EMBEDDING.provenance,
      updatedAtCoordinate: MEMORY_ROW.updatedAtCoordinate,
      authorityNamespaceRefs: [NAMESPACE],
      audience: {
        humanRefs: ["11111111-1111-4111-8111-111111111111"],
        includesPublicBoundary: false,
      },
      readNamespaceRef: NAMESPACE,
      readBindingRef: BINDING,
    };
    expect(await adapter().open({ candidate })).toMatchObject({
      status: "available",
      snapshot: {
        recordRef: `memory:${MEMORY}`,
        statement: MEMORY_ROW.content,
        anchors: [ROOM],
      },
      dependency: {
        sourceKind: "memory",
        logicalSourceRef: `memory:${MEMORY}`,
        observedRevision: "4",
        terminalAuthorityLeafHandle: NAMESPACE,
      },
    });
    expect(await adapter().open({
      candidate: { ...candidate, updatedAtCoordinate: "2026-08-14T10:00:00.864696Z" },
    })).toEqual({ status: "stale" });
  });

  test("reauthorizes exact Message Room, revision, and Stenographer fingerprint", async () => {
    const content = "Neon is convenient, but Postgres is the durable choice.";
    const dependency = {
      sourceKind: "message",
      logicalSourceRef: "message:42",
      observedRevision: "2",
      observedContentFingerprint: messageFingerprint(content, 2),
      terminalAuthorityLeafHandle: NAMESPACE,
      authorityBearing: true,
    } as const;
    expect(await adapter().readExact({
      dependency,
      evidenceBindingRef: BINDING,
      returnedBytesMaximum: 8_192,
    })).toEqual({ status: "available", kind: "message", content });
    expect(await adapter().readExact({
      dependency: { ...dependency, observedRevision: "1" },
      evidenceBindingRef: BINDING,
      returnedBytesMaximum: 8_192,
    })).toEqual({ status: "changed" });
    expect(await adapter().readExact({
      dependency: { ...dependency, terminalAuthorityLeafHandle: "other" },
      evidenceBindingRef: BINDING,
      returnedBytesMaximum: 8_192,
    })).toEqual({ status: "unavailable" });
  });

  test("never falls back to ordinary bytes in selected protected mode", async () => {
    let ordinaryReads = 0;
    let protectedReads = 0;
    const protectedAdapter = adapter({
      representation: "protected",
      ordinary: queries({
        searchMemories: async () => {
          ordinaryReads += 1;
          return [];
        },
        readMemory: async () => {
          ordinaryReads += 1;
          return MEMORY_ROW;
        },
      }),
      protectedSource: {
        readExact: async () => {
          protectedReads += 1;
          return { status: "unavailable" as const };
        },
      },
    });
    expect(await protectedAdapter.search({
      roomAnchorRef: ROOM,
      embedding: QUERY_EMBEDDING,
      limit: 4,
    })).toEqual({ status: "unavailable" });
    expect(await protectedAdapter.readExact({
      dependency: {
        sourceKind: "memory",
        logicalSourceRef: `memory:${MEMORY}`,
        terminalAuthorityLeafHandle: NAMESPACE,
        authorityBearing: true,
      },
      evidenceBindingRef: BINDING,
      returnedBytesMaximum: 8_192,
    })).toEqual({ status: "unavailable" });
    expect(ordinaryReads).toBe(0);
    expect(protectedReads).toBe(1);
  });

  test("delegates protected candidates without opening ordinary rows", async () => {
    let ordinaryReads = 0;
    let protectedSearches = 0;
    const protectedAdapter = adapter({
      representation: "protected",
      ordinary: queries({
        searchMemories: async () => {
          ordinaryReads += 1;
          return [];
        },
      }),
      protectedMemoryCandidates: {
        search: async () => {
          protectedSearches += 1;
          return { status: "available", candidates: [] };
        },
      },
    });
    expect(await protectedAdapter.search({
      roomAnchorRef: ROOM,
      embedding: QUERY_EMBEDDING,
      limit: 4,
    })).toEqual({ status: "available", candidates: [] });
    expect(ordinaryReads).toBe(0);
    expect(protectedSearches).toBe(1);
  });
});
