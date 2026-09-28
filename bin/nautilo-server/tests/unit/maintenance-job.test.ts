import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERSONAL_PROVIDER_CUSTODY_ENV,
  captureInjectedPersonalProviderCustody,
  serializePersonalProviderCustody,
} from "@nautilo/operator-secrets";
import {
  captureMaintenancePersonalProviderCustody,
  parseMaintenanceJobArgs,
} from "../../src/maintenance-job";
import { readPersonalProviderCustody } from "../../../../packages/server/src/lib/personal-provider-custody";

const originalEnv = {
  custody: process.env[PERSONAL_PROVIDER_CUSTODY_ENV],
  dotenvPath: process.env["NAUTILO_DOTENV_PATH"],
  hostingMode: process.env["NAUTILO_HOSTING_MODE"],
};
const temporaryRoots: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  captureInjectedPersonalProviderCustody(undefined);
  restoreEnv(PERSONAL_PROVIDER_CUSTODY_ENV, originalEnv.custody);
  restoreEnv("NAUTILO_DOTENV_PATH", originalEnv.dotenvPath);
  restoreEnv("NAUTILO_HOSTING_MODE", originalEnv.hostingMode);
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("maintenance job argv", () => {
  test("captures injected custody before stripping ambient subprocess state", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-maintenance-custody-test-"));
    temporaryRoots.push(root);
    const fileCustody = serializePersonalProviderCustody({
      formatVersion: 1,
      keyId: "10000000-0000-4000-8000-000000000001",
      keyHex: "11".repeat(32),
    });
    const injectedCustody = serializePersonalProviderCustody({
      formatVersion: 1,
      keyId: "20000000-0000-4000-8000-000000000002",
      keyHex: "22".repeat(32),
    });
    const dotenvPath = join(root, "instance.env");
    await writeFile(dotenvPath, `${PERSONAL_PROVIDER_CUSTODY_ENV}='${fileCustody}'\n`, "utf8");
    process.env["NAUTILO_HOSTING_MODE"] = "cloud";
    process.env["NAUTILO_DOTENV_PATH"] = dotenvPath;
    process.env[PERSONAL_PROVIDER_CUSTODY_ENV] = fileCustody;

    const captured = captureMaintenancePersonalProviderCustody({
      ...process.env,
      [PERSONAL_PROVIDER_CUSTODY_ENV]: injectedCustody,
    });

    expect(captured[PERSONAL_PROVIDER_CUSTODY_ENV]).toBe(injectedCustody);
    expect(process.env[PERSONAL_PROVIDER_CUSTODY_ENV]).toBeUndefined();
    expect(await readPersonalProviderCustody()).toMatchObject({
      keyId: "20000000-0000-4000-8000-000000000002",
      keyHex: "22".repeat(32),
    });
  });

  test("accepts only direction and two opaque identifiers", () => {
    expect(parseMaintenanceJobArgs(["bun", "maintenance-job.ts", "export", "op-1", "object_2"])).toEqual({
      direction: "export", operationId: "op-1", objectId: "object_2", personalProviderCustodyEvidence: false,
    });
    expect(parseMaintenanceJobArgs(["bun", "maintenance-job.ts", "migrate", "schema-v2", "execution-2"])).toEqual({
      direction: "migrate", migrationId: "schema-v2", executionId: "execution-2", personalProviderCustodyEvidence: false,
    });
    expect(parseMaintenanceJobArgs(["bun", "maintenance-job.ts", "migrate-custody-v1", "schema-v2", "execution-2"])).toEqual({
      direction: "migrate", migrationId: "schema-v2", executionId: "execution-2", personalProviderCustodyEvidence: true,
    });
    expect(parseMaintenanceJobArgs(["bun", "maintenance-job.ts", "restore-custody-v1", "op-1", "object_2"])).toEqual({
      direction: "restore", operationId: "op-1", objectId: "object_2", personalProviderCustodyEvidence: true,
    });
  });

  test("rejects extra args, traversal, and secrets with exit-2 class input failures", () => {
    for (const args of [
      ["bun", "job", "export", "op", "object", "extra"],
      ["bun", "job", "restore", "..", "object"],
      ["bun", "job", "export", "op", "postgres://secret@host/db"],
      ["bun", "job", "migrate", "schema", "execution", "secret"],
      ["bun", "job", "migrate", ".", "execution"],
      ["bun", "job", "migrate", "..", "execution"],
      ["bun", "job", "migrate", "schema:unsafe", "execution"],
      ["bun", "job", "migrate", "schema", `e${"a".repeat(128)}`],
    ]) expect(() => parseMaintenanceJobArgs(args)).toThrow("invalid maintenance job arguments");
  });

  test("accepts the exact 128-byte identifier boundary", () => {
    const identifier = `i${"a".repeat(127)}`;
    expect(parseMaintenanceJobArgs(["bun", "job", "migrate", identifier, identifier])).toEqual({
      direction: "migrate", migrationId: identifier, executionId: identifier, personalProviderCustodyEvidence: false,
    });
  });
});
