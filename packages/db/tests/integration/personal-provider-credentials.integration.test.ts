import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDirectDb,
  createPersonalProviderCredentialIdentity,
  deletePersonalProviderCredential,
  ensureDatabase,
  eq,
  getPersonalProviderCredential,
  getPersonalProviderCredentialCustodyEvidence,
  insertPersonalProviderCredential,
  listPersonalProviderCredentials,
  listPersonalProviderCredentialsForCustody,
  personalProviderCredentials,
  replacePersonalProviderCredential,
  setPersonalProviderCredentialValidation,
  sql,
  users,
  type DirectDatabase,
  type PersonalProviderCredentialEnvelope,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "personal-provider-credential-integration";

let db: DirectDatabase;
const fixtureUserIds: string[] = [];

function envelope(keyId = randomUUID(), marker = "initial"): PersonalProviderCredentialEnvelope {
  return {
    formatVersion: 1,
    keyId,
    nonceBase64: Buffer.from(`nonce:${marker}`).toString("base64"),
    ciphertextBase64: Buffer.from(`ciphertext:${marker}`).toString("base64"),
    authTagBase64: Buffer.from(`tag:${marker}`).toString("base64"),
  };
}

async function createFixtureUser(label: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ name: `${FIXTURE_PREFIX}:${label}:${randomUUID()}` })
    .returning({ id: users.id });
  if (!row) throw new Error("Credential fixture user was not created");
  fixtureUserIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
});

afterAll(async () => {
  for (const userId of fixtureUserIds) {
    await db?.delete(users).where(eq(users.id, userId));
  }
  await db?.end();
});

describe("personal provider credential storage", () => {
  test("scopes reads to one owner and provider and enforces one active row", async () => {
    const ownerId = await createFixtureUser("owner-scope");
    const otherId = await createFixtureUser("other-scope");
    const identity = createPersonalProviderCredentialIdentity();
    const sealed = envelope();
    expect(await insertPersonalProviderCredential(db, {
      identity,
      userId: ownerId,
      provider: "openai",
      envelope: sealed,
    })).toMatchObject({ status: "created" });
    expect(await insertPersonalProviderCredential(db, {
      identity: createPersonalProviderCredentialIdentity(),
      userId: ownerId,
      provider: "openai",
      envelope: envelope(),
    })).toEqual({ status: "already_exists" });

    expect(await getPersonalProviderCredential(db, otherId, "openai")).toBeNull();
    expect(await listPersonalProviderCredentials(db, otherId)).toEqual([]);
    expect(await getPersonalProviderCredential(db, ownerId, "anthropic")).toBeNull();
    const found = await getPersonalProviderCredential(db, ownerId, "openai");
    expect(found).toMatchObject({
      id: identity.id,
      userId: ownerId,
      provider: "openai",
      revision: 1,
      validationStatus: "unverified",
      validatedAt: null,
      destination: null,
      receiptReadStatus: "unknown",
      envelope: sealed,
    });
  });

  test("replaces and deletes only through exact owner, identity, and revision CAS", async () => {
    const ownerId = await createFixtureUser("cas-owner");
    const otherId = await createFixtureUser("cas-other");
    const identity = createPersonalProviderCredentialIdentity();
    await insertPersonalProviderCredential(db, {
      identity,
      userId: ownerId,
      provider: "anthropic",
      envelope: envelope(),
    });

    const validatedAt = new Date("2026-09-28T12:00:00.000Z");
    expect(await setPersonalProviderCredentialValidation(db, {
      userId: otherId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
      status: "accepted",
      validatedAt,
    })).toEqual({ status: "stale" });
    expect(await setPersonalProviderCredentialValidation(db, {
      userId: ownerId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
      status: "accepted",
      validatedAt,
    })).toMatchObject({
      status: "updated",
      credential: {
        revision: 1,
        validationStatus: "accepted",
        validatedAt,
        receiptReadStatus: "unknown",
      },
    });

    const replacement = envelope(randomUUID(), "replacement");
    expect(await replacePersonalProviderCredential(db, {
      userId: otherId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
      envelope: replacement,
    })).toEqual({ status: "not_found" });
    const replaced = await replacePersonalProviderCredential(db, {
      userId: ownerId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
      envelope: replacement,
    });
    expect(replaced).toMatchObject({
      status: "replaced",
      credential: {
        revision: 2,
        validationStatus: "unverified",
        validatedAt: null,
        receiptReadStatus: "unknown",
        envelope: replacement,
      },
    });
    expect(await setPersonalProviderCredentialValidation(db, {
      userId: ownerId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
      status: "rejected",
      validatedAt: new Date("2026-09-28T12:01:00.000Z"),
    })).toEqual({ status: "stale" });
    expect(await getPersonalProviderCredential(
      db,
      ownerId,
      "anthropic",
    )).toMatchObject({
      revision: 2,
      validationStatus: "unverified",
      validatedAt: null,
      receiptReadStatus: "unknown",
      envelope: replacement,
    });
    expect(await replacePersonalProviderCredential(db, {
      userId: ownerId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
      envelope: envelope(randomUUID(), "stale"),
    })).toEqual({ status: "conflict", currentRevision: 2 });
    expect(await deletePersonalProviderCredential(db, {
      userId: ownerId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 1,
    })).toEqual({ status: "conflict", currentRevision: 2 });
    expect(await deletePersonalProviderCredential(db, {
      userId: ownerId,
      provider: "anthropic",
      id: identity.id,
      expectedRevision: 2,
    })).toEqual({ status: "deleted" });
    expect(await getPersonalProviderCredential(db, ownerId, "anthropic")).toBeNull();
  });

  test("pages raw envelopes for custody verification and cascades account deletion", async () => {
    const ownerId = await createFixtureUser("custody-page");
    const keyId = randomUUID();
    for (const provider of ["google", "xai"] as const) {
      await insertPersonalProviderCredential(db, {
        identity: createPersonalProviderCredentialIdentity(),
        userId: ownerId,
        provider,
        envelope: envelope(keyId, provider),
      });
    }
    const ownerRows = await listPersonalProviderCredentials(db, ownerId);
    const pagedIds = new Set<string>();
    let afterId: string | undefined;
    while (true) {
      const page = await listPersonalProviderCredentialsForCustody(db, {
        ...(afterId === undefined ? {} : { afterId }),
        limit: 1,
      });
      if (page.length === 0) break;
      const [row] = page;
      if (!row) throw new Error("Custody page unexpectedly lacked its row");
      pagedIds.add(row.id);
      afterId = row.id;
    }
    for (const row of ownerRows) expect(pagedIds.has(row.id)).toBe(true);

    const evidence = await getPersonalProviderCredentialCustodyEvidence(db);
    expect(evidence.recordCount).toBeGreaterThanOrEqual(ownerRows.length);
    expect(evidence.keyIds).toContain(keyId);

    await db.delete(users).where(eq(users.id, ownerId));
    const remaining = await db
      .select({ id: personalProviderCredentials.id })
      .from(personalProviderCredentials)
      .where(eq(personalProviderCredentials.userId, ownerId));
    expect(remaining).toEqual([]);
  });

  test("round-trips Surplus receipt readiness and Gateway destination custody metadata", async () => {
    const ownerId = await createFixtureUser("provider-metadata");
    const surplusIdentity = createPersonalProviderCredentialIdentity();
    const surplusEnvelope = envelope(randomUUID(), "surplus");
    expect(await insertPersonalProviderCredential(db, {
      identity: surplusIdentity,
      userId: ownerId,
      provider: "surplus",
      envelope: surplusEnvelope,
      validationStatus: "accepted",
      validatedAt: new Date("2026-10-05T10:00:00.000Z"),
      receiptReadStatus: "unavailable",
    })).toMatchObject({
      status: "created",
      credential: {
        provider: "surplus",
        destination: null,
        receiptReadStatus: "unavailable",
        envelope: surplusEnvelope,
      },
    });

    expect(await setPersonalProviderCredentialValidation(db, {
      userId: ownerId,
      provider: "surplus",
      id: surplusIdentity.id,
      expectedRevision: 1,
      status: "accepted",
      validatedAt: new Date("2026-10-05T10:01:00.000Z"),
      receiptReadStatus: "available",
    })).toMatchObject({
      status: "updated",
      credential: { receiptReadStatus: "available" },
    });

    const gatewayIdentity = createPersonalProviderCredentialIdentity();
    const gatewayDestination = "https://gateway.example.test/tenant/v1";
    expect(await insertPersonalProviderCredential(db, {
      identity: gatewayIdentity,
      userId: ownerId,
      provider: "gateway",
      envelope: envelope(randomUUID(), "gateway"),
      destination: gatewayDestination,
    })).toMatchObject({
      status: "created",
      credential: {
        provider: "gateway",
        destination: gatewayDestination,
        receiptReadStatus: "unknown",
      },
    });

    const custodyRows = await listPersonalProviderCredentialsForCustody(db, { limit: 100 });
    expect(custodyRows.some((row) => row.id === gatewayIdentity.id
      && row.userId === ownerId
      && row.provider === "gateway"
      && row.destination === gatewayDestination)).toBe(true);
  });

  test("enforces provider-specific destination and receipt-read constraints", async () => {
    const ownerId = await createFixtureUser("provider-constraints");
    const invalidDestinationEnvelope = envelope(randomUUID(), "invalid-destination");
    let destinationRejected = false;
    try {
      await db.insert(personalProviderCredentials).values({
        id: randomUUID(),
        userId: ownerId,
        provider: "openai",
        revision: 1,
        destination: "https://gateway.example.test/v1",
        validationStatus: "unverified",
        validatedAt: null,
        receiptReadStatus: "unknown",
        ...invalidDestinationEnvelope,
      });
    } catch {
      destinationRejected = true;
    }
    expect(destinationRejected).toBe(true);

    const invalidReceiptEnvelope = envelope(randomUUID(), "invalid-receipt-status");
    let receiptStatusRejected = false;
    try {
      await db.insert(personalProviderCredentials).values({
        id: randomUUID(),
        userId: ownerId,
        provider: "gateway",
        revision: 1,
        destination: "https://gateway.example.test/v1",
        validationStatus: "accepted",
        validatedAt: new Date("2026-10-05T10:02:00.000Z"),
        receiptReadStatus: "available",
        ...invalidReceiptEnvelope,
      });
    } catch {
      receiptStatusRejected = true;
    }
    expect(receiptStatusRejected).toBe(true);
  });

  test("grants full access only to the product role", async () => {
    const result = await db.execute<{
      role_name: string;
      can_access: boolean;
    }>(sql`
      SELECT role_name, can_access
      FROM (
        SELECT role_name,
               has_table_privilege(
                 role_name,
                 'public.personal_provider_credentials',
                 'SELECT, INSERT, UPDATE, DELETE'
               ) AS can_access
        FROM (VALUES ('nautilo'), ('nautilo_agent'), ('nautilo_crypto'))
          AS roles(role_name)
        UNION ALL
        SELECT 'public' AS role_name,
               EXISTS (
                 SELECT 1
                 FROM information_schema.role_table_grants
                 WHERE table_schema = 'public'
                   AND table_name = 'personal_provider_credentials'
                   AND grantee = 'PUBLIC'
                   AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
               ) AS can_access
      ) AS privilege_boundary
      ORDER BY role_name
    `);
    expect([...result]).toEqual([
      { role_name: "nautilo", can_access: true },
      { role_name: "nautilo_agent", can_access: false },
      { role_name: "nautilo_crypto", can_access: false },
      { role_name: "public", can_access: false },
    ]);
  });
});
