import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDirectDb,
  createPersonalProviderCredentialIdentity,
  ensureDatabase,
  eq,
  getPersonalProviderCredential,
  insertPersonalProviderCredential,
  personalProviderCredentials,
  replacePersonalProviderCredential,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
  PersonalProviderCustodyError,
  type PersonalProviderCredentialContext,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";

type Db = ReturnType<typeof createDirectDb>;

const OLD_CUSTODY: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "10000000-0000-4000-8000-000000000001",
  keyHex: "11".repeat(32),
};
const NEW_CUSTODY: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "20000000-0000-4000-8000-000000000002",
  keyHex: "22".repeat(32),
};
const INITIAL_SECRET = "sk-integration-initial-provider-secret";
const REPLACEMENT_SECRET = "sk-integration-replacement-provider-secret";

let db: Db;
let ownerId: string;
let otherUserId: string;

function expectCustodyError(
  operation: () => unknown,
  code: PersonalProviderCustodyError["code"],
): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(PersonalProviderCustodyError);
  expect((failure as PersonalProviderCustodyError).code).toBe(code);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const created = await db.insert(users).values([
    {
      name: "Provider custody integration owner",
      email: `provider-custody-owner-${suffix}@test.invalid`,
      handle: `providercustodyowner${suffix}`,
    },
    {
      name: "Provider custody integration other",
      email: `provider-custody-other-${suffix}@test.invalid`,
      handle: `providercustodyother${suffix}`,
    },
  ]).returning({ id: users.id });
  if (!created[0] || !created[1]) {
    throw new Error("Personal provider custody fixture users were not created");
  }
  ownerId = created[0].id;
  otherUserId = created[1].id;
}, 120_000);

afterAll(async () => {
  if (!db) return;
  if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
  if (otherUserId) await db.delete(users).where(eq(users.id, otherUserId));
  await db.end();
});

describe("personal provider credential encryption and storage", () => {
  test("binds ciphertext to its owner and revision, replaces without the old key, and cascades account deletion", async () => {
    const identity = createPersonalProviderCredentialIdentity();
    const initialContext: PersonalProviderCredentialContext = {
      id: identity.id,
      userId: ownerId,
      provider: "openai",
      revision: identity.revision,
    };
    const initialEnvelope = encryptPersonalProviderCredential(
      OLD_CUSTODY,
      INITIAL_SECRET,
      initialContext,
    );

    const inserted = await insertPersonalProviderCredential(db, {
      identity,
      userId: ownerId,
      provider: "openai",
      envelope: initialEnvelope,
    });
    expect(inserted.status).toBe("created");

    const storedInitial = await getPersonalProviderCredential(
      db,
      ownerId,
      "openai",
    );
    expect(storedInitial).not.toBeNull();
    expect(decryptPersonalProviderCredential(
      OLD_CUSTODY,
      storedInitial!.envelope,
      {
        id: storedInitial!.id,
        userId: storedInitial!.userId,
        provider: storedInitial!.provider,
        revision: storedInitial!.revision,
      },
    )).toBe(INITIAL_SECRET);

    const [rawInitial] = await db.select()
      .from(personalProviderCredentials)
      .where(eq(personalProviderCredentials.id, identity.id));
    const serializedInitial = JSON.stringify(rawInitial);
    expect(serializedInitial).not.toContain(INITIAL_SECRET);
    expect(serializedInitial).not.toContain(REPLACEMENT_SECRET);

    expectCustodyError(
      () => decryptPersonalProviderCredential(
        OLD_CUSTODY,
        storedInitial!.envelope,
        { ...initialContext, userId: otherUserId },
      ),
      "credential_authentication_failed",
    );
    expectCustodyError(
      () => decryptPersonalProviderCredential(
        NEW_CUSTODY,
        storedInitial!.envelope,
        initialContext,
      ),
      "custody_key_mismatch",
    );

    const replacementContext: PersonalProviderCredentialContext = {
      ...initialContext,
      revision: 2,
    };
    const replacementEnvelope = encryptPersonalProviderCredential(
      NEW_CUSTODY,
      REPLACEMENT_SECRET,
      replacementContext,
    );
    const replaced = await replacePersonalProviderCredential(db, {
      id: identity.id,
      userId: ownerId,
      provider: "openai",
      expectedRevision: 1,
      envelope: replacementEnvelope,
    });
    expect(replaced.status).toBe("replaced");
    if (replaced.status !== "replaced") {
      throw new Error("Personal provider credential CAS replacement failed");
    }
    expect(replaced.credential.revision).toBe(2);
    expect(decryptPersonalProviderCredential(
      NEW_CUSTODY,
      replaced.credential.envelope,
      replacementContext,
    )).toBe(REPLACEMENT_SECRET);

    const [rawReplacement] = await db.select()
      .from(personalProviderCredentials)
      .where(eq(personalProviderCredentials.id, identity.id));
    const serializedReplacement = JSON.stringify(rawReplacement);
    expect(serializedReplacement).not.toContain(INITIAL_SECRET);
    expect(serializedReplacement).not.toContain(REPLACEMENT_SECRET);

    await db.delete(users).where(eq(users.id, ownerId));
    const afterAccountDeletion = await db.select()
      .from(personalProviderCredentials)
      .where(eq(personalProviderCredentials.userId, ownerId));
    expect(afterAccountDeletion).toEqual([]);
  });
});
