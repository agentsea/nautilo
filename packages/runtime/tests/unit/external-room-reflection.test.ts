import { expect, test } from "bun:test";
import { CanonicalRoomNamespaceSourceAuthority, createCanonicalSameRoomBindingPorts, type CanonicalRoomAuthorityQueries } from "../../src/reflection/canonical-product-authority";

const namespace = "66000000-0000-4000-8000-000000000001";
const binding = `journal:namespace:${namespace}:ordinary:v1`;
const roomQueries: CanonicalRoomAuthorityQueries = {
  findRoomByNamespaceId: async () => ({ roomId: "parent", humanActorIds: ["same-human"] }),
  getRoomWithAccess: async () => ({ namespaceId: namespace, humanActorIds: ["same-human"], isPublicNamespaceBoundary: false, externalContext: true }),
};

test("external audience is unavailable to Human-set Reflection authority, including subthreads", async () => {
  const authority = new CanonicalRoomNamespaceSourceAuthority(roomQueries);
  expect(await authority.resolve(namespace)).toEqual({ status: "unavailable" });
  const ports = createCanonicalSameRoomBindingPorts({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    publications: {
      read: async () => ({ originPublicationBindingRef: binding, currentAccessBindingRefs: [binding], representationGeneration: 1, authorityProjectionGeneration: 1 }),
      readOrigin: async () => binding,
    }, roomQueries, searchCommitments: { commit: () => "unused" },
  });
  expect(await ports.evidence.resolveRoom("subthread")).toBeNull();
  expect(await ports.evidence.resolve(binding)).toBeNull();
  expect(await ports.search.resolve(binding)).toBeNull();
  expect(await ports.semantic.resolveWork("record")).toBeNull();
  expect(await ports.invocation.resolve("record")).toBeNull();
});

test("moving a Record access binding cannot discard its external origin restriction", async () => {
  const internalNamespace = "66000000-0000-4000-8000-000000000002";
  const internalBinding = `journal:namespace:${internalNamespace}:ordinary:v1`;
  const ports = createCanonicalSameRoomBindingPorts({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    publications: { read: async () => ({ originPublicationBindingRef: binding, currentAccessBindingRefs: [internalBinding], representationGeneration: 1, authorityProjectionGeneration: 1 }) },
    roomQueries: {
      findRoomByNamespaceId: async (id) => ({ roomId: id === namespace ? "external" : "internal", humanActorIds: ["same-human"] }),
      getRoomWithAccess: async (roomId) => ({ namespaceId: roomId === "external" ? namespace : internalNamespace,
        humanActorIds: ["same-human"], isPublicNamespaceBoundary: false, externalContext: roomId === "external" }),
    }, searchCommitments: { commit: () => "unused" },
  });
  expect(await ports.semantic.resolveWork("moved-record")).toBeNull();
});
