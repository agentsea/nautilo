import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  createDirectDb,
  createMediaGeneration,
  ensureDatabase,
  eq,
  findMediaGeneration,
  mediaGenerations,
  namespaces,
  roomMembers,
  rooms,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { DurableServiceFundingBinding } from "@nautilo/types";

let db: DirectDatabase;
let ownerId = "";
let ownerActorId = "";
let namespaceId = "";
let roomId = "";

const MODEL = "funding-fixture-model";
const APPROVAL_DIGEST = "a".repeat(64);
const QUOTE_DIGEST = "b".repeat(64);

function receiptId(label: string): string {
  return `funding-${label}-${randomUUID()}`;
}

function fingerprint(character: string): string {
  return character.repeat(64);
}

function serverBinding(
  provider: "venice" | "surplus",
  accountFingerprint: string,
): DurableServiceFundingBinding {
  return {
    humanUserId: ownerId,
    provider,
    binding: { kind: "server", providerRoute: provider },
    credentialFingerprint: accountFingerprint,
  };
}

function personalBinding(
  provider: "venice" | "surplus",
  accountFingerprint: string,
  credentialRevision: number,
): DurableServiceFundingBinding {
  return {
    humanUserId: ownerId,
    provider,
    binding: {
      kind: "personal",
      providerRoute: provider,
      credentialId: randomUUID(),
      credentialRevision,
    },
    credentialFingerprint: accountFingerprint,
  };
}

function row<T extends DurableServiceFundingBinding | null>(
  label: string,
  provider: "venice" | "surplus",
  providerAccountFingerprint: string,
  fundingBinding: T,
) {
  return {
    receiptId: receiptId(label),
    ownerId,
    roomId,
    namespaceId,
    kind: "video" as const,
    provider,
    providerModel: MODEL,
    providerAccountFingerprint,
    fundingBinding,
    approvalDigest: APPROVAL_DIGEST,
    quoteDigest: QUOTE_DIGEST,
    safeSnapshot: {
      version: 1 as const,
      normalizedSettings: { durationSeconds: 5 },
      inputSummary: { promptCharacters: 15 },
    },
    requestPayload: {
      version: 1 as const,
      model: MODEL,
      prompt: "Synthetic prompt",
      normalizedSettings: { durationSeconds: 5 },
    },
    quotedUsdMicros: 250_000,
  };
}

async function expectProviderShapeRejected(
  value: ReturnType<typeof row<DurableServiceFundingBinding | null>>,
): Promise<void> {
  const error = await db.insert(mediaGenerations).values(value)
    .then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({
    cause: {
      code: "23514",
      constraint_name: "media_generations_provider_shape",
    },
  });
}

async function expectFundingUpdateRejected(
  receipt: string,
  replacement: DurableServiceFundingBinding | null,
  original: DurableServiceFundingBinding | null,
): Promise<void> {
  const error = await db.update(mediaGenerations)
    .set({ fundingBinding: replacement, revision: 1 })
    .where(eq(mediaGenerations.receiptId, receipt))
    .then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ cause: { code: "23514" } });

  const stored = await findMediaGeneration(
    db,
    { ownerId, roomId, namespaceId },
    receipt,
  );
  expect(stored?.revision).toBe(0);
  expect(stored?.fundingBinding).toEqual(original);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);

  const [owner] = await db.insert(users).values({
    name: `Media funding fixture ${randomUUID()}`,
  }).returning({ id: users.id });
  if (!owner) throw new Error("Media funding fixture owner was not created");
  ownerId = owner.id;

  const [ownerActor] = await db.insert(actors).values({
    ownerId,
    displayName: "Media funding fixture Human",
    kind: "user",
  }).returning({ id: actors.id });
  if (!ownerActor) throw new Error("Media funding fixture Human actor was not created");
  ownerActorId = ownerActor.id;

  const [namespace] = await db.insert(namespaces).values({
    scope: "room",
    label: `media-funding-${randomUUID()}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("Media funding fixture namespace was not created");
  namespaceId = namespace.id;

  const [room] = await db.insert(rooms).values({
    ownerId,
    type: "private",
    label: `Media funding ${randomUUID()}`,
    graphThreadId: `media-funding:${randomUUID()}`,
    namespaceId,
    humanActorIds: [ownerActorId],
    createdBy: ownerActorId,
  }).returning({ id: rooms.id });
  if (!room) throw new Error("Media funding fixture Room was not created");
  roomId = room.id;
  await db.insert(roomMembers).values({
    roomId,
    actorId: ownerActorId,
    roomRole: "admin",
  });
}, 120_000);

afterAll(async () => {
  if (!db) return;
  if (roomId) await db.delete(mediaGenerations).where(eq(mediaGenerations.roomId, roomId));
  if (roomId && ownerActorId) {
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  }
  if (roomId) await db.delete(rooms).where(eq(rooms.id, roomId));
  if (ownerActorId) await db.delete(actors).where(eq(actors.id, ownerActorId));
  if (namespaceId) await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
  if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
  await db.end();
});

describe("media generation funding persistence", () => {
  test("server and personal bindings round-trip with exact surrogate credential revisions", async () => {
    const serverFingerprint = fingerprint("c");
    const personalFingerprint = fingerprint("d");
    const server = row("server", "surplus", serverFingerprint,
      serverBinding("surplus", serverFingerprint));
    const personal = row("personal", "venice", personalFingerprint,
      personalBinding("venice", personalFingerprint, 73));

    await createMediaGeneration(db, {
      ...server,
      initiatingAgentId: null,
      initiatingThreadId: null,
    });
    await createMediaGeneration(db, {
      ...personal,
      initiatingAgentId: null,
      initiatingThreadId: null,
    });

    const scope = { ownerId, roomId, namespaceId };
    const storedServer = await findMediaGeneration(db, scope, server.receiptId);
    const storedPersonal = await findMediaGeneration(db, scope, personal.receiptId);
    expect(storedServer?.fundingBinding).toEqual(server.fundingBinding);
    expect(storedPersonal?.fundingBinding).toEqual(personal.fundingBinding);
    expect(storedPersonal?.fundingBinding?.binding).toMatchObject({
      kind: "personal",
      credentialRevision: 73,
    });
  });

  test("SQL rejects owner, provider, and account-fingerprint mismatches", async () => {
    const accountFingerprint = fingerprint("e");
    const exact = serverBinding("surplus", accountFingerprint);

    await expectProviderShapeRejected({
      ...row("owner-mismatch", "surplus", accountFingerprint, exact),
      fundingBinding: { ...exact, humanUserId: randomUUID() },
    });
    await expectProviderShapeRejected({
      ...row("provider-mismatch", "surplus", accountFingerprint, exact),
      fundingBinding: {
        ...exact,
        provider: "venice",
        binding: { kind: "server", providerRoute: "venice" },
      },
    });
    await expectProviderShapeRejected({
      ...row("fingerprint-mismatch", "surplus", accountFingerprint, exact),
      fundingBinding: { ...exact, credentialFingerprint: fingerprint("f") },
    });
  });

  test("SQL rejects scalar and null nested funding JSON", async () => {
    const accountFingerprint = fingerprint("1");
    const exact = personalBinding("surplus", accountFingerprint, 5);
    for (const [label, malformed] of [
      ["scalar", "surplus"],
      ["null-binding", { ...exact, binding: null }],
      ["null-revision", {
        ...exact,
        binding: { ...exact.binding, credentialRevision: null },
      }],
    ] as const) {
      await expectProviderShapeRejected(row(
        label,
        "surplus",
        accountFingerprint,
        malformed as unknown as DurableServiceFundingBinding,
      ));
    }
  });

  test("legacy null funding is limited to Venice", async () => {
    const legacy = row("legacy-venice", "venice", fingerprint("2"), null);
    const [stored] = await db.insert(mediaGenerations).values(legacy).returning({
      provider: mediaGenerations.provider,
      fundingBinding: mediaGenerations.fundingBinding,
    });
    expect(stored).toEqual({ provider: "venice", fundingBinding: null });

    await expectProviderShapeRejected(
      row("legacy-surplus", "surplus", fingerprint("3"), null),
    );
  });

  test("funding binding is immutable across otherwise valid lifecycle updates", async () => {
    const serverFingerprint = fingerprint("5");
    const originalServer = serverBinding("surplus", serverFingerprint);
    const serverReceipt = row(
      "immutable-server",
      "surplus",
      serverFingerprint,
      originalServer,
    );
    await createMediaGeneration(db, {
      ...serverReceipt,
      initiatingAgentId: null,
      initiatingThreadId: null,
    });
    await expectFundingUpdateRejected(
      serverReceipt.receiptId,
      personalBinding("surplus", serverFingerprint, 1),
      originalServer,
    );

    const personalToServerFingerprint = fingerprint("8");
    const originalPersonalForKindChange = personalBinding(
      "surplus",
      personalToServerFingerprint,
      2,
    );
    const personalToServerReceipt = row(
      "immutable-personal-to-server",
      "surplus",
      personalToServerFingerprint,
      originalPersonalForKindChange,
    );
    await createMediaGeneration(db, {
      ...personalToServerReceipt,
      initiatingAgentId: null,
      initiatingThreadId: null,
    });
    await expectFundingUpdateRejected(
      personalToServerReceipt.receiptId,
      serverBinding("surplus", personalToServerFingerprint),
      originalPersonalForKindChange,
    );

    const personalFingerprint = fingerprint("6");
    const originalPersonal = personalBinding("venice", personalFingerprint, 11);
    if (originalPersonal.binding.kind !== "personal") {
      throw new Error("Expected a personal funding fixture");
    }
    for (const [label, replacement] of [
      ["credential-id", {
        ...originalPersonal,
        binding: { ...originalPersonal.binding, credentialId: randomUUID() },
      }],
      ["credential-revision", {
        ...originalPersonal,
        binding: { ...originalPersonal.binding, credentialRevision: 12 },
      }],
    ] as const) {
      const personalReceipt = row(
        `immutable-${label}`,
        "venice",
        personalFingerprint,
        originalPersonal,
      );
      await createMediaGeneration(db, {
        ...personalReceipt,
        initiatingAgentId: null,
        initiatingThreadId: null,
      });
      await expectFundingUpdateRejected(
        personalReceipt.receiptId,
        replacement,
        originalPersonal,
      );
    }

    const legacyFingerprint = fingerprint("7");
    const legacyReceipt = row(
      "immutable-legacy-null",
      "venice",
      legacyFingerprint,
      null,
    );
    await db.insert(mediaGenerations).values(legacyReceipt);
    await expectFundingUpdateRejected(
      legacyReceipt.receiptId,
      serverBinding("venice", legacyFingerprint),
      null,
    );

    const boundFingerprint = fingerprint("9");
    const originalBound = serverBinding("venice", boundFingerprint);
    const boundReceipt = row(
      "immutable-bound-to-null",
      "venice",
      boundFingerprint,
      originalBound,
    );
    await createMediaGeneration(db, {
      ...boundReceipt,
      initiatingAgentId: null,
      initiatingThreadId: null,
    });
    await expectFundingUpdateRejected(
      boundReceipt.receiptId,
      null,
      originalBound,
    );
  });

  test("actual cost and revision advance beyond int4 while funding stays unchanged", async () => {
    const accountFingerprint = fingerprint("4");
    const value = 4_294_967_296;
    const receipt = row("bigint-cost", "surplus", accountFingerprint,
      serverBinding("surplus", accountFingerprint));
    await createMediaGeneration(db, {
      ...receipt,
      initiatingAgentId: null,
      initiatingThreadId: null,
    });
    await db.update(mediaGenerations)
      .set({ actualUsdMicros: value, revision: 1 })
      .where(eq(mediaGenerations.receiptId, receipt.receiptId));

    const stored = await findMediaGeneration(
      db,
      { ownerId, roomId, namespaceId },
      receipt.receiptId,
    );
    expect(stored?.actualUsdMicros).toBe(value);
    expect(stored?.revision).toBe(1);
    expect(stored?.fundingBinding).toEqual(receipt.fundingBinding);
    expect(Number.isSafeInteger(stored?.actualUsdMicros)).toBe(true);
  });
});
