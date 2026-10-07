import { describe, expect, test } from "bun:test";
import {
  PERSONAL_PROVIDER_IDS,
  PERSONAL_PROVIDER_CREDENTIAL_VALIDATION_STATUSES,
  PERSONAL_PROVIDER_CREDENTIAL_RECEIPT_READ_STATUSES,
  SENSITIVE_TABLES,
  clearPersonalProviderCredentialsForClone,
  createPersonalProviderCredentialIdentity,
  listPersonalProviderCredentialsForCustody,
} from "../../src";

type CloneClearDb = Parameters<typeof clearPersonalProviderCredentialsForClone>[0];

function cloneClearDb(
  identities: Array<{
    id: string;
    instanceId: string;
    serverInstanceId: string;
  }>,
  deletedIds: string[] = [],
): { db: CloneClearDb; deleteCalls: { value: number } } {
  const deleteCalls = { value: 0 };
  const tx = {
    select: () => ({
      from: () => ({
        for: () => Promise.resolve(identities),
      }),
    }),
    delete: () => {
      deleteCalls.value += 1;
      return Promise.resolve({ count: deletedIds.length });
    },
  };
  return {
    db: {
      transaction: (callback) => callback(tx as never),
    } as CloneClearDb,
    deleteCalls,
  };
}

describe("personal provider credential database contract", () => {
  test("uses the reviewed direct-provider allowlist and treats the table as sensitive", () => {
    expect(PERSONAL_PROVIDER_IDS).toEqual([
      "typesafe",
      "anthropic",
      "openai",
      "openrouter",
      "nautilo-gateway",
      "gateway",
      "google",
      "xai",
      "fireworks",
      "together",
      "venice",
      "elevenlabs",
      "groq",
      "tavily",
      "browser-use",
      "cloudconvert",
      "surplus",
    ]);
    expect(PERSONAL_PROVIDER_CREDENTIAL_VALIDATION_STATUSES).toEqual([
      "unverified",
      "accepted",
      "rejected",
      "unavailable",
    ]);
    expect(PERSONAL_PROVIDER_CREDENTIAL_RECEIPT_READ_STATUSES).toEqual([
      "available",
      "unavailable",
      "unknown",
    ]);
    expect(SENSITIVE_TABLES).toContain("personal_provider_credentials");
  });

  test("allocates a fresh UUID identity at initial revision", () => {
    const first = createPersonalProviderCredentialIdentity();
    const second = createPersonalProviderCredentialIdentity();
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.revision).toBe(1);
    expect(second.id).not.toBe(first.id);
  });

  test("rejects unbounded custody scans before touching the database", () => {
    const unreachableDb = {} as Parameters<
      typeof listPersonalProviderCredentialsForCustody
    >[0];
    expect(
      listPersonalProviderCredentialsForCustody(unreachableDb, { limit: 0 }),
    ).rejects.toThrow("positive safe integer");
    expect(
      listPersonalProviderCredentialsForCustody(unreachableDb, {
        limit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("positive safe integer");
  });

  test("clears copied rows only after both rebound clone identities match", async () => {
    const expected = {
      instanceId: "credential-custody-clone",
      serverInstanceId: "10000000-0000-4000-8000-000000000001",
    };
    const matching = cloneClearDb([
      { id: "self", ...expected },
    ], ["20000000-0000-4000-8000-000000000001"]);
    expect(
      await clearPersonalProviderCredentialsForClone(matching.db, expected),
    ).toEqual({ deletedCount: 1 });
    expect(matching.deleteCalls.value).toBe(1);

    for (const identities of [
      [],
      [{ id: "self", ...expected }, { id: "extra", ...expected }],
      [{ id: "self", ...expected, instanceId: "different-clone" }],
      [{
        id: "self",
        ...expected,
        serverInstanceId: "30000000-0000-4000-8000-000000000001",
      }],
    ]) {
      const mismatch = cloneClearDb(identities);
      const failure = await clearPersonalProviderCredentialsForClone(
        mismatch.db,
        expected,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "target database identity does not match",
      );
      expect(mismatch.deleteCalls.value).toBe(0);
    }
  });

  test("clone clearing rejects blank target identities before opening a transaction", () => {
    const unreachableDb = {} as CloneClearDb;
    expect(clearPersonalProviderCredentialsForClone(unreachableDb, {
      instanceId: "",
      serverInstanceId: "10000000-0000-4000-8000-000000000001",
    })).rejects.toThrow("both target identity values");
    expect(clearPersonalProviderCredentialsForClone(unreachableDb, {
      instanceId: "clone",
      serverInstanceId: " ",
    })).rejects.toThrow("both target identity values");
  });
});
