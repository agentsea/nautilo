import { describe, expect, test } from "bun:test";
import {
  MODEL_INPUT_EXPOSURE_METADATA_KEY,
  bindModelInputExposure,
  modelInputExposureMetadataForPersistence,
} from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import {
  assertSamePersonalMemoryEvidence,
  classifyPersonalMemoryEvidence,
  PersonalMemoryEvidenceChangedError,
  stenographerJournalEventObservationFingerprint,
  stenographerJournalRollupObservationFingerprint,
  type MemorySourceDerivation,
  type RecordRepositorySelection,
} from "@nautilo/reflection-bridge/server";
import {
  createHmacOrdinarySourceFingerprintPort,
  reflectionMessageSourceFingerprint,
} from "@nautilo/runtime";

import { createPersonalMemoryEvidencePort } from "../../src/lib/personal-memory-evidence-port";

const NAMESPACE_ID = "10000000-0000-4000-8000-000000000001";
const SHARED_NAMESPACE_ID = "10000000-0000-4000-8000-000000000011";
const ROOM_ID = "20000000-0000-4000-8000-000000000002";
const SHARED_ROOM_ID = "20000000-0000-4000-8000-000000000012";
const HUMAN_ID = "30000000-0000-4000-8000-000000000003";
const OTHER_HUMAN_ID = "40000000-0000-4000-8000-000000000004";
const AGENT_ID = "50000000-0000-4000-8000-000000000005";
const ROLLUP_ID = "60000000-0000-4000-8000-000000000006";
const EVENT_ID = "70000000-0000-4000-8000-000000000007";
const MEMORY_ID = "80000000-0000-4000-8000-000000000008";

type SourceDependency = Extract<
  DurableModelExposureDependency,
  { kind: "source" }
>;

function sourceDependency(input: Readonly<{
  sourceKind: SourceDependency["sourceKind"];
  logicalSourceRef: string;
  revision: string;
  fingerprint: string;
}>): SourceDependency {
  return Object.freeze({
    kind: "source",
    sourceKind: input.sourceKind,
    logicalSourceRef: input.logicalSourceRef,
    observedRevision: input.revision,
    observedContentFingerprint: input.fingerprint,
    terminalAuthorityLeafHandle: NAMESPACE_ID,
  });
}

function queryResult<Row>(rows: readonly Row[]): unknown {
  const chain: unknown = new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        return (
          resolve: (value: readonly Row[]) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject);
      }
      return () => chain;
    },
  });
  return chain;
}

function database(...results: readonly unknown[][]): DirectDatabase {
  const remaining = [...results];
  return {
    select() {
      const rows = remaining.shift();
      if (rows === undefined) throw new Error("unexpected database read");
      return queryResult(rows);
    },
  } as unknown as DirectDatabase;
}

function roomQueries(input: Readonly<{
  actorIds?: readonly string[];
  publicBoundary?: boolean;
  external?: boolean;
}> = {}) {
  return {
    async findRoomByNamespaceId(namespaceId: string) {
      return namespaceId === NAMESPACE_ID ? { roomId: ROOM_ID } : null;
    },
    async getRoomWithAccess(roomId: string) {
      return roomId === ROOM_ID
        ? {
            namespaceId: NAMESPACE_ID,
            humanActorIds: input.actorIds ?? ["actor-1"],
            isPublicNamespaceBoundary: input.publicBoundary ?? false,
            externalContext: input.external ?? false,
          }
        : null;
    },
  };
}

function selection(
  selectedRepresentation: "ordinary" | "protected" = "ordinary",
): RecordRepositorySelection {
  return { selectedRepresentation, migrationGeneration: 1 };
}

function port(input: Readonly<{
  db: DirectDatabase;
  selected?: () => RecordRepositorySelection;
  rooms?: ReturnType<typeof roomQueries>;
  openProtectedSource?: (
    dependency: SourceDependency,
  ) => Promise<MemorySourceDerivation | null>;
  fingerprints?: ReturnType<typeof createHmacOrdinarySourceFingerprintPort>;
}>) {
  return createPersonalMemoryEvidencePort({
    db: input.db,
    selected: input.selected ?? (() => selection()),
    fingerprintProfileSoul: (value) => [
      "soul",
      value.agentId,
      value.profileId,
      value.userId,
      value.soulRevision,
      value.soulFile,
    ].join(":"),
    readRecord: async () => null,
    roomQueries: input.rooms ?? roomQueries(),
    ...(input.openProtectedSource === undefined
      ? {}
      : { openProtectedSource: input.openProtectedSource }),
    ...(input.fingerprints === undefined
      ? {}
      : { fingerprints: input.fingerprints }),
  });
}

const ACTOR_ROW = { actorId: "actor-1", userId: HUMAN_ID } as const;

describe("personal Memory evidence source port", () => {
  test("authenticates an exact current Human message and rejects changed content or disabled Humans", async () => {
    const message = {
      id: 41,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      content: "current message",
      editRevision: 3,
      role: "user",
      externalAuthorship: false,
      sourceUserId: HUMAN_ID,
      agentId: AGENT_ID,
      metadata: null,
      sourceUserDisabledAt: null,
    } as const;
    const dependency = sourceDependency({
      sourceKind: "message",
      logicalSourceRef: "message:41",
      revision: "3",
      fingerprint: reflectionMessageSourceFingerprint(message),
    });

    expect(await port({ db: database([ACTOR_ROW], [message]) }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "human",
      authorHumanId: HUMAN_ID,
    });
    expect(await port({
      db: database([ACTOR_ROW], [{ ...message, content: "changed" }]),
    }).readSource(dependency)).toBeNull();
    expect(await port({
      db: database([ACTOR_ROW], [{ ...message, sourceUserDisabledAt: new Date(0) }]),
    }).readSource(dependency)).toBeNull();
  });

  test("projects mixed and public current audiences without treating them as private", async () => {
    const value = port({
      db: database([
        ACTOR_ROW,
        { actorId: "actor-2", userId: OTHER_HUMAN_ID },
      ]),
      rooms: roomQueries({
        actorIds: ["actor-1", "actor-2"],
        publicBoundary: true,
      }),
    });

    expect(await value.readAudience(NAMESPACE_ID)).toEqual({
      humanIds: [HUMAN_ID, OTHER_HUMAN_ID],
      includesPublicBoundary: true,
    });
  });

  test("reopens only strict trusted assistant metadata and returns its nested exposure", async () => {
    const child = sourceDependency({
      sourceKind: "message",
      logicalSourceRef: "message:40",
      revision: "1",
      fingerprint: "sha256:child",
    });
    const carrier = bindModelInputExposure({}, {
      status: "complete",
      dependencies: [child],
    });
    const message = {
      id: 42,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      content: "assistant result",
      editRevision: 4,
      role: "assistant",
      externalAuthorship: false,
      sourceUserId: HUMAN_ID,
      agentId: AGENT_ID,
      metadata: {
        [MODEL_INPUT_EXPOSURE_METADATA_KEY]:
          modelInputExposureMetadataForPersistence(carrier),
      },
      sourceUserDisabledAt: null,
    } as const;
    const dependency = sourceDependency({
      sourceKind: "message",
      logicalSourceRef: "message:42",
      revision: "4",
      fingerprint: reflectionMessageSourceFingerprint(message),
    });

    expect(await port({ db: database([ACTOR_ROW], [message]) }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "derived",
      modelExposureDependencies: [child],
    });
    expect(await port({
      db: database([ACTOR_ROW], [{
        ...message,
        metadata: {
          [MODEL_INPUT_EXPOSURE_METADATA_KEY]: {
            version: 1,
            status: "complete",
            dependencies: [],
            forged: true,
          },
        },
      }]),
    }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "unknown",
    });
  });

  test("authenticates the current owned Profile Soul and rejects rotation", async () => {
    const profile = {
      profileId: "90000000-0000-4000-8000-000000000009",
      userId: HUMAN_ID,
      agentId: AGENT_ID,
      soulFile: "Careful and concise.",
      soulRevision: 7,
      ownerActorId: "agent-actor",
      disabledAt: null,
    } as const;
    const fingerprint = [
      "soul",
      profile.agentId,
      profile.profileId,
      profile.userId,
      profile.soulRevision,
      profile.soulFile,
    ].join(":");
    const dependency = sourceDependency({
      sourceKind: "profile_soul",
      logicalSourceRef: `agent-soul:${AGENT_ID}`,
      revision: "7",
      fingerprint,
    });

    expect(await port({ db: database([ACTOR_ROW], [profile]) }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "human",
      authorHumanId: HUMAN_ID,
    });
    expect(await port({
      db: database([ACTOR_ROW], [{ ...profile, soulRevision: 8 }]),
    }).readSource(dependency)).toBeNull();
  });

  test("retains exact rollup ancestry and leaves legacy rollups incomplete", async () => {
    const ancestry = [sourceDependency({
      sourceKind: "message",
      logicalSourceRef: "message:40",
      revision: "1",
      fingerprint: "sha256:ancestor",
    })];
    const rollup = {
      id: ROLLUP_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      throughEventSequence: 12,
      content: "current rollup",
      compactorVersion: "v2",
      modelExposureDependencies: ancestry,
    } as const;
    const dependency = sourceDependency({
      sourceKind: "journal_rollup",
      logicalSourceRef: `journal-rollup:${ROLLUP_ID}`,
      revision: "through:12:version:v2",
      fingerprint: stenographerJournalRollupObservationFingerprint({
        rollupId: rollup.id,
        throughEventSequence: rollup.throughEventSequence,
        content: rollup.content,
        compactorVersion: rollup.compactorVersion,
        modelExposureDependencies: ancestry,
      }),
    });

    expect(await port({ db: database([ACTOR_ROW], [rollup]) }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "derived",
      modelExposureDependencies: ancestry,
    });

    const legacy = { ...rollup, modelExposureDependencies: null };
    const legacyDependency = sourceDependency({
      sourceKind: "journal_rollup",
      logicalSourceRef: `journal-rollup:${ROLLUP_ID}`,
      revision: "through:12:version:v2",
      fingerprint: stenographerJournalRollupObservationFingerprint({
        rollupId: legacy.id,
        throughEventSequence: legacy.throughEventSequence,
        content: legacy.content,
        compactorVersion: legacy.compactorVersion,
      }),
    });
    expect(await port({ db: database([ACTOR_ROW], [legacy]) }).readSource(legacyDependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "unknown",
    });
    expect(await port({
      db: database([ACTOR_ROW], [{
        ...rollup,
        modelExposureDependencies: [{ ...ancestry[0]!, forged: true }],
      }]),
    }).readSource(dependency)).toBeNull();
  });

  test("validates legacy journal coordinates but cannot invent their author", async () => {
    const event = {
      id: EVENT_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence: 15,
      kind: "decision",
      statement: "A prior decision",
      status: "active",
      projectionKind: "legacy",
    } as const;
    const dependency = sourceDependency({
      sourceKind: "journal_event",
      logicalSourceRef: `journal-event:${EVENT_ID}`,
      revision: "sequence:15:status:active",
      fingerprint: stenographerJournalEventObservationFingerprint({
        eventId: event.id,
        sequence: event.sequence,
        kind: event.kind,
        statement: event.statement,
        status: event.status,
      }),
    });

    expect(await port({ db: database([ACTOR_ROW], [event]) }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "unknown",
    });
  });

  test("requires the canonical keyed Memory fingerprint and returns only retained Memory ancestry", async () => {
    const fingerprints = createHmacOrdinarySourceFingerprintPort(
      new Uint8Array(32).fill(7),
    );
    const memory = {
      id: MEMORY_ID,
      type: "fact",
      content: "A retained Memory",
      tier: 1,
      contentRevision: 5,
      updatedAt: new Date(0),
      updatedAtCoordinate: "1970-01-01T00:00:00.000000Z",
    } as const;
    const dependency = sourceDependency({
      sourceKind: "memory",
      logicalSourceRef: `memory:${MEMORY_ID}`,
      revision: "5",
      fingerprint: fingerprints.memory(memory),
    });

    expect(await port({
      db: database([ACTOR_ROW], [memory], [{
        namespaceId: NAMESPACE_ID,
        selectedNamespacePresent: true,
      }]),
      fingerprints,
    }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "unknown",
    });
    const ancestry = [sourceDependency({
      sourceKind: "message",
      logicalSourceRef: "message:40",
      revision: "1",
      fingerprint: "sha256:ancestor",
    })];
    expect(await port({
      db: database(
        [ACTOR_ROW],
        [{ ...memory, modelExposureDependencies: ancestry }],
        [{ namespaceId: NAMESPACE_ID, selectedNamespacePresent: true }],
      ),
      fingerprints,
    }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "derived",
      modelExposureDependencies: ancestry,
    });
    expect(await port({
      db: database(
        [ACTOR_ROW],
        [{ ...memory, modelExposureDependencies: [] }],
        [{ namespaceId: NAMESPACE_ID, selectedNamespacePresent: true }],
      ),
      fingerprints,
    }).readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "derived",
      modelExposureDependencies: [],
    });
    expect(await port({
      db: database(
        [ACTOR_ROW],
        [{ ...memory, modelExposureDependencies: { forged: true } }],
        [{ namespaceId: NAMESPACE_ID, selectedNamespacePresent: true }],
      ),
      fingerprints,
    }).readSource(dependency)).toBeNull();
    expect(await port({
      db: database([ACTOR_ROW], [memory]),
    }).readSource(dependency)).toBeNull();
    expect(await port({
      db: database([ACTOR_ROW], [{ ...memory, content: "rotated" }]),
      fingerprints,
    }).readSource(dependency)).toBeNull();

    const shared = port({
      db: database(
        [ACTOR_ROW],
        [memory],
        [
          { namespaceId: NAMESPACE_ID, selectedNamespacePresent: true },
          {
            namespaceId: SHARED_NAMESPACE_ID,
            selectedNamespacePresent: true,
          },
        ],
        [{ actorId: "actor-2", userId: OTHER_HUMAN_ID }],
      ),
      fingerprints,
      rooms: {
        async findRoomByNamespaceId(namespaceId) {
          if (namespaceId === NAMESPACE_ID) return { roomId: ROOM_ID };
          if (namespaceId === SHARED_NAMESPACE_ID) {
            return { roomId: SHARED_ROOM_ID };
          }
          return null;
        },
        async getRoomWithAccess(roomId) {
          if (roomId === ROOM_ID) return {
            namespaceId: NAMESPACE_ID,
            humanActorIds: ["actor-1"],
            isPublicNamespaceBoundary: false,
            externalContext: false,
          };
          if (roomId === SHARED_ROOM_ID) return {
            namespaceId: SHARED_NAMESPACE_ID,
            humanActorIds: ["actor-2"],
            isPublicNamespaceBoundary: true,
            externalContext: false,
          };
          return null;
        },
      },
    });
    expect(await shared.readSource(dependency)).toEqual({
      status: "current",
      audienceHumanIds: [HUMAN_ID, OTHER_HUMAN_ID],
      includesPublicBoundary: true,
      kind: "unknown",
    });
  });

  test("classifies namespace proof overflow as incomplete without reading partial audiences", async () => {
    const fingerprints = createHmacOrdinarySourceFingerprintPort(
      new Uint8Array(32).fill(7),
    );
    const memory = {
      id: MEMORY_ID,
      type: "fact",
      content: "A retained Memory",
      tier: 1,
      contentRevision: 5,
      updatedAt: new Date(0),
      updatedAtCoordinate: "1970-01-01T00:00:00.000000Z",
    } as const;
    const dependency = sourceDependency({
      sourceKind: "memory",
      logicalSourceRef: `memory:${MEMORY_ID}`,
      revision: "5",
      fingerprint: fingerprints.memory(memory),
    });
    let roomFinds = 0;
    let accessReads = 0;
    const value = port({
      db: database(
        [ACTOR_ROW],
        [memory],
        Array.from({ length: 257 }, (_, index) => ({
          namespaceId: index === 0 ? NAMESPACE_ID : `namespace-${index}`,
          selectedNamespacePresent: true,
        })),
      ),
      fingerprints,
      rooms: {
        async findRoomByNamespaceId(namespaceId) {
          roomFinds += 1;
          return namespaceId === NAMESPACE_ID ? { roomId: ROOM_ID } : null;
        },
        async getRoomWithAccess(roomId) {
          accessReads += 1;
          return roomId === ROOM_ID
            ? {
                namespaceId: NAMESPACE_ID,
                humanActorIds: ["actor-1"],
                isPublicNamespaceBoundary: false,
                externalContext: false,
              }
            : null;
        },
      },
    });

    const current = await classifyPersonalMemoryEvidence({
      dependencies: [dependency],
      ports: value,
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    });
    expect(current).toEqual({ kind: "service", reason: "incomplete" });
    expect(roomFinds).toBe(1);
    expect(accessReads).toBe(1);
    expect(() => assertSamePersonalMemoryEvidence(
      { kind: "human", humanUserId: HUMAN_ID },
      current,
    )).toThrow(PersonalMemoryEvidenceChangedError);

    const lostSelectedEdge = await classifyPersonalMemoryEvidence({
      dependencies: [dependency],
      ports: port({
        db: database(
          [ACTOR_ROW],
          [memory],
          Array.from({ length: 257 }, (_, index) => ({
            namespaceId: `other-namespace-${index}`,
            selectedNamespacePresent: false,
          })),
        ),
        fingerprints,
      }),
      budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
    }).catch((error: unknown) => error);
    expect(lostSelectedEdge).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
  });

  test("keeps changed, missing, corrupted, unauthorized, and failed Memory reads fatal", async () => {
    const fingerprints = createHmacOrdinarySourceFingerprintPort(
      new Uint8Array(32).fill(7),
    );
    const memory = {
      id: MEMORY_ID,
      type: "fact",
      content: "A retained Memory",
      tier: 1,
      contentRevision: 5,
      updatedAt: new Date(0),
      updatedAtCoordinate: "1970-01-01T00:00:00.000000Z",
    } as const;
    const dependency = sourceDependency({
      sourceKind: "memory",
      logicalSourceRef: `memory:${MEMORY_ID}`,
      revision: "5",
      fingerprint: fingerprints.memory(memory),
    });
    const classify = (value: ReturnType<typeof port>) =>
      classifyPersonalMemoryEvidence({
        dependencies: [dependency],
        ports: value,
        budget: { maxVisitedRecords: 4, maxTraversalWork: 16 },
      }).catch((error: unknown) => error);

    expect(await classify(port({
      db: database([ACTOR_ROW], [{ ...memory, content: "changed" }]),
      fingerprints,
    }))).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
    expect(await classify(port({
      db: database([ACTOR_ROW], []),
      fingerprints,
    }))).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
    expect(await classify(port({
      db: database(
        [ACTOR_ROW],
        [{ ...memory, modelExposureDependencies: { forged: true } }],
      ),
      fingerprints,
    }))).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
    expect(await classify(port({
      db: database(),
      fingerprints,
      rooms: {
        async findRoomByNamespaceId() { return { roomId: ROOM_ID }; },
        async getRoomWithAccess() { return null; },
      },
    }))).toBeInstanceOf(PersonalMemoryEvidenceChangedError);

    const storageFailure = new Error("namespace edge read failed");
    let reads = 0;
    const failedDb = {
      select() {
        reads += 1;
        if (reads === 1) return queryResult([ACTOR_ROW]);
        if (reads === 2) return queryResult([memory]);
        throw storageFailure;
      },
    } as unknown as DirectDatabase;
    expect(await classify(port({
      db: failedDb,
      fingerprints,
    }))).toBe(storageFailure);
  });

  test("switches dynamically to the selected protected opener without ordinary fallback", async () => {
    let selected = selection();
    let protectedReads = 0;
    const protectedResult: MemorySourceDerivation = {
      status: "current",
      audienceHumanIds: [HUMAN_ID],
      includesPublicBoundary: false,
      kind: "human",
      authorHumanId: HUMAN_ID,
    };
    const dependency = sourceDependency({
      sourceKind: "message",
      logicalSourceRef: "message:41",
      revision: "3",
      fingerprint: "sha256:any",
    });
    const value = port({
      db: database(),
      selected: () => selected,
      openProtectedSource: async () => {
        protectedReads += 1;
        return protectedResult;
      },
    });

    selected = selection("protected");
    expect(await value.readSource(dependency)).toEqual(protectedResult);
    expect(protectedReads).toBe(1);

    const unavailable = port({
      db: database(),
      selected: () => selection("protected"),
    });
    expect(await unavailable.readSource(dependency)).toBeNull();
  });
});
