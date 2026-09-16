/**
 * ISSUE-M317 — real-Postgres metadata and canonical-source boundary for
 * repairing an ordinary Stenographer fallback.
 *
 * Run against an already migrated disposable instance:
 *   NAUTILO_INSTANCE_ID=<clone> bun test --timeout 60000 \
 *     packages/runtime/tests/integration/m317-output-repair.integration.test.ts
 *
 * The fixture and its temporary transition-policy changes share one
 * transaction that is deliberately rolled back.
 */
import {createHash, randomUUID} from "node:crypto";
import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {
  actors,
  createDirectDb,
  createPostgresJsCanonicalBridgeConnection,
  encryptionTransitionPolicy,
  eq,
  namespaces,
  roomEventRollups,
  roomJournalState,
  roomMembers,
  rooms,
} from "@nautilo/db";
import {bootstrapTestDbInstance} from "@nautilo/db/testing";
import {
  resolveInstanceUncached,
  resolvedInstanceChildEnv,
} from "@nautilo/config";
import {
  buildStenographerOutputRepairPlan,
  bindConversationProductCanonicalTransactionRunner,
  listPostgresStenographerFallbackCandidates,
  selectPostgresStenographerFallback,
  validatePostgresStenographerOutputRepairPlan,
  verifyConversationProductPostgresHandle,
  withPostgresStenographerOutputRepairSources,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";
import {encodeRoomEventRollupPayloadV1, encodeStenographerOutputRepairPlan} from "@nautilo/lattice-bridge";
import {stenographerOrdinaryOutputFingerprint} from
  "@nautilo/lattice-crypto/background";

import {createHmacProtectedStenographerRecordCommitmentPort} from "@nautilo/reflection-bridge/server";
import {PostgresProtectedJournalPublicationRepository} from "../../src/stenographer/protected-publication-repository";
import {PostgresProtectedStenographerWorkRepository} from "../../src/stenographer/protected-stenographer-work-repository";

const BASE = new Date("2000-01-01T00:00:00.000Z");
const ROLLBACK = new Error("M317 output repair integration rollback");
let db: ReturnType<typeof createDirectDb>;

beforeAll(() => {
  bootstrapTestDbInstance();
  const instance = resolveInstanceUncached(process.env, {
    skipHostBindProbe: true,
  });
  const child = resolvedInstanceChildEnv(instance, process.env);
  const productConnection = child["DB_CONNECTION_STRING"];
  if (productConnection === undefined
    || new URL(productConnection).username !== "nautilo") {
    throw new Error("M317 integration requires the named clone product role");
  }
  const directOverride = process.env["DB_DIRECT_CONNECTION"];
  try {
    process.env["DB_DIRECT_CONNECTION"] = productConnection;
    db = createDirectDb(1);
  } finally {
    if (directOverride === undefined) delete process.env["DB_DIRECT_CONNECTION"];
    else process.env["DB_DIRECT_CONNECTION"] = directOverride;
  }
});

afterAll(async () => {
  await db.end();
});

describe("M317 Stenographer output repair", () => {
  test("discovers exact metadata, lends canonical bytes, and closes ordinary access in Full", async () => {
    const canonical = createPostgresJsCanonicalBridgeConnection(db);
    try {
      await canonical.transaction(async (database, executor) => {
        const namespaceId = randomUUID();
        const roomId = randomUUID();
        const rollupId = randomUUID();
        const unique = rollupId.replaceAll("-", "");
        const [humanActor] = await database.select({
          id: actors.id,
          ownerId: actors.ownerId,
        }).from(actors).where(eq(actors.kind, "user")).limit(1);
        const [agentActor] = await database.select({
          id: actors.id,
        }).from(actors).where(eq(actors.kind, "agent")).limit(1);
        if (humanActor === undefined || agentActor === undefined) {
          throw new Error("M317 integration clone requires user and agent actors");
        }
        await database.insert(namespaces).values({
          id: namespaceId,
          scope: "private",
          label: `m317-output-repair-${unique}`,
        });
        await database.insert(rooms).values({
          id: roomId,
          ownerId: humanActor.ownerId,
          type: "private",
          label: "M317 output repair integration",
          graphThreadId: `room:${roomId}`,
          namespaceId,
          humanActorIds: [humanActor.id],
          createdBy: humanActor.id,
        });
        await database.insert(roomMembers).values([{
          roomId,
          actorId: humanActor.id,
          roomRole: "admin",
          joinedAt: BASE,
        }, {
          roomId,
          actorId: agentActor.id,
          roomRole: "member",
          joinedAt: BASE,
        }]);
        await database.insert(roomJournalState).values({
          roomId,
          extractorVersion: "m219-v1",
          historicalBackfillStatus: "not_needed",
        });

        const binding = {
          rollupId,
          roomId,
          namespaceId,
          throughEventSequence: 5,
          sourceEventCount: 5,
          modelId: "m317-integration",
          compactorVersion: "m219-v1",
          createdAt: BASE.toISOString(),
        };
        const payload = encodeRoomEventRollupPayloadV1({
          ...binding,
          content: "Retained completed ordinary result",
        });
        const fingerprint = stenographerOrdinaryOutputFingerprint({
          kind: "compaction",
          receiptId: rollupId,
          roomId,
          namespaceId,
          rebuildGeneration: 0,
          fallbackReason: "device",
          outputs: [{
            logicalId: rollupId,
            objectType: "room_event_rollup",
            createdAt: BASE.getTime(),
            payloadBytes: payload,
          }],
        });
        try {
          await database.insert(roomEventRollups).values({
            id: rollupId,
            roomId,
            throughEventSequence: binding.throughEventSequence,
            sourceEventCount: binding.sourceEventCount,
            modelId: binding.modelId,
            compactorVersion: binding.compactorVersion,
            createdAt: BASE,
            content: "Retained completed ordinary result",
            ordinaryFallbackReason: "device",
            ordinaryFallbackRebuildGeneration: 0,
            ordinaryOutputFingerprint: fingerprint,
          });
        } finally {
          fingerprint.fill(0);
        }

        await database.update(encryptionTransitionPolicy).set({
          mode: "shadow_encryption",
          shadowEncryptionStartedAt: new Date(),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
        const statements: string[] = [];
        const connection: ConversationProductPostgresConnection = {
          query: <Row extends ConversationProductDatabaseRow>(
            statement: string,
            parameters: readonly ConversationProductPostgresScalar[] = [],
          ): Promise<readonly Row[]> => {
            statements.push(statement);
            return executor.query<Row>(statement, parameters);
          },
          transaction: <Result>(
            callback: (transaction: ConversationProductPostgresConnection) =>
              Promise<Result>,
            _options: Readonly<{
              isolationLevel: ConversationProductPostgresIsolationLevel;
            }>,
          ): Promise<Result> => callback(connection),
        };
        const product = await verifyConversationProductPostgresHandle(connection);

        statements.length = 0;
        const page = await listPostgresStenographerFallbackCandidates({
          product,
          limit: 2,
        });
        expect(page.candidates.find(candidate => candidate.id === rollupId))
          .toEqual({
          kind: "compaction",
          id: rollupId,
          roomId,
          namespaceId,
          rebuildGeneration: 0,
          createdAt: BASE.getTime(),
          });
        const selection = await selectPostgresStenographerFallback({
          product,
          receipt: {kind: "compaction", id: rollupId},
        });
        expect(selection.status).toBe("ready");
        if (selection.status !== "ready") {
          throw new Error("Expected exact output repair selection");
        }
        const plan = buildStenographerOutputRepairPlan({
          selection,
          objectIdForMissing: () => `m317:integration:${rollupId}`,
        });
        if (plan === null) throw new Error("Expected nonempty repair plan");
        expect(statements.some(statement =>
          /select[^;]*(?:"content"|plaintext_payload_bytes)/isu.test(statement)
        )).toBe(false);

        expect(await validatePostgresStenographerOutputRepairPlan({
          transaction: connection,
          plan,
        })).toBe(true);
        let borrowed: Uint8Array | undefined;
        await withPostgresStenographerOutputRepairSources({
          transaction: connection,
          plan,
          signal: new AbortController().signal,
          use: sources => {
            expect(sources).toHaveLength(1);
            borrowed = sources[0]?.plaintextBytes ?? undefined;
            expect(borrowed).toEqual(payload);
            return Promise.resolve();
          },
        });
        expect(borrowed?.every(byte => byte === 0)).toBe(true);

        // Exercise real row labels and lease CAS for the no-crypto-commit case.
        // This proves metadata recovery only, not a simulated crypto attachment.
        const publications = new PostgresProtectedJournalPublicationRepository(product,
          createHmacProtectedStenographerRecordCommitmentPort(new Uint8Array(32).fill(19)));
        const bytes = encodeStenographerOutputRepairPlan(plan);
        const digest = Uint8Array.from(createHash("sha256").update(bytes).digest());
        const requestId = randomUUID();
        const leaseToken = randomUUID();
        const now = new Date();
        const reservation = {publicationId: requestId, requestId, workId: `repair:${rollupId}`,
          workIdentityHash: new Uint8Array(32).fill(7), descriptorHash: new Uint8Array(32).fill(8),
          attachmentPlanBytes: bytes, attachmentPlanHash: digest, leaseToken, now};
        const reserved = await publications.reserveOutputRepairWithinTransaction(connection, reservation);
        expect(reserved.state).toBe("reserved");
        const runner = bindConversationProductCanonicalTransactionRunner(product, {
          transaction: callback => callback(database, executor),
        });
        const work = new PostgresProtectedStenographerWorkRepository(product);
        let retireCalls = 0;
        const retirement = {roomId, namespaceId, workId: reservation.workId, canonical: runner,
          retire: () => {retireCalls++; return Promise.resolve(true);}};
        expect(await work.retireObsoleteUnstartedRequest(retirement)).toBe(false);
        expect(retireCalls).toBe(0);
        const abandoned = await publications.abandonReserved({publicationId: requestId, leaseToken,
          descriptorHash: reservation.descriptorHash, now});
        expect(abandoned.status).toBe("abandoned");
        expect(await work.retireObsoleteUnstartedRequest(retirement)).toBe(true);
        expect(retireCalls).toBe(1);
        const nextDescriptor = new Uint8Array(32).fill(10);
        const retried = await publications.reserveOutputRepairWithinTransaction(connection,
          {...reservation, descriptorHash: nextDescriptor, leaseToken: randomUUID()});
        expect(retried.state).toBe("reserved");
        expect(retried.descriptorHash).toEqual(nextDescriptor);
        expect(retried.attachmentPlanBytes).toEqual(bytes);

        await database.update(encryptionTransitionPolicy).set({
          mode: "encrypted_only",
        }).where(eq(encryptionTransitionPolicy.id, "server"));
        statements.length = 0;
        expect(await validatePostgresStenographerOutputRepairPlan({
          transaction: connection,
          plan,
        })).toBe(false);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toContain("encryption_transition_policy");

        throw ROLLBACK;
      }, {isolationLevel: "serializable"});
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
  }, 60_000);
});
