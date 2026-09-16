import { describe, expect, mock, test } from "bun:test";
import * as bridgeServer from "@nautilo/lattice-bridge/server";

let repairSourceFailure: unknown;

mock.module("@nautilo/lattice-bridge/server", () => ({
  ...bridgeServer,
  createPostgresHumanMemoryRepresentationRepairCrypto: () => ({}),
  loadPostgresForegroundMemoryRepairSources: async () => {
    if (repairSourceFailure instanceof Error) throw repairSourceFailure;
    throw new Error("Repair source failure was not configured");
  },
}));

const { createHumanMemoryRepairServices } = await import(
  "../../src/routes/human-memory-repair-services"
);

const selected = {
  id: "10000000-0000-4000-8000-000000000001",
  type: "preference",
  content: "Authenticated ordinary sibling",
  importance: 0.5,
  tier: 1,
  createdAt: new Date("2027-01-15T08:00:00.000Z"),
};

function queryReturning(value: unknown) {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => Promise.resolve([value]),
  };
  return query;
}

function repair() {
  const services = {
    context: {
      handle: {},
      canonicalRunner: {
        transaction: (execute: (tx: unknown) => unknown) => execute({
          select: () => queryReturning(selected),
        }),
      },
    },
    crypto: {},
    cryptoHandle: {},
    cryptoAuthority: {},
    domainKeys: {},
    publication: {},
    resolveHumanId: () => Promise.resolve("human-1"),
    resolveNamespaceAuthority: () => Promise.resolve(null),
    embedding: {},
    cryptoCompletion: { read: () => Promise.resolve(null) },
    resolveHistoricalAgentSignerAuthority: () => Promise.resolve(null),
    product: {},
    preparedCreate: {},
    preparedUpdate: {},
  } as never;
  const authority = {
    userId: "10000000-0000-4000-8000-000000000002",
    actorId: "10000000-0000-4000-8000-000000000004",
    agentId: null,
    memoryMode: "namespace",
    readableNamespaceIds: ["10000000-0000-4000-8000-000000000003"],
    mutableNamespaceIds: ["10000000-0000-4000-8000-000000000003"],
    writableNamespaceIds: ["10000000-0000-4000-8000-000000000003"],
    scopeId: null,
    originWritableNamespaceId: null,
    sourceRoomId: null,
  } as never;
  return createHumanMemoryRepairServices({
    services,
    authority,
    envelope: {} as never,
    policy: { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 1 },
  }).plan({ authority, memoryId: selected.id });
}

describe("Human Memory repair service failure boundary", () => {
  test("maps an exact product-change race but propagates unknown failures", async () => {
    repairSourceFailure = new bridgeServer.ForegroundProductChangedError(
      "Selected Memory changed",
    );
    expect(await repair()).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "stale_revision",
    });

    const unexpected = new TypeError("storage row shape is invalid");
    repairSourceFailure = unexpected;
    expect(repair()).rejects.toBe(unexpected);
  });
});
