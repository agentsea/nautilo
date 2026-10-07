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
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";

import { ensureRestoredPersonalProviderCustodyMaintenanceEvidence } from "../../src/lib/personal-provider-custody-maintenance";
import { inspectPersonalProviderCustody } from "../../src/lib/personal-provider-custody";
import * as serverDirectDb from "../../src/lib/server-direct-db";

const RESTORED: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "10000000-0000-4000-8000-000000000001",
  keyHex: "11".repeat(32),
};
const INJECTED: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "20000000-0000-4000-8000-000000000002",
  keyHex: "22".repeat(32),
};
const roots: string[] = [];
const restores: Array<() => void> = [];
const original = {
  custody: process.env[PERSONAL_PROVIDER_CUSTODY_ENV],
  path: process.env["NAUTILO_DOTENV_PATH"],
  mode: process.env["NAUTILO_HOSTING_MODE"],
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  captureInjectedPersonalProviderCustody(undefined);
  restoreEnv(PERSONAL_PROVIDER_CUSTODY_ENV, original.custody);
  restoreEnv("NAUTILO_DOTENV_PATH", original.path);
  restoreEnv("NAUTILO_HOSTING_MODE", original.mode);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configureFile(custody?: PersonalProviderCustody): Promise<string> {
  captureInjectedPersonalProviderCustody(undefined);
  const root = await mkdtemp(join(tmpdir(), "nautilo-restored-custody-"));
  roots.push(root);
  const path = join(root, "instance.env");
  if (custody !== undefined) await writeFile(path, `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}\n`, "utf8");
  process.env["NAUTILO_HOSTING_MODE"] = "cloud";
  process.env["NAUTILO_DOTENV_PATH"] = path;
  return path;
}

function installDb(recordCount: number, keyId = RESTORED.keyId): void {
  const direct = spyOn(serverDirectDb, "getServerDirectDb").mockReturnValue({} as ReturnType<typeof serverDirectDb.getServerDirectDb>);
  const evidence = spyOn(credentialDb, "getPersonalProviderCredentialCustodyEvidence").mockResolvedValue({
    recordCount,
    keyIds: recordCount === 0 ? [] : [keyId],
  });
  const context = {
    id: "30000000-0000-4000-8000-000000000003",
    userId: "40000000-0000-4000-8000-000000000004",
    provider: "openai",
    revision: 1,
    destination: null,
  } as const;
  const rows = recordCount === 0 ? [] : [{
    ...context,
    envelope: encryptPersonalProviderCredential(RESTORED, "synthetic-provider-secret", context),
  }];
  const list = spyOn(credentialDb, "listPersonalProviderCredentialsForCustody").mockResolvedValue(rows);
  restores.push(() => list.mockRestore(), () => evidence.mockRestore(), () => direct.mockRestore());
}

describe("personal provider custody restore maintenance", () => {
  test("a present cloud injection remains authoritative over restored volume custody", async () => {
    await configureFile(RESTORED);
    captureInjectedPersonalProviderCustody(serializePersonalProviderCustody(INJECTED));
    installDb(1);

    expect(await inspectPersonalProviderCustody()).toEqual({
      status: "unavailable",
      recordsExist: true,
      keyId: INJECTED.keyId,
      code: "custody_key_mismatch",
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher must settle before this test completes.
    await expect(ensureRestoredPersonalProviderCustodyMaintenanceEvidence()).rejects.toBeInstanceOf(PersonalProviderCustodyError);
  });

  test("reuses restored custody and never overwrites or mints around populated rows", async () => {
    const path = await configureFile(RESTORED);
    delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
    installDb(1);
    const before = await readFile(path, "utf8");

    await ensureRestoredPersonalProviderCustodyMaintenanceEvidence();
    await ensureRestoredPersonalProviderCustodyMaintenanceEvidence();

    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("missing bundled custody with populated rows fails without creating a replacement", async () => {
    const path = await configureFile();
    delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
    installDb(1);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher must settle before checking the filesystem.
    await expect(ensureRestoredPersonalProviderCustodyMaintenanceEvidence()).rejects.toBeInstanceOf(PersonalProviderCustodyError);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher must settle before this test completes.
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an empty restored database provisions once and reuses the committed volume custody", async () => {
    const path = await configureFile();
    delete process.env[PERSONAL_PROVIDER_CUSTODY_ENV];
    installDb(0);

    await ensureRestoredPersonalProviderCustodyMaintenanceEvidence();
    const first = await readFile(path, "utf8");
    await ensureRestoredPersonalProviderCustodyMaintenanceEvidence();

    expect(await readFile(path, "utf8")).toBe(first);
    expect(first).toContain(`${PERSONAL_PROVIDER_CUSTODY_ENV}=`);
  });
});
