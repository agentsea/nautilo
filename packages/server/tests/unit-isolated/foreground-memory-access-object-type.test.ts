import { describe, expect, mock, test } from "bun:test";
import * as bridgeServer from "@nautilo/lattice-bridge/server";
import * as runtime from "@nautilo/runtime";
import { MEMORY_OBJECT_TYPE } from "@nautilo/lattice-bridge";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

type ExactReadRequest = Readonly<{
  objectId: string;
  expectedAccessRevision: number;
  expectedNamespaceIds: readonly string[];
}>;
const captured: {
  exactRead?: (request: ExactReadRequest) => Promise<unknown>;
} = {};

function requireExactRead(): NonNullable<typeof captured.exactRead> {
  const read = captured.exactRead;
  if (read === undefined) {
    throw new Error("Foreground exact-access crypto was not assembled");
  }
  return read;
}

mock.module("@nautilo/lattice-bridge/server", () => ({
  ...bridgeServer,
  PostgresAgentMemoryExactAccessProduct: class {},
}));

mock.module("@nautilo/runtime", () => ({
  ...runtime,
  createForegroundDomainMemoryExactAccess(input: Readonly<{
    read(request: ExactReadRequest): Promise<unknown>;
  }>) {
    captured.exactRead = input.read;
    return Object.freeze({});
  },
  createForegroundDomainProtectedAgentMemoryAccessPort: () =>
    Object.freeze({}),
}));

mock.module("../../src/routes/foreground-message-product-store", () => ({
  createForegroundProductTransactionContext: async () => ({
    handle: Object.freeze({}),
  }),
}));

const { createForegroundMemoryAccessPort } = await import(
  "../../src/routes/foreground-memory-repository"
);
type DurableReadRequest = Parameters<
  Parameters<typeof createForegroundMemoryAccessPort>[0]["domain"]["read"]
>[0];

const NAMESPACE_ID = "10000000-0000-4000-8000-000000000001";
const OBJECT_ID = `memory:v1:${"ab".repeat(32)}`;

const envelope: MemoryAccessEnvelope = {
  ownerId: "human",
  actorId: "actor",
  agentId: "agent",
  roomId: "room",
  readableNamespaces: [NAMESPACE_ID],
  mutableNamespaces: [NAMESPACE_ID],
  writableNamespaces: [NAMESPACE_ID],
  toolPolicy: {},
};

describe("foreground Memory access object type", () => {
  test("forwards canonical Memory coordinates to the durable reader", async () => {
    delete captured.exactRead;
    const canonicalHead = Object.freeze({
      objectId: OBJECT_ID,
      accessRevision: 4,
      payloadBytes: new Uint8Array([1]),
      payloadHash: new Uint8Array(32),
      accessManifestBytes: new Uint8Array([2]),
      accessManifestHash: new Uint8Array(32),
      nativeEntries: Object.freeze([]),
      namespaceEnvelopes: Object.freeze([]),
    });
    let durableRequest: DurableReadRequest | undefined;
    const read = async (request: DurableReadRequest) => {
      durableRequest = request;
      return request.expectedObjectType === MEMORY_OBJECT_TYPE
          && request.objectId === OBJECT_ID
          && request.expectedAccessRevision === 4
          && request.expectedNamespaceIds.length === 1
          && request.expectedNamespaceIds[0] === NAMESPACE_ID
        ? canonicalHead
        : null;
    };

    await createForegroundMemoryAccessPort({
      envelope,
      domain: {
        subjectUserId: envelope.ownerId,
        agentId: envelope.agentId,
        crypto: Object.freeze({}),
        entities: Object.freeze({}),
        publication: Object.freeze({
          runtime: Object.freeze({}),
          signerKeyId: "signer",
          agentAuthorizationRevision: 1,
        }),
        read,
      } as never,
      resolveGrantUserNamespace: async () => null,
      exact: {} as never,
    });

    const exactRead = requireExactRead();
    const value = await exactRead({
      objectId: OBJECT_ID,
      expectedAccessRevision: 4,
      expectedNamespaceIds: [NAMESPACE_ID],
    });
    expect(value).toBe(canonicalHead);
    expect(durableRequest).toEqual({
      objectId: OBJECT_ID,
      expectedAccessRevision: 4,
      expectedNamespaceIds: [NAMESPACE_ID],
      expectedObjectType: MEMORY_OBJECT_TYPE,
    });
    expect(durableRequest?.expectedObjectType).not.toBe("memory");
  });
});
