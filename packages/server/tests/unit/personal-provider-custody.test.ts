import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as credentialDb from "@nautilo/db";
import {
  PERSONAL_PROVIDER_CUSTODY_ENV,
  PersonalProviderCustodyError,
  captureInjectedPersonalProviderCustody,
  encryptPersonalProviderCredential,
  serializePersonalProviderCustody,
  type PersonalProviderCredentialContext,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import {
  bootstrapPersonalProviderCustody,
  inspectPersonalProviderCustody,
  isPersonalProviderCustodyConfigured,
  readPersonalProviderCustody,
  type PersonalProviderCustodyStatus,
} from "../../src/lib/personal-provider-custody";
import { assertPersonalProviderCustodyMaintenanceEvidence } from "../../src/lib/personal-provider-custody-maintenance";
import * as serverDirectDb from "../../src/lib/server-direct-db";

const CUSTODY: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "10000000-0000-4000-8000-000000000001",
  keyHex: "11".repeat(32),
};

test("cloud restore uses protected volume custody only when injection is absent", async () => {
  process.env["NAUTILO_HOSTING_MODE"] = "cloud";
  process.env["NAUTILO_DOTENV_PATH"] = await temporaryInstanceEnv(`NAUTILO_PERSONAL_PROVIDER_CUSTODY=${serializePersonalProviderCustody(CUSTODY)}\n`);
  captureInjectedPersonalProviderCustody(undefined);
  delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
  expect(await readPersonalProviderCustody()).toEqual(CUSTODY);
  captureInjectedPersonalProviderCustody("");
  expect(await readPersonalProviderCustody().catch(String)).toContain("custody_invalid");
});
test("mode presence checks selected file or captured cloud injection without exposing key material", async () => {
  process.env["NAUTILO_HOSTING_MODE"] = "local";
  process.env["NAUTILO_DOTENV_PATH"] = await temporaryInstanceEnv(`NAUTILO_PERSONAL_PROVIDER_CUSTODY=${serializePersonalProviderCustody(CUSTODY)}\n`);
  captureInjectedPersonalProviderCustody(undefined);
  delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
  expect(await isPersonalProviderCustodyConfigured()).toBe(true);
  process.env["NAUTILO_HOSTING_MODE"] = "cloud";
  process.env["NAUTILO_DOTENV_PATH"] = await temporaryInstanceEnv("");
  captureInjectedPersonalProviderCustody("");
  expect(await isPersonalProviderCustodyConfigured()).toBe(true);
  captureInjectedPersonalProviderCustody(undefined);
  expect(await isPersonalProviderCustodyConfigured()).toBe(false);
});
const AMBIENT_CUSTODY: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "20000000-0000-4000-8000-000000000002",
  keyHex: "22".repeat(32),
};
const OWNER_ID = "30000000-0000-4000-8000-000000000003";
const originalEnv = {
  custody: process.env[PERSONAL_PROVIDER_CUSTODY_ENV],
  dotenvPath: process.env["NAUTILO_DOTENV_PATH"],
  hostingMode: process.env["NAUTILO_HOSTING_MODE"],
};
const restoreSpies: Array<() => void> = [];
const temporaryRoots: string[] = [];

function trackSpy<T extends { mockRestore(): void }>(spy: T): T {
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

function restoreEnv(
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const restore of restoreSpies.splice(0).reverse()) restore();
  captureInjectedPersonalProviderCustody(undefined);
  restoreEnv(PERSONAL_PROVIDER_CUSTODY_ENV, originalEnv.custody);
  restoreEnv("NAUTILO_DOTENV_PATH", originalEnv.dotenvPath);
  restoreEnv("NAUTILO_HOSTING_MODE", originalEnv.hostingMode);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })),
  );
});

async function temporaryInstanceEnv(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nautilo-provider-custody-test-"));
  temporaryRoots.push(root);
  const path = join(root, "instance.env");
  await writeFile(path, contents, "utf8");
  return path;
}

function useCloudCustody(custody = CUSTODY): void {
  process.env["NAUTILO_HOSTING_MODE"] = "cloud";
  captureInjectedPersonalProviderCustody(serializePersonalProviderCustody(custody));
  delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
}

function fakeDirectDb(): ReturnType<typeof serverDirectDb.getServerDirectDb> {
  return {} as ReturnType<typeof serverDirectDb.getServerDirectDb>;
}

function installDirectDb(): void {
  const db = fakeDirectDb();
  trackSpy(spyOn(serverDirectDb, "getServerDirectDb").mockReturnValue(db));
}

function context(index: number): PersonalProviderCredentialContext & { provider: "openai" } {
  return {
    id: `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    userId: OWNER_ID,
    provider: "openai",
    revision: 1,
  };
}

function encryptedRow(index: number, plaintext = `provider-secret-${index}`) {
  const binding = context(index);
  return {
    ...binding,
    envelope: encryptPersonalProviderCredential(CUSTODY, plaintext, binding),
  };
}

function expectSafeStatus(
  status: PersonalProviderCustodyStatus,
  forbidden: readonly string[],
): void {
  const rendered = JSON.stringify(status);
  for (const value of forbidden) expect(rendered).not.toContain(value);
  expect(rendered).not.toContain("keyHex");
  expect(rendered).not.toContain("nonceBase64");
  expect(rendered).not.toContain("ciphertextBase64");
  expect(rendered).not.toContain("authTagBase64");
}

describe("personal provider custody server boundary", () => {
  test("source mode reads canonical instance custody instead of an ambient value", async () => {
    process.env["NAUTILO_HOSTING_MODE"] = "local";
    captureInjectedPersonalProviderCustody(serializePersonalProviderCustody(AMBIENT_CUSTODY));
    process.env["NAUTILO_DOTENV_PATH"] = await temporaryInstanceEnv(
      `${PERSONAL_PROVIDER_CUSTODY_ENV}='${serializePersonalProviderCustody(CUSTODY)}'\n`,
    );

    expect(await readPersonalProviderCustody()).toEqual(CUSTODY);
  });

  test("cloud mode reads the injected custody value", async () => {
    useCloudCustody(AMBIENT_CUSTODY);
    process.env["NAUTILO_DOTENV_PATH"] = "/must/not/be/read/instance.env";

    expect(await readPersonalProviderCustody()).toEqual(AMBIENT_CUSTODY);
  });

  test("a missing source key with stored records never provisions a replacement", async () => {
    process.env["NAUTILO_HOSTING_MODE"] = "local";
    delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
    const original = "# existing source instance without custody\n";
    const path = await temporaryInstanceEnv(original);
    process.env["NAUTILO_DOTENV_PATH"] = path;
    installDirectDb();
    trackSpy(
      spyOn(
        credentialDb,
        "getPersonalProviderCredentialCustodyEvidence",
      ).mockResolvedValue({
        recordCount: 1,
        keyIds: [CUSTODY.keyId],
      }),
    );

    let failure: unknown;
    try {
      await bootstrapPersonalProviderCustody();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PersonalProviderCustodyError);
    expect((failure as PersonalProviderCustodyError).code).toBe("custody_missing");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(process.env[PERSONAL_PROVIDER_CUSTODY_ENV]).toBeUndefined();
  });

  test("database-unavailable diagnostics preserve unknown record evidence", async () => {
    useCloudCustody();
    installDirectDb();
    trackSpy(
      spyOn(
        credentialDb,
        "getPersonalProviderCredentialCustodyEvidence",
      ).mockRejectedValue(new Error("database transport included private detail")),
    );

    const status = await inspectPersonalProviderCustody();
    expect(status).toEqual({
      status: "unavailable",
      recordsExist: null,
      code: "custody_unavailable",
    });
    expectSafeStatus(status, [
      CUSTODY.keyHex,
      "database transport included private detail",
    ]);
  });

  test("maintenance evidence accepts only an empty table or fully validated custody", async () => {
    process.env["NAUTILO_HOSTING_MODE"] = "cloud";
    delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
    installDirectDb();
    const evidence = trackSpy(spyOn(credentialDb, "getPersonalProviderCredentialCustodyEvidence"));
    const list = trackSpy(spyOn(credentialDb, "listPersonalProviderCredentialsForCustody"));

    evidence.mockResolvedValueOnce({ recordCount: 0, keyIds: [] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(assertPersonalProviderCustodyMaintenanceEvidence()).resolves.toBeUndefined();

    evidence.mockResolvedValueOnce({ recordCount: 1, keyIds: [CUSTODY.keyId] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(assertPersonalProviderCustodyMaintenanceEvidence()).rejects.toBeInstanceOf(PersonalProviderCustodyError);

    useCloudCustody();
    const row = encryptedRow(1);
    evidence.mockResolvedValueOnce({ recordCount: 1, keyIds: [CUSTODY.keyId] });
    list.mockResolvedValueOnce([row]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(assertPersonalProviderCustodyMaintenanceEvidence()).resolves.toBeUndefined();
  });

  test("explicit reset provenance permits maintenance while old rows remain blocked", async () => {
    useCloudCustody({ ...CUSTODY, resetFromKeyId: AMBIENT_CUSTODY.keyId });
    installDirectDb();
    trackSpy(spyOn(credentialDb, "getPersonalProviderCredentialCustodyEvidence").mockResolvedValue({
      recordCount: 2, keyIds: [AMBIENT_CUSTODY.keyId, CUSTODY.keyId],
    }));
    const old = context(1);
    trackSpy(spyOn(credentialDb, "listPersonalProviderCredentialsForCustody").mockResolvedValue([
      { ...old, envelope: encryptPersonalProviderCredential(AMBIENT_CUSTODY, "lost-old-secret", old) },
      encryptedRow(2),
    ]));

    expect(await inspectPersonalProviderCustody()).toEqual({
      status: "degraded", recordsExist: true, keyId: CUSTODY.keyId,
      code: "credential_reenrollment_required",
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(assertPersonalProviderCustodyMaintenanceEvidence()).resolves.toBeUndefined();
  });

  test("mismatched custody and corrupted envelopes fail closed", async () => {
    useCloudCustody();
    installDirectDb();
    const evidenceSpy = trackSpy(
      spyOn(
        credentialDb,
        "getPersonalProviderCredentialCustodyEvidence",
      ),
    );
    const listSpy = trackSpy(
      spyOn(credentialDb, "listPersonalProviderCredentialsForCustody"),
    );

    evidenceSpy.mockResolvedValueOnce({
      recordCount: 1,
      keyIds: [AMBIENT_CUSTODY.keyId],
    });
    const mismatch = await inspectPersonalProviderCustody();
    expect(mismatch).toEqual({
      status: "unavailable",
      recordsExist: true,
      keyId: CUSTODY.keyId,
      code: "custody_key_mismatch",
    });
    expect(listSpy).not.toHaveBeenCalled();
    expectSafeStatus(mismatch, [CUSTODY.keyHex, AMBIENT_CUSTODY.keyHex]);

    const row = encryptedRow(1, "corrupt-envelope-plaintext");
    const firstCiphertextCharacter = row.envelope.ciphertextBase64[0]!;
    const corrupt = {
      ...row,
      envelope: {
        ...row.envelope,
        ciphertextBase64:
          `${firstCiphertextCharacter === "A" ? "B" : "A"}${row.envelope.ciphertextBase64.slice(1)}`,
      },
    };
    evidenceSpy.mockResolvedValueOnce({
      recordCount: 1,
      keyIds: [CUSTODY.keyId],
    });
    listSpy.mockResolvedValueOnce([corrupt]);
    const corrupted = await inspectPersonalProviderCustody();
    expect(corrupted).toEqual({
      status: "unavailable",
      recordsExist: true,
      code: "credential_authentication_failed",
    });
    expectSafeStatus(corrupted, [
      CUSTODY.keyHex,
      "corrupt-envelope-plaintext",
      corrupt.envelope.ciphertextBase64,
    ]);
  });

  test("diagnostics decrypt every page beyond one hundred records without returning secrets", async () => {
    useCloudCustody();
    installDirectDb();
    const rows = Array.from({ length: 205 }, (_, index) =>
      encryptedRow(index + 1));
    trackSpy(
      spyOn(
        credentialDb,
        "getPersonalProviderCredentialCustodyEvidence",
      ).mockResolvedValue({
        recordCount: rows.length,
        keyIds: [CUSTODY.keyId],
      }),
    );
    const requestedPages: Array<{ afterId?: string; limit: number }> = [];
    trackSpy(
      spyOn(
        credentialDb,
        "listPersonalProviderCredentialsForCustody",
      ).mockImplementation(async (_db, input) => {
        requestedPages.push(input);
        const start = input.afterId === undefined
          ? 0
          : rows.findIndex((row) => row.id === input.afterId) + 1;
        return rows.slice(start, start + input.limit);
      }),
    );

    const status = await inspectPersonalProviderCustody();
    expect(status).toEqual({
      status: "ready",
      recordsExist: true,
      keyId: CUSTODY.keyId,
    });
    expect(requestedPages).toEqual([
      { limit: 100 },
      { limit: 100, afterId: rows[99]!.id },
      { limit: 100, afterId: rows[199]!.id },
    ]);
    expectSafeStatus(status, [
      CUSTODY.keyHex,
      "provider-secret-1",
      "provider-secret-205",
      rows[0]!.envelope.ciphertextBase64,
    ]);
  });
});
