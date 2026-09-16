import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolveInstance } from "@nautilo/config";
import {
  actors,
  eq,
  namespaces,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityClosure,
  reflectionRecordAuthorityProjections,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  reflectionRecordSearchProjections,
  rooms,
} from "@nautilo/db";
import { DualModeAuthorityFilteredRecordSearch } from "@nautilo/reflection-bridge/server";

import { createProductionReflectionMemoryRuntime } from
  "../../src/reflection/production-reflection-memory";
import {
  cleanupTestUser,
  closeDirectDb,
  createTestRoom,
  createTestUser,
  getDirectDb,
} from "./helpers";

const connectionString = process.env["NAUTILO_REFLECTION_LIVENESS_TEST_DATABASE_URL"];
const describePostgres = connectionString === undefined ? describe.skip : describe;
if (connectionString !== undefined) {
  const target = new URL(connectionString);
  const instance = resolveInstance();
  if (!instance.instanceId.includes("-qa-") || target.hostname !== "localhost"
    || Number(target.port) !== instance.db.postgresHostPort) {
    throw new Error("Production Record structural recall requires the exact selected QA clone database");
  }
}

afterAll(async () => {
  await closeDirectDb();
});

describePostgres("production Record structural recall composition", () => {
  test("dispatches the Room-bound structural method without opening an ordinary result", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    const db = getDirectDb();
    const { userId } = await createTestUser("m321-record-structural");
    const { roomId } = await createTestRoom(userId);
    const [humanActor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.ownerId, userId))
      .limit(1);
    if (humanActor === undefined) throw new Error("missing synthetic Room human actor");
    await db
      .update(rooms)
      .set({ humanActorIds: [humanActor.id] })
      .where(eq(rooms.id, roomId));
    const structural = spyOn(DualModeAuthorityFilteredRecordSearch.prototype, "searchStructural");
    const ordinary = spyOn(DualModeAuthorityFilteredRecordSearch.prototype, "search");
    try {
      const runtime = await createProductionReflectionMemoryRuntime({
        db,
        // The current product repository selection is independent of the
        // operation's protected structural read. No ordinary body is opened.
        selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
        commitmentKey: new Uint8Array(32).fill(31),
        maintenanceGate: { isAcceptingWork: async () => false },
        resolveModelId: () => "integration:no-model-call",
        recordEmbedding: { embed: async () => ({
          status: "available",
          embedding: {
            provenance: {
              provider: "openai",
              canonicalModel: "text-embedding-3-small",
              dimensions: 1_536,
              contractVersion: 1,
            },
            vector: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0),
          },
        }) },
      });
      const port = runtime.recallRecordsPortForState({ roomId } as never);
      expect(port?.searchStructural).toBeFunction();
      const result = await port!.searchStructural!({
        query: "ciphertext-only discovery",
        limit: 5,
      });
      expect(result).toEqual({ status: "ok", records: [] });
      expect(structural).toHaveBeenCalledTimes(1);
      expect(ordinary).not.toHaveBeenCalled();
    } finally {
      structural.mockRestore();
      ordinary.mockRestore();
      await cleanupTestUser(userId, db);
    }
  });

  test("returns a ciphertext-only Record without consulting the ordinary repository", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    const db = getDirectDb();
    const { userId } = await createTestUser("m321-record-ciphertext-only");
    const { roomId } = await createTestRoom(userId);
    const [humanActor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.ownerId, userId))
      .limit(1);
    if (humanActor === undefined) throw new Error("missing synthetic Room human actor");
    await db
      .update(rooms)
      .set({ humanActorIds: [humanActor.id] })
      .where(eq(rooms.id, roomId));
    const [accessNamespace] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "m321-record-access" })
      .returning({ id: namespaces.id });
    if (accessNamespace === undefined) throw new Error("missing synthetic access Namespace");
    await db.insert(rooms).values({
      ownerId: userId,
      type: "private",
      label: "m321-record-access",
      graphThreadId: `access:${randomUUID()}`,
      namespaceId: accessNamespace.id,
      humanActorIds: [humanActor.id],
      kind: "access",
    });
    const recordRef = `m321-record-${randomUUID()}`;
    const embedding = Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0);
    const structural = spyOn(DualModeAuthorityFilteredRecordSearch.prototype, "searchStructural");
    const ordinary = spyOn(DualModeAuthorityFilteredRecordSearch.prototype, "search");
    try {
      await db.insert(reflectionRecords).values({
        recordId: recordRef,
        lifecycle: "current",
        structuralHeight: 2,
        producerPolicyVersion: "m321-test-v1",
        processingGeneration: 1,
      });
      await db.insert(reflectionRecordPayloadRepresentations).values({
        recordId: recordRef,
        representation: "protected",
        representationGeneration: 1,
        cryptoObjectId: `m321-crypto-${randomUUID()}`,
      });
      await db.insert(reflectionRecordPayloadRepresentationHeads).values({
        recordId: recordRef,
        representation: "protected",
        currentRepresentationGeneration: 1,
      });
      await db.insert(reflectionRecordAuthorityProjections).values({
        recordId: recordRef,
        projectionGeneration: 1,
        sourceChangeGeneration: 1,
        processingState: "current",
        audienceSetCommitment: new Uint8Array(32).fill(7),
        current: true,
      });
      await db.insert(reflectionRecordAuthorityAlternatives).values({
        recordId: recordRef,
        projectionGeneration: 1,
        alternativeOrdinal: 0,
        accessNamespaceId: accessNamespace.id,
        includesPublicBoundary: false,
        alternativeCommitment: new Uint8Array(32).fill(11),
      });
      await db.insert(reflectionRecordAuthorityClosure).values({
        recordId: recordRef,
        terminalLeafHandle: `m321-leaf-${randomUUID()}`,
        closureGeneration: 1,
      });
      await db.insert(reflectionRecordSearchProjections).values({
        recordId: recordRef,
        recordProcessingGeneration: 1,
        projectionVersion: 1,
        projectionGeneration: 1,
        embeddingProvider: "openai",
        embeddingCanonicalModel: "text-embedding-3-small",
        embeddingDimensions: 1_536,
        embeddingContractVersion: 1,
        embedding,
      });
      const runtime = await createProductionReflectionMemoryRuntime({
        db,
        selection: { selectedRepresentation: "protected", migrationGeneration: 1 },
        commitmentKey: new Uint8Array(32).fill(31),
        maintenanceGate: { isAcceptingWork: async () => false },
        resolveModelId: () => "integration:no-model-call",
        protectedRecordPublication: {
          publish: async () => { throw new Error("unexpected protected publication"); },
          verify: async () => { throw new Error("unexpected protected verification"); },
          open: async () => { throw new Error("unexpected protected body open"); },
          retire: async () => { throw new Error("unexpected protected retirement"); },
        },
        recordEmbedding: { embed: async () => ({
          status: "available",
          embedding: {
            provenance: {
              provider: "openai",
              canonicalModel: "text-embedding-3-small",
              dimensions: 1_536,
              contractVersion: 1,
            },
            vector: embedding,
          },
        }) },
      });
      const result = await runtime.recallRecordsPortForState({ roomId } as never)!
        .searchStructural!({ query: "ciphertext-only discovery", limit: 5 });
      expect(result).toEqual({
        status: "ok",
        records: [{ representation: "structural", recordRef, structuralHeight: 2 }],
      });
      expect(structural).toHaveBeenCalledTimes(1);
      expect(ordinary).not.toHaveBeenCalled();
      const ordinaryPayload = await db
        .select({
          representation: reflectionRecordPayloadRepresentations.representation,
          plaintextPayloadBytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
        })
        .from(reflectionRecordPayloadRepresentations)
        .where(eq(reflectionRecordPayloadRepresentations.recordId, recordRef));
      expect(ordinaryPayload).toEqual([{
        representation: "protected",
        plaintextPayloadBytes: null,
      }]);
    } finally {
      structural.mockRestore();
      ordinary.mockRestore();
      // Record facts are intentionally immutable. Retire this UUID-scoped
      // fixture through the product lifecycle instead of deleting history.
      await db.update(reflectionRecords)
        .set({ disposition: "purged" })
        .where(eq(reflectionRecords.recordId, recordRef));
      await cleanupTestUser(userId, db);
      await db.delete(namespaces).where(eq(namespaces.id, accessNamespace.id));
    }
  });
});
