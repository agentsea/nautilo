import { describe, expect, test } from "bun:test";
import type { PersonalProviderCredentialRecord } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import { resolvePersonalSurplusReceiptCredential } from "../../src/lib/personal-provider-custody";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY = "personal-surplus-key-never-log";

function fixture(
  overrides: Partial<PersonalProviderCredentialRecord> = {},
) {
  const custody = createPersonalProviderCustody();
  const identity = {
    userId: USER_ID,
    provider: "surplus" as const,
    id: CREDENTIAL_ID,
    revision: 3,
  };
  const record: PersonalProviderCredentialRecord = {
    ...identity,
    destination: null,
    validationStatus: "accepted",
    validatedAt: new Date("2026-10-05T10:00:00.000Z"),
    receiptReadStatus: "available",
    envelope: encryptPersonalProviderCredential(custody, API_KEY, identity),
    createdAt: new Date("2026-10-05T09:00:00.000Z"),
    updatedAt: new Date("2026-10-05T10:00:00.000Z"),
    ...overrides,
  };
  return { custody, record };
}

describe("personal Surplus receipt credential resolution", () => {
  test("returns only the exact creating credential regardless of later policy state", async () => {
    const { custody, record } = fixture({
      validationStatus: "unavailable",
      receiptReadStatus: "unknown",
    });
    const result = await resolvePersonalSurplusReceiptCredential({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      credentialRevision: 3,
    }, {
      getDb: () => ({}) as never,
      getCredential: async () => record,
      readCustody: async () => custody,
    });
    expect(result).toEqual({
      status: "available",
      apiKey: API_KEY,
      receiptReadStatus: "unknown",
    });
  });

  test("does not substitute a missing or replaced credential", async () => {
    const { custody, record } = fixture();
    const common = {
      getDb: () => ({}) as never,
      readCustody: async () => custody,
    };
    expect(await resolvePersonalSurplusReceiptCredential({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      credentialRevision: 3,
    }, { ...common, getCredential: async () => null })).toEqual({
      status: "blocked_repair",
      reason: "missing",
    });
    expect(await resolvePersonalSurplusReceiptCredential({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      credentialRevision: 2,
    }, { ...common, getCredential: async () => record })).toEqual({
      status: "blocked_repair",
      reason: "replaced",
    });
  });

  test("reduces custody failures to content-free repair state", async () => {
    const { record } = fixture();
    const result = await resolvePersonalSurplusReceiptCredential({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      credentialRevision: 3,
    }, {
      getDb: () => ({}) as never,
      getCredential: async () => record,
      readCustody: async () => {
        throw new Error(`upstream echoed ${API_KEY}`);
      },
    });
    expect(result).toEqual({
      status: "blocked_repair",
      reason: "custody_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  test("leaves transient credential lookup failures retryable by the caller", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun settles the rejection matcher before this test completes.
    await expect(resolvePersonalSurplusReceiptCredential({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      credentialRevision: 3,
    }, {
      getDb: () => ({}) as never,
      getCredential: async () => {
        throw new Error("temporary database transport failure");
      },
    })).rejects.toThrow("temporary database transport failure");
  });
});
