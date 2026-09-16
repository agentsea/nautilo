import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";

import {
  CanonicalRecordAccessAudience,
  CanonicalRoomNamespaceSourceAuthority,
  createCanonicalRecordAccessAudience,
  createCanonicalSameRoomBindingPorts,
  type CanonicalRoomAuthorityQueries,
} from "../../src/reflection/canonical-product-authority";

const ROOM = "55000000-0000-4000-8000-000000000001";
const NAMESPACE = "66000000-0000-4000-8000-000000000001";
const BINDING = `journal:namespace:${NAMESPACE}:ordinary:v3`;
const PROTECTED_BINDING = `journal:namespace:${NAMESPACE}:protected:v3`;

function currentBinding(current = BINDING, origin = BINDING) {
  return {
    originPublicationBindingRef: origin,
    currentAccessBindingRefs: [current],
    representationGeneration: 1,
    authorityProjectionGeneration: 1,
  };
}

function roomQueries(publicBoundary = true): CanonicalRoomAuthorityQueries {
  return {
    findRoomByNamespaceId: async (namespaceId) =>
      namespaceId === NAMESPACE
        ? { roomId: ROOM, humanActorIds: ["human-b", "human-a"] }
        : null,
    getRoomWithAccess: async (roomId) =>
      roomId === ROOM
        ? {
            namespaceId: NAMESPACE,
            humanActorIds: ["human-b", "human-a"],
            isPublicNamespaceBoundary: publicBoundary,
          }
        : null,
  };
}

function record(): DurableRecordEnvelope {
  return {
    recordRef: "record-one",
    lifecycle: "current",
    structuralHeight: 0,
    processingGeneration: 1,
    semantic: {
      observedContentFingerprint: "fingerprint",
      posture: "derived",
      statement: "We selected Postgres.",
      sourceDependencies: [],
      anchors: [{ anchorRef: ROOM, kind: "room", role: "origin" }],
      childRecordRefs: [],
      producer: { producerRef: "stenographer", policyVersion: "v1" },
      terminalAuthorityLeafHandles: [NAMESPACE],
    },
  };
}

describe("canonical Reflection product authority adapters", () => {
  test("resolves same-Room and search bindings with complete public audience", async () => {
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: { read: async () => currentBinding() },
      roomQueries: roomQueries(true),
      searchCommitments: {
        commit: (kind, value) => `${kind}:${JSON.stringify(value)}`,
      },
    });

    expect(await ports.semantic.resolve(record())).toEqual({
      status: "available",
      binding: {
        roomAnchorRef: ROOM,
        readBindingRef: BINDING,
        searchBindingRef: BINDING,
        publicationBindingRef: BINDING,
        invocationAudience: {
          humanRefs: ["human-a", "human-b"],
          includesPublicBoundary: true,
        },
      },
    });
    expect(await ports.search.resolve(BINDING)).toMatchObject({
      invocationAudience: {
        humanRefs: ["human-a", "human-b"],
        includesPublicBoundary: true,
      },
      invocationAudienceCommitment:
        'audience:{"humanRefs":["human-a","human-b"],"includesPublicBoundary":true}',
    });
  });

  test("resolves the exact origin when sibling Rooms share one Namespace", async () => {
    const siblingRoom = "55000000-0000-4000-8000-000000000002";
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: { read: async () => currentBinding() },
      roomQueries: {
        // Reverse Namespace lookup is intentionally ambiguous for Subthreads.
        findRoomByNamespaceId: async () => ({
          roomId: siblingRoom,
          humanActorIds: ["human-a"],
        }),
        getRoomWithAccess: async (roomId) =>
          roomId === ROOM || roomId === siblingRoom
            ? {
                namespaceId: NAMESPACE,
                humanActorIds: ["human-a"],
                isPublicNamespaceBoundary: false,
              }
            : null,
      },
      searchCommitments: { commit: () => "commitment" },
    });

    expect(await ports.semantic.resolve(record())).toMatchObject({
      status: "available",
      binding: { roomAnchorRef: ROOM },
    });
  });

  test("resolves a cross-Room parent through its output origin, not its evidence leaves", async () => {
    const outputRoom = "55000000-0000-4000-8000-000000000009";
    const outputNamespace = "66000000-0000-4000-8000-000000000009";
    const outputBinding = `journal:namespace:${outputNamespace}:ordinary:v3`;
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: { read: async () => currentBinding(outputBinding, outputBinding) },
      roomQueries: {
        findRoomByNamespaceId: async (namespaceId) => namespaceId === outputNamespace
          ? { roomId: outputRoom, humanActorIds: ["human-a"] }
          : null,
        getRoomWithAccess: async (roomId) => roomId === outputRoom
          ? {
              namespaceId: outputNamespace,
              humanActorIds: ["human-a"],
              isPublicNamespaceBoundary: false,
            }
          : roomId === ROOM
            ? {
                namespaceId: NAMESPACE,
                humanActorIds: ["human-a", "human-b"],
                isPublicNamespaceBoundary: false,
              }
            : null,
      },
      searchCommitments: { commit: () => "commitment" },
    });
    const crossRoomParent: DurableRecordEnvelope = {
      ...record(),
      semantic: {
        ...record().semantic,
        anchors: [
          { anchorRef: outputRoom, kind: "room", role: "origin" },
          { anchorRef: ROOM, kind: "room", role: "origin" },
        ],
        terminalAuthorityLeafHandles: [NAMESPACE],
      },
    };

    expect(await ports.semantic.resolve(crossRoomParent)).toMatchObject({
      status: "available",
      binding: {
        roomAnchorRef: outputRoom,
        publicationBindingRef: outputBinding,
        invocationAudience: { humanRefs: ["human-a"] },
      },
    });
  });

  test("keeps immutable origin separate from reprojected current access", async () => {
    const accessRoom = "55000000-0000-4000-8000-000000000008";
    const accessNamespace = "66000000-0000-4000-8000-000000000008";
    const accessBinding = `journal:namespace:${accessNamespace}:ordinary:v3`;
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: { read: async () => currentBinding(accessBinding, BINDING) },
      roomQueries: {
        findRoomByNamespaceId: async (namespaceId) => namespaceId === accessNamespace
          ? { roomId: accessRoom, humanActorIds: ["human-a"] }
          : null,
        getRoomWithAccess: async (roomId) => roomId === ROOM
          ? {
              namespaceId: NAMESPACE,
              humanActorIds: ["human-a", "human-b"],
              isPublicNamespaceBoundary: false,
            }
          : roomId === accessRoom
            ? {
                namespaceId: accessNamespace,
                humanActorIds: ["human-a"],
                isPublicNamespaceBoundary: false,
              }
            : null,
      },
      searchCommitments: { commit: () => "commitment" },
    });

    expect(await ports.semantic.resolve(record())).toEqual({
      status: "available",
      binding: {
        roomAnchorRef: ROOM,
        readBindingRef: accessBinding,
        searchBindingRef: accessBinding,
        publicationBindingRef: BINDING,
        invocationAudience: {
          humanRefs: ["human-a"],
          includesPublicBoundary: false,
        },
      },
    });
  });

  test("uses an ordinary publication origin with exact protected current access", async () => {
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "protected", migrationGeneration: 3 },
      publications: {
        read: async () => currentBinding(PROTECTED_BINDING, BINDING),
      },
      roomQueries: roomQueries(false),
      searchCommitments: { commit: () => "commitment" },
    });

    expect(await ports.semantic.resolve(record())).toEqual({
      status: "available",
      binding: {
        roomAnchorRef: ROOM,
        readBindingRef: PROTECTED_BINDING,
        searchBindingRef: PROTECTED_BINDING,
        publicationBindingRef: BINDING,
        invocationAudience: {
          humanRefs: ["human-a", "human-b"],
          includesPublicBoundary: false,
        },
      },
    });
    expect(await ports.search.resolve(BINDING)).toBeNull();
    expect(await ports.search.resolve(PROTECTED_BINDING)).toMatchObject({
      readBindingRef: PROTECTED_BINDING,
    });
  });

  test("resolves prepared invocation attribution from immutable publication metadata", async () => {
    const originRoom = "55000000-0000-4000-8000-000000000009";
    const originNamespace = "66000000-0000-4000-8000-000000000009";
    const originBinding = `journal:namespace:${originNamespace}:ordinary:v3`;
    let selectedHeadReads = 0;
    let originReads = 0;
    const roomsLookedUp: string[] = [];
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "protected", migrationGeneration: 3 },
      publications: {
        read: async () => {
          selectedHeadReads += 1;
          return null;
        },
        readOrigin: async () => {
          originReads += 1;
          return originBinding;
        },
      },
      roomQueries: {
        findRoomByNamespaceId: async (namespaceId) => {
          roomsLookedUp.push(namespaceId);
          if (namespaceId === NAMESPACE) {
            return { roomId: ROOM, humanActorIds: ["human-a"] };
          }
          if (namespaceId === originNamespace) {
            return { roomId: originRoom, humanActorIds: ["human-a"] };
          }
          return null;
        },
        getRoomWithAccess: async (roomId) => roomId === ROOM
          ? {
              namespaceId: NAMESPACE,
              humanActorIds: ["human-a"],
              isPublicNamespaceBoundary: false,
            }
          : null,
      },
      searchCommitments: { commit: () => "unused" },
    });

    expect(await ports.invocation.resolve("record-one")).toEqual({ roomId: originRoom });
    expect(selectedHeadReads).toBe(0);
    expect(originReads).toBe(1);
    expect(roomsLookedUp).toEqual([originNamespace]);
  });

  test("fails prepared invocation closed without immutable-origin capability", async () => {
    let selectedHeadReads = 0;
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: {
        read: async () => {
          selectedHeadReads += 1;
          return currentBinding();
        },
      },
      roomQueries: roomQueries(),
      searchCommitments: { commit: () => "unused" },
    });

    expect(await ports.invocation.resolve("record-one")).toBeNull();
    expect(selectedHeadReads).toBe(0);
  });

  test("fails closed when current access has more than one alternative", async () => {
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: {
        read: async () => ({
          ...currentBinding(),
          currentAccessBindingRefs: [BINDING, BINDING.replace("0001", "0002")],
        }),
      },
      roomQueries: roomQueries(),
      searchCommitments: { commit: () => "unused" },
    });

    expect(await ports.semantic.resolve(record())).toEqual({ status: "unavailable" });
    expect(await ports.semantic.resolveWork(record().recordRef)).toBeNull();
  });

  test("fails closed for representation, Room anchor, or current Namespace drift", async () => {
    const ports = createCanonicalSameRoomBindingPorts({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 3 },
      publications: { read: async () => currentBinding() },
      roomQueries: {
        ...roomQueries(),
        getRoomWithAccess: async () => ({
          namespaceId: "77000000-0000-4000-8000-000000000001",
          humanActorIds: ["human-a"],
          isPublicNamespaceBoundary: false,
        }),
      },
      searchCommitments: { commit: () => "unused" },
    });
    expect(await ports.semantic.resolve(record())).toEqual({ status: "unavailable" });
    expect(await ports.search.resolve(BINDING)).toBeNull();
    expect(await ports.search.resolve(BINDING.replace("ordinary", "protected")))
      .toBeNull();
  });

  test("materializes and rereads only exact hidden access Rooms", async () => {
    const rows = [{
      namespaceId: NAMESPACE,
      roomId: ROOM,
      humanActorIds: ["human-b", "human-a"],
    }];
    const adapter = new CanonicalRecordAccessAudience({
      trust: {
        findOrCreate: async (humanActorIds) => {
          expect(humanActorIds).toEqual(["human-a", "human-b"]);
          return { namespaceId: NAMESPACE, roomId: ROOM };
        },
      },
      readAccessRooms: async (namespaceIds) =>
        namespaceIds.includes(NAMESPACE) ? rows : [],
    });
    expect(await adapter.resolveOrCreateExact(["human-b", "human-a"])).toEqual({
      accessRoomId: ROOM,
      accessNamespaceId: NAMESPACE,
      humanRefs: ["human-a", "human-b"],
    });
    expect(await adapter.readExactSet([NAMESPACE])).toEqual({
      status: "available",
      audiences: [["human-a", "human-b"]],
    });
    expect(await adapter.readExactSet([NAMESPACE, NAMESPACE]))
      .toEqual({ status: "unavailable" });
  });

  test("binds access Namespace sets through typed query predicates", async () => {
    let ordered = false;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => {
              ordered = true;
              return Promise.resolve([{
                namespaceId: NAMESPACE,
                roomId: ROOM,
                humanActorIds: ["human-a"],
              }]);
            },
          }),
        }),
      }),
      execute: () => {
        throw new Error("raw array interpolation must not be used");
      },
    } as unknown as DirectDatabase;

    const adapter = createCanonicalRecordAccessAudience({ db });
    expect(await adapter.readExactSet([NAMESPACE])).toEqual({
      status: "available",
      audiences: [["human-a"]],
    });
    expect(ordered).toBeTrue();
  });

  test("resolves terminal Namespace authority with public-boundary semantics", async () => {
    const source = new CanonicalRoomNamespaceSourceAuthority(roomQueries(true));
    expect(await source.resolve(NAMESPACE)).toEqual({
      status: "available",
      leaf: {
        terminalAuthorityLeafHandle: NAMESPACE,
        alternatives: [{
          humanRefs: ["human-a", "human-b"],
          includesPublicBoundary: true,
        }],
      },
    });
  });
});
