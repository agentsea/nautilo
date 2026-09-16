import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import {
  actors,
  agents,
  agentPhotoSelectionRevisions,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  AgentPhotoLibraryError,
  AgentPhotoLibraryService,
  type AgentPhotoLibraryAuthority,
  type AgentPhotoCreateResult,
  type AgentPhotoMutationResult,
  type AgentPhotoSelectionTransactionResult,
} from "../../src/lib/agent-photo-library-service";
import {
  deriveOwnedAvatarBlobId,
  discardOwnedAvatarStaging,
  publishStagedOwnedAvatar,
  stageOwnedAvatar,
  type StagedOwnedAvatar,
} from "../../src/photo-library/owned-avatar-staging";
import { AgentPhotoLibraryCreateCoordinator } from "../../src/lib/agent-photo-library-create-coordinator";
import { getAvatarBlobDir } from "../../src/routes/_helpers/avatar";

type Db = ReturnType<typeof createDirectDb>;

let db: Db;
let serverInstanceId: string;

interface Fixture {
  ownerUserId: string;
  agentId: string;
  profileId: string;
  authority: AgentPhotoLibraryAuthority;
  presentBlobIds: Set<string>;
  events: AgentPhotoMutationResult[];
  createEvents: AgentPhotoCreateResult[];
  service: AgentPhotoLibraryService;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(8);
  const [identity] = await db
    .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) throw new Error("D487 test instance identity is missing");
  serverInstanceId = identity.serverInstanceId;
}, 30_000);

afterAll(async () => {
  if (db) await db.end();
});

async function makeFixture(initialAvatar: { kind: "preset"; id: string } | null = { kind: "preset", id: "shell" }): Promise<Fixture> {
  const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const [owner] = await db
    .insert(users)
    .values({
      name: "D487 selection owner",
      email: `d487-selection-${nonce}@test.invalid`,
      handle: `d487${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("D487 selection owner insert failed");
  const [agent] = await db
    .insert(agents)
    .values({ handle: `d487-agent-${randomUUID()}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("D487 selection Agent insert failed");
  await db.insert(actors).values({
    ownerId: owner.id,
    displayName: "D487 selection Agent",
    kind: "agent",
    agentId: agent.id,
  });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: owner.id, agentId: agent.id, avatarRef: initialAvatar })
    .returning({ id: profiles.id });
  if (!profile) throw new Error("D487 selection profile insert failed");

  const authority = {
    serverInstanceId,
    viewerUserId: owner.id,
    ownerUserId: owner.id,
    agentId: agent.id,
  } satisfies AgentPhotoLibraryAuthority;
  const presentBlobIds = new Set<string>();
  const events: AgentPhotoMutationResult[] = [];
  const createEvents: AgentPhotoCreateResult[] = [];
  return {
    ownerUserId: owner.id,
    agentId: agent.id,
    profileId: profile.id,
    authority,
    presentBlobIds,
    events,
    createEvents,
    service: new AgentPhotoLibraryService({
      db,
      blobExists: ({ blobId }) => presentBlobIds.has(blobId),
      presetExists: (presetId) => presetId === "shell" || presetId === "avatar-01",
      afterCommit: (result) => {
        events.push(result);
      },
      afterCreateCommit: (result) => {
        createEvents.push(result);
      },
    }),
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await db.delete(agentPhotoSelectionRevisions).where(eq(agentPhotoSelectionRevisions.agentId, fixture.agentId));
  await db.delete(photoLibraryOperations).where(eq(photoLibraryOperations.agentId, fixture.agentId));
  await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, fixture.agentId));
  await db.delete(profiles).where(eq(profiles.id, fixture.profileId));
  await db.delete(actors).where(eq(actors.agentId, fixture.agentId));
  await db.delete(agents).where(eq(agents.id, fixture.agentId));
  await db.delete(users).where(eq(users.id, fixture.ownerUserId));
}

async function createEntry(fixture: Fixture, options: { present?: boolean; deleted?: boolean } = {}) {
  const blobId = `d487-selection-${randomUUID()}`;
  const now = new Date();
  const [entry] = await db
    .insert(ownedPhotoEntries)
    .values({
      serverInstanceId,
      ownerUserId: fixture.ownerUserId,
      subjectKind: "agent",
      agentId: fixture.agentId,
      avatarKind: "uploaded",
      blobId,
      source: "upload",
      origin: "mobile",
      operationId: randomUUID(),
      requestFingerprint: "a".repeat(64),
      mediaMimeType: "image/png",
      mediaByteSize: 42,
      mediaSha256: "b".repeat(64),
      deletedAt: options.deleted ? now : null,
      purgeAfter: options.deleted ? new Date(now.getTime() + 30 * 86_400_000) : null,
    })
    .returning();
  if (!entry) throw new Error("D487 selection entry insert failed");
  if (options.present !== false) fixture.presentBlobIds.add(blobId);
  return entry;
}

function selectInput(
  fixture: Fixture,
  target: { kind: "entry"; entryId: string } | { kind: "preset"; presetId: string } | { kind: "clear" },
  expectedSelectionRevision: string,
  operationId = randomUUID(),
) {
  return {
    authority: fixture.authority,
    operationId,
    expectedSelectionRevision,
    origin: "mobile" as const,
    target,
  };
}

function createInput(fixture: Fixture, operationId = randomUUID()) {
  return {
    authority: fixture.authority,
    operationId,
    slotCount: 1,
    source: "upload" as const,
    origin: "mobile" as const,
    semantics: [{ avatarKind: "uploaded" as const, media: { mimeType: "image/png" as const, byteSize: 42, sha256: "a".repeat(64) } }],
  };
}

function lifecycleInput(fixture: Fixture, entryId: string, operationId = randomUUID()) {
  return {
    authority: fixture.authority,
    operationId,
    entryId,
    origin: "mobile" as const,
  };
}

async function expectPhotoError(
  action: Promise<unknown>,
  code: AgentPhotoLibraryError["code"],
): Promise<AgentPhotoLibraryError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPhotoLibraryError);
    expect((error as AgentPhotoLibraryError).code).toBe(code);
    return error as AgentPhotoLibraryError;
  }
  throw new Error(`Expected AgentPhotoLibraryError(${code})`);
}

async function expectDbRejected(action: Promise<unknown>, message: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const cause = error as Error & { cause?: unknown };
    const causeMessage = cause.cause instanceof Error ? cause.cause.message : "";
    expect(`${cause.message}\n${causeMessage}`).toContain(message);
    return;
  }
  throw new Error(`Expected database rejection containing ${message}`);
}

async function expectRejected(action: Promise<unknown>, message: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`Expected rejection containing ${message}`);
}

/** Test the deployed trigger behaviour even when a long-lived scratch DB has an old migration checksum. */
async function installReservationIdentityTrigger(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION public.reject_photo_library_operation_identity_update()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
    BEGIN
      IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        IF OLD.state = 'failed'
          AND OLD.operation_kind = 'create'
          AND OLD.artifact_cleanup_completed_at IS NULL
          AND NEW.artifact_cleanup_completed_at IS NOT NULL
          AND ROW(
            NEW.id, NEW.server_instance_id, NEW.viewer_user_id, NEW.owner_user_id,
            NEW.agent_id, NEW.operation_id, NEW.operation_kind,
            NEW.request_fingerprint, NEW.state, NEW.result, NEW.created_at,
            NEW.completed_at, NEW.expires_at, NEW.reserved_slots,
            NEW.reservation_expires_at, NEW.reservation_lease_token
          ) IS NOT DISTINCT FROM ROW(
            OLD.id, OLD.server_instance_id, OLD.viewer_user_id, OLD.owner_user_id,
            OLD.agent_id, OLD.operation_id, OLD.operation_kind,
            OLD.request_fingerprint, OLD.state, OLD.result, OLD.created_at,
            OLD.completed_at, OLD.expires_at, OLD.reserved_slots,
            OLD.reservation_expires_at, OLD.reservation_lease_token
          ) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'completed photo library operation is immutable' USING ERRCODE = '23514';
      END IF;
      IF ROW(NEW.id, NEW.server_instance_id, NEW.viewer_user_id, NEW.owner_user_id, NEW.agent_id, NEW.operation_id, NEW.operation_kind, NEW.request_fingerprint, NEW.created_at, NEW.expires_at, NEW.reserved_slots, NEW.reservation_expires_at, NEW.reservation_lease_token) IS DISTINCT FROM ROW(OLD.id, OLD.server_instance_id, OLD.viewer_user_id, OLD.owner_user_id, OLD.agent_id, OLD.operation_id, OLD.operation_kind, OLD.request_fingerprint, OLD.created_at, OLD.expires_at, OLD.reserved_slots, OLD.reservation_expires_at, OLD.reservation_lease_token) THEN RAISE EXCEPTION 'photo library operation identity is immutable' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END;
    $$;
  `));
}

async function readProfile(fixture: Fixture) {
  const [row] = await db
    .select({
      avatarRef: profiles.avatarRef,
      selectionRevision: profiles.avatarSelectionRevision,
      libraryRevision: profiles.avatarLibraryRevision,
    })
    .from(profiles)
    .where(eq(profiles.id, fixture.profileId));
  if (!row) throw new Error("D487 selection profile disappeared");
  return row;
}

async function revisionRows(fixture: Fixture) {
  return db
    .select()
    .from(agentPhotoSelectionRevisions)
    .where(eq(agentPhotoSelectionRevisions.agentId, fixture.agentId));
}

describe("D487 AgentPhotoLibraryService atomic selection", () => {
  test("fences create reservations by lease, publishes one receipt/event, and rejects a duplicate pending provider start", async () => {
    const fixture = await makeFixture();
    try {
      await installReservationIdentityTrigger();
      const input = createInput(fixture);
      const reservation = await fixture.service.reserveCreate(input);
      if ("operation" in reservation) throw new Error("expected a live create reservation");
      await expectDbRejected(
        db.update(photoLibraryOperations).set({ reservedSlots: 2 })
          .where(eq(photoLibraryOperations.operationId, input.operationId)),
        "photo library operation identity is immutable",
      );
      await expectDbRejected(
        db.update(photoLibraryOperations).set({ reservationLeaseToken: randomUUID() })
          .where(eq(photoLibraryOperations.operationId, input.operationId)),
        "photo library operation identity is immutable",
      );
      await expectDbRejected(
        db.update(photoLibraryOperations).set({ requestFingerprint: "b".repeat(64) })
          .where(eq(photoLibraryOperations.operationId, input.operationId)),
        "photo library operation identity is immutable",
      );
      expect(reservation.leaseToken).toMatch(/^[0-9a-f-]{36}$/i);
      await expectPhotoError(fixture.service.reserveCreate(input), "operation_incomplete");
      const blobId = deriveOwnedAvatarBlobId({
        scope: fixture.authority,
        operationId: input.operationId,
        ordinal: 0,
      });
      const finalized = await fixture.service.finalizeCreate({
        ...input,
        leaseToken: reservation.leaseToken,
        entries: [{
          ordinal: 0,
          blobId,
          avatarKind: "uploaded",
          mediaMimeType: "image/png",
          mediaByteSize: 42,
          mediaSha256: "a".repeat(64),
        }],
      }, async () => {});
      expect(finalized).toMatchObject({ operation: "create", entryIds: [expect.any(String)], scope: { libraryRevision: "1" } });
      const replay = await fixture.service.finalizeCreate({
        ...input,
        leaseToken: randomUUID(),
        entries: [{
          ordinal: 0,
          blobId,
          avatarKind: "uploaded",
          mediaMimeType: "image/png",
          mediaByteSize: 42,
          mediaSha256: "a".repeat(64),
        }],
      }, async () => {});
      expect(replay).toEqual(finalized);
      expect(fixture.createEvents).toEqual([finalized]);
      const [operation] = await db.select().from(photoLibraryOperations).where(eq(photoLibraryOperations.operationId, input.operationId));
      expect(operation).toMatchObject({ state: "completed", reservedSlots: 1, reservationLeaseToken: reservation.leaseToken });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("rejects a stale create worker before its publish callback and keeps its pending row uncommitted", async () => {
    const fixture = await makeFixture();
    try {
      const input = createInput(fixture);
      const reservation = await fixture.service.reserveCreate(input);
      if ("operation" in reservation) throw new Error("expected a live create reservation");
      const replacement = randomUUID();
      const blobId = deriveOwnedAvatarBlobId({ scope: fixture.authority, operationId: input.operationId, ordinal: 0 });
      let published = false;
      await expectPhotoError(fixture.service.finalizeCreate({
        ...input,
        leaseToken: replacement,
        entries: [{ ordinal: 0, blobId, avatarKind: "uploaded", mediaMimeType: "image/png", mediaByteSize: 42, mediaSha256: "b".repeat(64) }],
      }, async () => { published = true; }), "operation_incomplete");
      expect(published).toBe(false);
      const state = await fixture.service.inspectCreateCommitState({
        authority: fixture.authority,
        operationId: input.operationId,
        leaseToken: reservation.leaseToken,
      });
      expect(state).toEqual({ kind: "not_committed" });
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.operationId, input.operationId))).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("reaps only a bounded page of expired reservations into terminal receipts", async () => {
    const fixture = await makeFixture();
    try {
      const operationId = randomUUID();
      const leaseToken = randomUUID();
      await db.insert(photoLibraryOperations).values({
        serverInstanceId,
        viewerUserId: fixture.ownerUserId,
        ownerUserId: fixture.ownerUserId,
        agentId: fixture.agentId,
        operationId,
        operationKind: "create",
        requestFingerprint: "c".repeat(64),
        state: "pending",
        reservedSlots: 1,
        reservationExpiresAt: new Date(Date.now() - 1_000),
        reservationLeaseToken: leaseToken,
      });
      const recovered = await fixture.service.reapExpiredCreateReservations({
        authority: fixture.authority,
        limit: 1,
      });
      expect(recovered).toEqual([{ operationId, leaseToken, slotCount: 1 }]);
      const [terminal] = await db.select().from(photoLibraryOperations)
        .where(eq(photoLibraryOperations.operationId, operationId));
      expect(terminal).toMatchObject({ state: "failed", reservationLeaseToken: leaseToken });
      expect((terminal?.result as { error?: { code?: string } })?.error?.code).toBe("operation_incomplete");
      const markers = await Promise.all(Array.from({ length: 2 }, () =>
        fixture.service.markExpiredCreateArtifactCleanupComplete({
          authority: fixture.authority,
          operationId,
          leaseToken,
        }),
      ));
      expect(markers).toEqual([true, true]);
      expect(await fixture.service.reapExpiredCreateReservations({ authority: fixture.authority, limit: 1 })).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("reaps expired artifact reservations in bounded repeated pages and retries terminal cleanup", async () => {
    const fixture = await makeFixture();
    const staged: StagedOwnedAvatar[] = [];
    try {
      const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#1e40af" } }).png().toBuffer();
      const expiredAt = new Date(Date.now() - 1_000);
      for (let index = 0; index < 17; index += 1) {
        const operationId = randomUUID();
        const leaseToken = randomUUID();
        const candidate = await stageOwnedAvatar({
          scope: fixture.authority,
          operationId,
          leaseToken,
          ordinal: 0,
          kind: "uploaded",
          bytes,
        });
        staged.push(candidate);
        await publishStagedOwnedAvatar(candidate);
        await db.insert(photoLibraryOperations).values({
          serverInstanceId,
          viewerUserId: fixture.ownerUserId,
          ownerUserId: fixture.ownerUserId,
          agentId: fixture.agentId,
          operationId,
          operationKind: "create",
          requestFingerprint: "d".repeat(64),
          state: "pending",
          reservedSlots: 1,
          reservationExpiresAt: expiredAt,
          reservationLeaseToken: leaseToken,
        });
      }
      // Simulate the first cleanup worker reaching the durable terminal
      // receipt but dying before its filesystem cleanup. A later bounded
      // coordinator sweep must see that failed receipt and clean it.
      const terminalOnly = await fixture.service.reapExpiredCreateReservations({
        authority: fixture.authority,
        limit: 1,
      });
      expect(terminalOnly).toHaveLength(1);
      const coordinator = new AgentPhotoLibraryCreateCoordinator(fixture.service);
      expect(await coordinator.reapExpiredReservations(fixture.authority)).toBe(16);
      expect(await coordinator.reapExpiredReservations(fixture.authority)).toBe(1);
      for (const candidate of staged) {
        expect(await Bun.file(join(getAvatarBlobDir("uploaded"), `${candidate.blobId}.png`)).exists()).toBe(false);
      }
      const remaining = await db.select({ id: photoLibraryOperations.id }).from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.agentId, fixture.agentId),
        eq(photoLibraryOperations.operationKind, "create"),
        eq(photoLibraryOperations.state, "pending"),
      ));
      expect(remaining).toHaveLength(0);
    } finally {
      await Promise.all(staged.flatMap((candidate) => [
        discardOwnedAvatarStaging(candidate),
        rm(join(getAvatarBlobDir("uploaded"), `${candidate.blobId}.png`), { force: true }),
      ]));
      await cleanupFixture(fixture);
    }
  }, 30_000);

  test("rejects generated ordinal omissions and saturated library revisions before provider work", async () => {
    const fixture = await makeFixture();
    try {
      const coordinator = new AgentPhotoLibraryCreateCoordinator(fixture.service);
      let generatedCalls = 0;
      await expectPhotoError(coordinator.produceStageAndFinalize({
        authority: fixture.authority,
        operationId: randomUUID(),
        slotCount: 1,
        source: "generation",
        origin: "mobile",
        semantics: [{ avatarKind: "generated", provider: "provider", model: "model" }],
        produceCandidates: async () => {
          generatedCalls += 1;
          return [];
        },
      }), "invalid_photo_request");
      expect(generatedCalls).toBe(0);

      await db.update(profiles).set({ avatarLibraryRevision: Number.MAX_SAFE_INTEGER })
        .where(eq(profiles.id, fixture.profileId));
      let saturatedCalls = 0;
      await expectPhotoError(coordinator.produceStageAndFinalize({
        ...createInput(fixture),
        produceCandidates: async () => {
          saturatedCalls += 1;
          return [];
        },
      }), "photo_library_unavailable");
      expect(saturatedCalls).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("commits one capacity failure receipt and replays it after capacity is freed", async () => {
    const fixture = await makeFixture();
    let artifact: StagedOwnedAvatar | null = null;
    try {
      for (let index = 0; index < 200; index += 1) await createEntry(fixture);
      const capacityInputs = Array.from({ length: 17 }, () => createInput(fixture));
      for (const capacityInput of capacityInputs) {
        await expectPhotoError(fixture.service.reserveCreate(capacityInput), "library_capacity_reached");
      }
      const input = capacityInputs[0]!;
      const rows = await db.select().from(photoLibraryOperations).where(eq(photoLibraryOperations.operationId, input.operationId));
      expect(rows).toHaveLength(1);
      const receipt = rows[0];
      if (!receipt) throw new Error("expected capacity receipt");
      expect(receipt.state).toBe("failed");
      expect(receipt.operationKind).toBe("create");
      expect(receipt.artifactCleanupCompletedAt).toBeInstanceOf(Date);
      const capacityReceipts = await db.select({ cleanup: photoLibraryOperations.artifactCleanupCompletedAt })
        .from(photoLibraryOperations)
        .where(and(
          eq(photoLibraryOperations.agentId, fixture.agentId),
          eq(photoLibraryOperations.operationKind, "create"),
          eq(photoLibraryOperations.state, "failed"),
        ));
      expect(capacityReceipts).toHaveLength(17);
      expect(capacityReceipts.every((receipt) => receipt.cleanup instanceof Date)).toBe(true);

      const artifactOperationId = randomUUID();
      const artifactLeaseToken = randomUUID();
      const artifactBytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#0f766e" } }).png().toBuffer();
      artifact = await stageOwnedAvatar({
        scope: fixture.authority,
        operationId: artifactOperationId,
        leaseToken: artifactLeaseToken,
        ordinal: 0,
        kind: "uploaded",
        bytes: artifactBytes,
      });
      await publishStagedOwnedAvatar(artifact);
      await db.insert(photoLibraryOperations).values({
        serverInstanceId,
        viewerUserId: fixture.ownerUserId,
        ownerUserId: fixture.ownerUserId,
        agentId: fixture.agentId,
        operationId: artifactOperationId,
        operationKind: "create",
        requestFingerprint: "e".repeat(64),
        state: "pending",
        reservedSlots: 1,
        reservationExpiresAt: new Date(Date.now() - 1_000),
        reservationLeaseToken: artifactLeaseToken,
      });
      const coordinator = new AgentPhotoLibraryCreateCoordinator(fixture.service);
      expect(await coordinator.reapExpiredReservations(fixture.authority)).toBe(1);
      expect(await Bun.file(join(getAvatarBlobDir("uploaded"), `${artifact.blobId}.png`)).exists()).toBe(false);

      const [entry] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, fixture.agentId)).limit(1);
      if (!entry) throw new Error("expected capacity fixture entry");
      await fixture.service.delete(lifecycleInput(fixture, entry.id));
      await expectPhotoError(fixture.service.reserveCreate(input), "library_capacity_reached");
      expect(await db.select().from(photoLibraryOperations).where(eq(photoLibraryOperations.operationId, input.operationId))).toHaveLength(1);
    } finally {
      if (artifact) {
        await Promise.all([
          discardOwnedAvatarStaging(artifact),
          rm(join(getAvatarBlobDir("uploaded"), `${artifact.blobId}.png`), { force: true }),
        ]);
      }
      await cleanupFixture(fixture);
    }
  }, 30_000);

  test("coordinates reserve, strict staging, no-overwrite publication, durable finalize, and one post-commit event", async () => {
    const fixture = await makeFixture();
    let finalPath = "";
    try {
      const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#e879f9" } }).png().toBuffer();
      const input = {
        ...createInput(fixture),
        semantics: [{ avatarKind: "uploaded" as const, media: { mimeType: "image/png" as const, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }],
      };
      const blobId = deriveOwnedAvatarBlobId({ scope: fixture.authority, operationId: input.operationId, ordinal: 0 });
      finalPath = join(getAvatarBlobDir("uploaded"), `${blobId}.png`);
      const coordinator = new AgentPhotoLibraryCreateCoordinator(fixture.service);
      const result = await coordinator.produceStageAndFinalize({
        ...input,
        produceCandidates: async () => [{ kind: "uploaded", bytes }],
      });
      expect(result.operation).toBe("create");
      expect(result.entryIds).toHaveLength(1);
      expect(await Bun.file(finalPath).exists()).toBe(true);
      expect(fixture.createEvents).toEqual([result]);
      const [entry] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, result.entryIds[0]!));
      expect(entry).toMatchObject({ blobId, mediaByteSize: bytes.length });
      let changedProducerRuns = 0;
      await expectPhotoError(coordinator.produceStageAndFinalize({
        ...input,
        semantics: [{
          avatarKind: "uploaded",
          media: { mimeType: "image/png", byteSize: bytes.length + 1, sha256: "b".repeat(64) },
        }],
        produceCandidates: async () => {
          changedProducerRuns += 1;
          return [{ kind: "uploaded", bytes }];
        },
      }), "idempotency_mismatch");
      expect(changedProducerRuns).toBe(0);
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.operationId, input.operationId))).toHaveLength(1);
    } finally {
      if (finalPath) await rm(finalPath, { force: true });
      await cleanupFixture(fixture);
    }
  });

  test("compensates published media when a composed create transaction aborts", async () => {
    const fixture = await makeFixture();
    let finalPath = "";
    try {
      const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#7c3aed" } }).png().toBuffer();
      const input = {
        ...createInput(fixture),
        source: "bundle_import" as const,
        origin: "bundle_import" as const,
        semantics: [{ avatarKind: "uploaded" as const, media: { mimeType: "image/png" as const, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }],
      };
      const blobId = deriveOwnedAvatarBlobId({ scope: fixture.authority, operationId: input.operationId, ordinal: 0 });
      finalPath = join(getAvatarBlobDir("uploaded"), `${blobId}.png`);
      const coordinator = new AgentPhotoLibraryCreateCoordinator(fixture.service);

      await expectRejected(
        coordinator.produceStageAndFinalize({
          ...input,
          produceCandidates: async () => [{ kind: "uploaded", bytes }],
        }, async () => {
          throw new Error("injected wider bundle transaction failure");
        }),
        "injected wider bundle transaction failure",
      );

      expect(await Bun.file(finalPath).exists()).toBe(false);
      expect(await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.operationId, input.operationId))).toHaveLength(0);
      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: { kind: "preset", id: "shell" },
        selectionRevision: 0,
        libraryRevision: 0,
      });
      expect(fixture.createEvents).toHaveLength(0);
      const [operation] = await db.select().from(photoLibraryOperations)
        .where(eq(photoLibraryOperations.operationId, input.operationId));
      expect(operation?.state).toBe("failed");
      expect(operation?.artifactCleanupCompletedAt).toBeInstanceOf(Date);
    } finally {
      if (finalPath) await rm(finalPath, { force: true });
      await cleanupFixture(fixture);
    }
  });

  test("rejects uploaded producer bytes that differ from the reservation facts", async () => {
    const fixture = await makeFixture();
    try {
      const reservedBytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#1d4ed8" } }).png().toBuffer();
      const producedBytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#dc2626" } }).png().toBuffer();
      const coordinator = new AgentPhotoLibraryCreateCoordinator(fixture.service);
      await expectPhotoError(coordinator.produceStageAndFinalize({
        ...createInput(fixture),
        semantics: [{
          avatarKind: "uploaded",
          media: {
            mimeType: "image/png",
            byteSize: reservedBytes.length,
            sha256: createHash("sha256").update(reservedBytes).digest("hex"),
          },
        }],
        produceCandidates: async () => [{ kind: "uploaded", bytes: producedBytes }],
      }), "idempotency_mismatch");
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);

  test("selects custom, preset, and clear targets with exact revisions; an already-current target is a canonical no-op", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      const selected = await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: entry.id },
        "0",
      ));
      expect(selected).toMatchObject({
        changed: true,
        currentAvatarRef: { kind: "uploaded", blobId: entry.blobId },
        currentEntryId: entry.id,
        scope: { selectionRevision: "1", libraryRevision: "1" },
      });

      const noOp = await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: entry.id },
        "1",
      ));
      expect(noOp).toMatchObject({
        changed: false,
        revisionId: null,
        scope: { selectionRevision: "1", libraryRevision: "1" },
      });
      const preset = await fixture.service.select(selectInput(
        fixture,
        { kind: "preset", presetId: "avatar-01" },
        "1",
      ));
      expect(preset).toMatchObject({
        currentAvatarRef: { kind: "preset", id: "avatar-01" },
        scope: { selectionRevision: "2", libraryRevision: "2" },
      });
      const cleared = await fixture.service.select(selectInput(
        fixture,
        { kind: "clear" },
        "2",
      ));
      expect(cleared).toMatchObject({
        currentAvatarRef: null,
        scope: { selectionRevision: "3", libraryRevision: "3" },
      });
      expect((await revisionRows(fixture)).map((row) => row.revision).sort()).toEqual([1, 2, 3]);
      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: null,
        selectionRevision: 3,
        libraryRevision: 3,
      });
      expect(fixture.events).toHaveLength(3);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("rolls canonical selection back with its caller-owned transaction and emits no event", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      const operationId = randomUUID();
      await expectRejected(
        db.transaction(async (tx) => {
          await fixture.service.selectInTransaction(
            tx,
            selectInput(fixture, { kind: "entry", entryId: entry.id }, "0", operationId),
          );
          expect(fixture.events).toHaveLength(0);
          throw new Error("injected outer transaction failure");
        }),
        "injected outer transaction failure",
      );

      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: { kind: "preset", id: "shell" },
        selectionRevision: 0,
        libraryRevision: 0,
      });
      expect(await revisionRows(fixture)).toHaveLength(0);
      expect(await db.select().from(photoLibraryOperations)
        .where(eq(photoLibraryOperations.operationId, operationId))).toHaveLength(0);
      expect(fixture.events).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("defers composed selection publication until the outer commit and publishes exactly once", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      let committed: AgentPhotoSelectionTransactionResult | null = null;
      await db.transaction(async (tx) => {
        committed = await fixture.service.selectInTransaction(
          tx,
          selectInput(fixture, { kind: "entry", entryId: entry.id }, "0"),
        );
        expect(fixture.events).toHaveLength(0);
      });

      expect(committed).not.toBeNull();
      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: { kind: "uploaded", blobId: entry.blobId },
        selectionRevision: 1,
        libraryRevision: 1,
      });
      expect(await revisionRows(fixture)).toHaveLength(1);
      expect(fixture.events).toHaveLength(0);
      await fixture.service.publishCommittedSelection(committed!);
      expect(fixture.events).toHaveLength(1);
      expect(fixture.events[0]).toEqual(committed!.value);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("replays the exact terminal receipt, rejects changed semantics and operation reuse across mutation kinds", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      const operationId = randomUUID();
      const input = selectInput(fixture, { kind: "entry", entryId: entry.id }, "0", operationId);
      const first = await fixture.service.select(input);
      const replay = await fixture.service.select({
        ...input,
        target: { entryId: entry.id, kind: "entry" },
      });
      expect(replay).toEqual(first);
      expect(await revisionRows(fixture)).toHaveLength(1);
      expect(fixture.events).toHaveLength(1);

      await expectPhotoError(
        fixture.service.select({ ...input, target: { kind: "preset", presetId: "shell" } }),
        "idempotency_mismatch",
      );
      await expectPhotoError(
        fixture.service.undo({
          authority: fixture.authority,
          operationId,
          expectedSelectionRevision: "1",
          origin: "mobile",
          revisionId: first.revisionId ?? randomUUID(),
        }),
        "idempotency_mismatch",
      );
      expect(await revisionRows(fixture)).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("rejects delete-to-create and create-to-restore operation id reuse before either second mutation runs", async () => {
    const fixture = await makeFixture();
    try {
      const active = await createEntry(fixture);
      const deleteOperationId = randomUUID();
      await fixture.service.delete(lifecycleInput(fixture, active.id, deleteOperationId));
      await expectPhotoError(
        fixture.service.reserveCreate(createInput(fixture, deleteOperationId)),
        "idempotency_mismatch",
      );

      const deleted = await createEntry(fixture, { deleted: true });
      const createOperationId = randomUUID();
      const reservation = await fixture.service.reserveCreate(createInput(fixture, createOperationId));
      if ("operation" in reservation) throw new Error("expected a live create reservation");
      await expectPhotoError(
        fixture.service.restore(lifecycleInput(fixture, deleted.id, createOperationId)),
        "idempotency_mismatch",
      );
      await fixture.service.failCreate({
        authority: fixture.authority,
        operationId: createOperationId,
        leaseToken: reservation.leaseToken,
        error: { code: "operation_incomplete", message: "test cleanup", retryable: true },
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("serializes parallel retries of the same operation into one identical committed result", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      const input = selectInput(
        fixture,
        { kind: "entry", entryId: entry.id },
        "0",
      );
      const [first, second] = await Promise.all([
        fixture.service.select(input),
        fixture.service.select(input),
      ]);
      expect(second).toEqual(first);
      expect(await revisionRows(fixture)).toHaveLength(1);
      expect(await readProfile(fixture)).toMatchObject({
        selectionRevision: 1,
        libraryRevision: 1,
      });
      expect(fixture.events).toHaveLength(1);
      const receipts = await db
        .select({ id: photoLibraryOperations.id })
        .from(photoLibraryOperations)
        .where(eq(photoLibraryOperations.operationId, input.operationId));
      expect(receipts).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("keeps a committed mutation successful when publication fails and never republishes its replay", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      const publicationErrors: unknown[] = [];
      let publicationAttempts = 0;
      const service = new AgentPhotoLibraryService({
        db,
        blobExists: ({ blobId }) => fixture.presentBlobIds.has(blobId),
        presetExists: (presetId) => presetId === "shell",
        afterCommit: () => {
          publicationAttempts += 1;
          throw new Error("injected publication failure");
        },
        onAfterCommitError: (error) => {
          publicationErrors.push(error);
        },
      });
      const input = selectInput(
        fixture,
        { kind: "entry", entryId: entry.id },
        "0",
      );
      const first = await service.select(input);
      const replay = await service.select(input);
      expect(replay).toEqual(first);
      expect(publicationAttempts).toBe(1);
      expect(publicationErrors).toHaveLength(1);
      expect(await revisionRows(fixture)).toHaveLength(1);
      expect(await readProfile(fixture)).toMatchObject({
        selectionRevision: 1,
        libraryRevision: 1,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("serializes concurrent selections so one wins and one receives an exact replayable conflict", async () => {
    const fixture = await makeFixture();
    try {
      const [left, right] = await Promise.all([createEntry(fixture), createEntry(fixture)]);
      const leftInput = selectInput(fixture, { kind: "entry", entryId: left.id }, "0");
      const rightInput = selectInput(fixture, { kind: "entry", entryId: right.id }, "0");
      const settled = await Promise.allSettled([
        fixture.service.select(leftInput),
        fixture.service.select(rightInput),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((result) => result.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(AgentPhotoLibraryError);
      const conflict = (rejected as PromiseRejectedResult).reason as AgentPhotoLibraryError;
      expect(conflict.code).toBe("selection_conflict");
      expect(conflict.current?.scope).toMatchObject({
        serverInstanceId,
        viewerUserId: fixture.ownerUserId,
        agentId: fixture.agentId,
        selectionRevision: "1",
        libraryRevision: "1",
      });
      const loserInput = settled[0]?.status === "rejected" ? leftInput : rightInput;
      await expectPhotoError(fixture.service.select(loserInput), "selection_conflict");
      expect(await revisionRows(fixture)).toHaveLength(1);
      expect(await readProfile(fixture)).toMatchObject({ selectionRevision: 1, libraryRevision: 1 });
      expect(fixture.events).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("undo restores the exact before ref as a new revision and refuses a superseded revision", async () => {
    const fixture = await makeFixture();
    try {
      const firstEntry = await createEntry(fixture);
      const secondEntry = await createEntry(fixture);
      const first = await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: firstEntry.id },
        "0",
      ));
      const second = await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: secondEntry.id },
        "1",
      ));
      await expectPhotoError(fixture.service.undo({
        authority: fixture.authority,
        operationId: randomUUID(),
        expectedSelectionRevision: "2",
        origin: "mobile",
        revisionId: first.revisionId ?? randomUUID(),
      }), "undo_conflict");

      const undone = await fixture.service.undo({
        authority: fixture.authority,
        operationId: randomUUID(),
        expectedSelectionRevision: "2",
        origin: "mobile",
        revisionId: second.revisionId ?? randomUUID(),
      });
      expect(undone).toMatchObject({
        operation: "undo",
        currentAvatarRef: { kind: "uploaded", blobId: firstEntry.blobId },
        currentEntryId: firstEntry.id,
        scope: { selectionRevision: "3", libraryRevision: "3" },
      });
      const rows = (await revisionRows(fixture)).sort((left, right) => left.revision - right.revision);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({
        revision: 3,
        beforeEntryId: secondEntry.id,
        afterEntryId: firstEntry.id,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("an undo racing a newer selection never clobbers the winner", async () => {
    const fixture = await makeFixture();
    try {
      const firstEntry = await createEntry(fixture);
      const secondEntry = await createEntry(fixture);
      const first = await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: firstEntry.id },
        "0",
      ));
      const undo = fixture.service.undo({
        authority: fixture.authority,
        operationId: randomUUID(),
        expectedSelectionRevision: "1",
        origin: "mobile",
        revisionId: first.revisionId ?? randomUUID(),
      });
      const select = fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: secondEntry.id },
        "1",
      ));
      const settled = await Promise.allSettled([undo, select]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const error = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(error.reason).toBeInstanceOf(AgentPhotoLibraryError);
      expect(["selection_conflict", "undo_conflict"]).toContain((error.reason as AgentPhotoLibraryError).code);
      expect(await revisionRows(fixture)).toHaveLength(2);
      expect(await readProfile(fixture)).toMatchObject({ selectionRevision: 2, libraryRevision: 2 });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("fails closed for foreign authority, foreign entries, stale server identity, deleted and missing blobs", async () => {
    const fixture = await makeFixture();
    const foreign = await makeFixture();
    try {
      const owned = await createEntry(fixture);
      const foreignEntry = await createEntry(foreign);
      const missing = await createEntry(fixture, { present: false });
      const deleted = await createEntry(fixture, { deleted: true });
      const foreignViewerOperationId = randomUUID();
      const foreignAgentOperationId = randomUUID();
      const staleServerOperationId = randomUUID();

      await expectPhotoError(fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: foreignEntry.id },
        "0",
      )), "photo_not_found");
      await expectPhotoError(fixture.service.select({
        ...selectInput(
          fixture,
          { kind: "entry", entryId: owned.id },
          "0",
          foreignViewerOperationId,
        ),
        authority: { ...fixture.authority, viewerUserId: foreign.ownerUserId },
      }), "photo_forbidden");
      await expectPhotoError(fixture.service.select({
        ...selectInput(
          fixture,
          { kind: "entry", entryId: owned.id },
          "0",
          foreignAgentOperationId,
        ),
        authority: { ...fixture.authority, agentId: foreign.agentId },
      }), "photo_forbidden");
      await expectPhotoError(fixture.service.select({
        ...selectInput(
          fixture,
          { kind: "entry", entryId: owned.id },
          "0",
          staleServerOperationId,
        ),
        authority: { ...fixture.authority, serverInstanceId: randomUUID() },
      }), "stale_viewer_scope");
      await expectPhotoError(fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: deleted.id },
        "0",
      )), "photo_deleted");
      await expectPhotoError(fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: missing.id },
        "0",
      )), "photo_blob_missing");

      for (const operationId of [
        foreignViewerOperationId,
        foreignAgentOperationId,
        staleServerOperationId,
      ]) {
        const unauthorizedReceipts = await db
          .select({ id: photoLibraryOperations.id })
          .from(photoLibraryOperations)
          .where(eq(photoLibraryOperations.operationId, operationId));
        expect(unauthorizedReceipts).toHaveLength(0);
      }
      expect(fixture.events).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
      await cleanupFixture(foreign);
    }
  });

  test("fails closed when the current custom ref has no owned entry", async () => {
    const fixture = await makeFixture(null);
    try {
      await db
        .update(profiles)
        .set({ avatarRef: { kind: "uploaded", blobId: `unowned-${randomUUID()}` } })
        .where(eq(profiles.id, fixture.profileId));
      const operationId = randomUUID();
      await expectPhotoError(fixture.service.select(selectInput(
        fixture,
        { kind: "preset", presetId: "shell" },
        "0",
        operationId,
      )), "photo_not_found");
      const receipts = await db
        .select({ id: photoLibraryOperations.id })
        .from(photoLibraryOperations)
        .where(eq(photoLibraryOperations.operationId, operationId));
      expect(receipts).toHaveLength(0);
      expect(await readProfile(fixture)).toMatchObject({
        selectionRevision: 0,
        libraryRevision: 0,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("undo refuses a deleted restore target and replays that exact terminal failure", async () => {
    const fixture = await makeFixture();
    try {
      const firstEntry = await createEntry(fixture);
      const secondEntry = await createEntry(fixture);
      await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: firstEntry.id },
        "0",
      ));
      const second = await fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: secondEntry.id },
        "1",
      ));
      const now = new Date();
      await db
        .update(ownedPhotoEntries)
        .set({ deletedAt: now, purgeAfter: new Date(now.getTime() + 30 * 86_400_000) })
        .where(eq(ownedPhotoEntries.id, firstEntry.id));
      const operationId = randomUUID();
      const undoInput = {
        authority: fixture.authority,
        operationId,
        expectedSelectionRevision: "2",
        origin: "mobile" as const,
        revisionId: second.revisionId ?? randomUUID(),
      };
      await expectPhotoError(fixture.service.undo(undoInput), "photo_deleted");
      await expectPhotoError(fixture.service.undo(undoInput), "photo_deleted");
      await db
        .update(ownedPhotoEntries)
        .set({ deletedAt: null, purgeAfter: null })
        .where(eq(ownedPhotoEntries.id, firstEntry.id));
      fixture.presentBlobIds.delete(firstEntry.blobId);
      await expectPhotoError(fixture.service.undo({
        ...undoInput,
        operationId: randomUUID(),
      }), "photo_blob_missing");
      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: { kind: "uploaded", blobId: secondEntry.blobId },
        selectionRevision: 2,
        libraryRevision: 2,
      });
      expect(await revisionRows(fixture)).toHaveLength(2);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("rolls back the profile update when the immutable revision cannot be appended", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      await db.insert(agentPhotoSelectionRevisions).values({
        serverInstanceId,
        ownerUserId: fixture.ownerUserId,
        agentId: fixture.agentId,
        revision: 1,
        beforeAvatarRef: { kind: "preset", id: "shell" },
        afterAvatarRef: { kind: "preset", id: "avatar-01" },
        actorUserId: fixture.ownerUserId,
        origin: "mobile",
        operationId: randomUUID(),
      });
      const operationId = randomUUID();
      let transactionFailed = false;
      try {
        await fixture.service.select(selectInput(
          fixture,
          { kind: "entry", entryId: entry.id },
          "0",
          operationId,
        ));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        transactionFailed = true;
      }
      expect(transactionFailed).toBe(true);
      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: { kind: "preset", id: "shell" },
        selectionRevision: 0,
        libraryRevision: 0,
      });
      const receipts = await db
        .select({ id: photoLibraryOperations.id })
        .from(photoLibraryOperations)
        .where(eq(photoLibraryOperations.operationId, operationId));
      expect(receipts).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("observes an entry lifecycle winner after the shared profile-first lock order", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      let releaseLifecycle!: () => void;
      let reportLocked!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseLifecycle = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        reportLocked = resolve;
      });
      const lifecycle = db.transaction(async (tx) => {
        await tx
          .select({ id: profiles.id })
          .from(profiles)
          .where(eq(profiles.id, fixture.profileId))
          .for("update");
        const now = new Date();
        await tx
          .update(ownedPhotoEntries)
          .set({ deletedAt: now, purgeAfter: new Date(now.getTime() + 30 * 86_400_000) })
          .where(eq(ownedPhotoEntries.id, entry.id));
        reportLocked();
        await release;
      });
      await locked;
      const selection = fixture.service.select(selectInput(
        fixture,
        { kind: "entry", entryId: entry.id },
        "0",
      ));
      releaseLifecycle();
      await lifecycle;
      await expectPhotoError(selection, "photo_deleted");
      expect(await revisionRows(fixture)).toHaveLength(0);
      expect(await readProfile(fixture)).toMatchObject({ selectionRevision: 0, libraryRevision: 0 });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("a real select and delete race never leaves the same entry current and deleted", async () => {
    const fixture = await makeFixture();
    try {
      const entry = await createEntry(fixture);
      const [selection, deletion] = await Promise.allSettled([
        fixture.service.select(selectInput(fixture, { kind: "entry", entryId: entry.id }, "0")),
        fixture.service.delete(lifecycleInput(fixture, entry.id)),
      ]);
      expect([selection, deletion].filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect([selection, deletion].filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const [stored] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, entry.id));
      const profile = await readProfile(fixture);
      const pointsToEntry = profile.avatarRef?.kind !== "preset" && profile.avatarRef?.blobId === entry.blobId;
      expect(pointsToEntry && stored?.deletedAt !== null).toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("soft-deletes only a non-current owned entry, retains bytes, and replays its receipt without a second event", async () => {
    const fixture = await makeFixture();
    try {
      const current = await createEntry(fixture);
      const target = await createEntry(fixture);
      await fixture.service.select(selectInput(fixture, { kind: "entry", entryId: current.id }, "0"));
      const before = await readProfile(fixture);
      const input = lifecycleInput(fixture, target.id);
      const deleted = await fixture.service.delete(input);
      expect(deleted).toMatchObject({ operation: "delete", changed: true, entryId: target.id });
      expect(deleted.scope.selectionRevision).toBe(before.selectionRevision.toString());
      expect(deleted.scope.libraryRevision).toBe((before.libraryRevision + 1).toString());
      const [row] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, target.id));
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.purgeAfter?.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(fixture.presentBlobIds.has(target.blobId)).toBe(true);
      expect(await readProfile(fixture)).toMatchObject({
        avatarRef: { kind: "uploaded", blobId: current.blobId },
        selectionRevision: before.selectionRevision,
        libraryRevision: before.libraryRevision + 1,
      });
      expect(fixture.events).toHaveLength(2);
      expect(await fixture.service.delete(input)).toEqual(deleted);
      expect(fixture.events).toHaveLength(2);
      await expectPhotoError(fixture.service.restore({ ...input, operationId: input.operationId }), "idempotency_mismatch");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("refuses deletion of the current entry without changing revisions or publishing", async () => {
    const fixture = await makeFixture();
    try {
      const current = await createEntry(fixture);
      await fixture.service.select(selectInput(fixture, { kind: "entry", entryId: current.id }, "0"));
      const input = lifecycleInput(fixture, current.id);
      const before = await readProfile(fixture);
      const eventsBefore = fixture.events.length;
      await expectPhotoError(fixture.service.delete(input), "invalid_photo_request");
      await expectPhotoError(fixture.service.delete(input), "invalid_photo_request");
      expect(await readProfile(fixture)).toEqual(before);
      expect(fixture.events).toHaveLength(eventsBefore);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("serializes concurrent deletes at the 100-photo recovery cap", async () => {
    const fixture = await makeFixture();
    try {
      for (let index = 0; index < 99; index += 1) await createEntry(fixture, { deleted: true });
      const first = await createEntry(fixture);
      const second = await createEntry(fixture);
      const before = await readProfile(fixture);
      const outcomes = await Promise.allSettled([
        fixture.service.delete(lifecycleInput(fixture, first.id)),
        fixture.service.delete(lifecycleInput(fixture, second.id)),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect((rejected.reason as AgentPhotoLibraryError).code).toBe("deleted_library_capacity_reached");
      }
      const deleted = await db.select({ id: ownedPhotoEntries.id }).from(ownedPhotoEntries)
        .where(eq(ownedPhotoEntries.agentId, fixture.agentId));
      expect(deleted).toHaveLength(101);
      expect(await readProfile(fixture)).toMatchObject({
        selectionRevision: before.selectionRevision,
        libraryRevision: before.libraryRevision + 1,
      });
      expect(fixture.events).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("restores only recoverable bytes, counts live create reservations, and leaves selection unchanged", async () => {
    const fixture = await makeFixture();
    try {
      const deleted = await createEntry(fixture, { deleted: true });
      const input = lifecycleInput(fixture, deleted.id);
      const restored = await fixture.service.restore(input);
      expect(restored).toMatchObject({ operation: "restore", changed: true, entryId: deleted.id });
      const [row] = await db.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, deleted.id));
      expect(row).toMatchObject({ deletedAt: null, purgeAfter: null, gcClaimToken: null, gcClaimedAt: null });
      expect(await fixture.service.restore(input)).toEqual(restored);
      expect(fixture.events).toHaveLength(1);

      const claimed = await createEntry(fixture, { deleted: true });
      let releaseClaim!: () => void;
      let reportClaimLock!: () => void;
      const claimReleased = new Promise<void>((resolve) => { releaseClaim = resolve; });
      const claimLocked = new Promise<void>((resolve) => { reportClaimLock = resolve; });
      const gcClaim = db.transaction(async (tx) => {
        // GC follows the same profile->entry order as every user lifecycle
        // mutation, so it cannot form an inverted lock cycle with restore.
        await tx.select({ id: profiles.id }).from(profiles)
          .where(eq(profiles.id, fixture.profileId)).for("update");
        await tx.select({ id: ownedPhotoEntries.id }).from(ownedPhotoEntries)
          .where(eq(ownedPhotoEntries.id, claimed.id)).for("update");
        reportClaimLock();
        await claimReleased;
        await tx.update(ownedPhotoEntries).set({ gcClaimToken: randomUUID(), gcClaimedAt: new Date() })
          .where(eq(ownedPhotoEntries.id, claimed.id));
      });
      await claimLocked;
      const beforeClaim = await readProfile(fixture);
      const restoreClaimed = fixture.service.restore(lifecycleInput(fixture, claimed.id));
      releaseClaim();
      await gcClaim;
      await expectPhotoError(restoreClaimed, "photo_deleted");
      expect(await readProfile(fixture)).toEqual(beforeClaim);

      const expired = await createEntry(fixture, { deleted: true });
      const expiredAt = new Date(Date.now() - 2_000);
      await db.update(ownedPhotoEntries).set({ deletedAt: expiredAt, purgeAfter: new Date(Date.now() - 1_000) })
        .where(eq(ownedPhotoEntries.id, expired.id));
      const beforeExpired = await readProfile(fixture);
      await expectPhotoError(fixture.service.restore(lifecycleInput(fixture, expired.id)), "photo_deleted");
      expect(await readProfile(fixture)).toEqual(beforeExpired);

      const missingBytes = await createEntry(fixture, { deleted: true, present: false });
      const beforeMissing = await readProfile(fixture);
      await expectPhotoError(fixture.service.restore(lifecycleInput(fixture, missingBytes.id)), "photo_blob_missing");
      expect(await readProfile(fixture)).toEqual(beforeMissing);
      expect(fixture.events).toHaveLength(1);

      const capacityFixture = await makeFixture();
      try {
        const recoverable = await createEntry(capacityFixture, { deleted: true });
        for (let index = 0; index < 199; index += 1) await createEntry(capacityFixture);
        const racingCreate = createInput(capacityFixture);
        const [restoreAtLimit, createAtLimit] = await Promise.allSettled([
          capacityFixture.service.restore(lifecycleInput(capacityFixture, recoverable.id)),
          capacityFixture.service.reserveCreate(racingCreate),
        ]);
        expect([restoreAtLimit, createAtLimit].filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect([restoreAtLimit, createAtLimit].filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
        if (createAtLimit.status === "fulfilled" && !("operation" in createAtLimit.value)) {
          await capacityFixture.service.failCreate({
            authority: capacityFixture.authority,
            operationId: racingCreate.operationId,
            leaseToken: createAtLimit.value.leaseToken,
            error: { code: "operation_incomplete", message: "test cleanup", retryable: true },
          });
        }
        if (restoreAtLimit.status === "fulfilled") {
          await capacityFixture.service.delete(lifecycleInput(capacityFixture, recoverable.id));
        }
        capacityFixture.events.length = 0;
        await capacityFixture.service.reserveCreate(createInput(capacityFixture));
        const fullOperation = createInput(capacityFixture);
        const firstCapacityFailure = await expectPhotoError(
          capacityFixture.service.reserveCreate(fullOperation),
          "library_capacity_reached",
        );
        const replayedCapacityFailure = await expectPhotoError(
          capacityFixture.service.reserveCreate(fullOperation),
          "library_capacity_reached",
        );
        expect(replayedCapacityFailure.message).toBe(firstCapacityFailure.message);
        const beforeCapacity = await readProfile(capacityFixture);
        await expectPhotoError(capacityFixture.service.restore(lifecycleInput(capacityFixture, recoverable.id)), "library_capacity_reached");
        expect(await readProfile(capacityFixture)).toEqual(beforeCapacity);
        expect(capacityFixture.events).toHaveLength(0);
      } finally {
        await cleanupFixture(capacityFixture);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);
});
