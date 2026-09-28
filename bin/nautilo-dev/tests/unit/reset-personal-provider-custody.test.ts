import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as config from "@nautilo/config";
import * as configGuard from "@nautilo/config-guard";
import * as credentialDb from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import * as operatorSecrets from "@nautilo/operator-secrets";
import { resetPersonalProviderCustody } from "../../src/commands/reset-personal-provider-custody";

const INSTANCE_ID = "provider-custody-reset-test";
const SERVER_INSTANCE_ID = "10000000-0000-4000-8000-000000000001";
const LOST_KEY_ID = "20000000-0000-4000-8000-000000000002";
const NEW_KEY_ID = "30000000-0000-4000-8000-000000000003";
const RAW_KEY = "ab".repeat(32);
const restoreSpies: Array<() => void> = [];

beforeAll(() => {
  bootstrapTestDbInstance();
});

function trackSpy<T extends { mockRestore(): void }>(spy: T): T {
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

afterEach(() => {
  for (const restore of restoreSpies.splice(0).reverse()) restore();
});

function fakeDb(identity: {
  instanceId: string;
  serverInstanceId: string;
} | null = {
  instanceId: INSTANCE_ID,
  serverInstanceId: SERVER_INSTANCE_ID,
}) {
  const end = mock(async () => undefined);
  const where = mock(async () => identity === null ? [] : [identity]);
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  return {
    db: { select, end } as unknown as ReturnType<typeof credentialDb.createDirectDb>,
    end,
    where,
  };
}

function captureOutput(): {
  errors: string[];
  logs: string[];
} {
  const errors: string[] = [];
  const logs: string[] = [];
  trackSpy(spyOn(console, "error").mockImplementation((...values) => {
    errors.push(values.map(String).join(" "));
  }));
  trackSpy(spyOn(console, "log").mockImplementation((...values) => {
    logs.push(values.map(String).join(" "));
  }));
  return { errors, logs };
}

function installCommonMocks(db = fakeDb()) {
  trackSpy(spyOn(config, "isCloudMode").mockReturnValue(false));
  trackSpy(spyOn(config, "resolveInstance").mockReturnValue({
    instanceId: INSTANCE_ID,
  } as ReturnType<typeof config.resolveInstance>));
  trackSpy(spyOn(configGuard, "resolveDotenvPath").mockReturnValue(
    "/synthetic/instance/instance.env",
  ));
  const createDb = trackSpy(
    spyOn(credentialDb, "createDirectDb").mockReturnValue(db.db),
  );
  const policy = trackSpy(
    spyOn(credentialDb, "getServerProviderPolicy").mockResolvedValue({
      allowPersonalProviderKeys: false,
    } as Awaited<ReturnType<typeof credentialDb.getServerProviderPolicy>>),
  );
  const evidence = trackSpy(
    spyOn(
      credentialDb,
      "getPersonalProviderCredentialCustodyEvidence",
    ).mockResolvedValue({ recordCount: 1, keyIds: [LOST_KEY_ID] }),
  );
  const reset = trackSpy(
    spyOn(operatorSecrets, "resetPersonalProviderCustodyFile")
      .mockResolvedValue({
        formatVersion: 1,
        keyId: NEW_KEY_ID,
        keyHex: RAW_KEY,
      }),
  );
  return { ...db, createDb, policy, evidence, reset };
}

const validOptions = {
  lostKeyId: LOST_KEY_ID,
  confirmServer: SERVER_INSTANCE_ID,
  confirmReset: true,
};

describe("personal provider custody reset command", () => {
  test.each([
    [{ ...validOptions, lostKeyId: undefined }, "--lost-key-id"],
    [{ ...validOptions, confirmServer: undefined }, "--confirm-server"],
    [{ ...validOptions, confirmReset: false }, "--confirm-reset"],
  ] as const)("rejects a missing required flag before opening the database", async (options, expectedFlag) => {
    const output = captureOutput();
    trackSpy(spyOn(config, "isCloudMode").mockReturnValue(false));
    const createDb = trackSpy(spyOn(credentialDb, "createDirectDb"));

    expect(await resetPersonalProviderCustody(options)).toBe(2);
    expect(createDb).not.toHaveBeenCalled();
    expect(output.errors.join("\n")).toContain(expectedFlag);
  });

  test.each([
    ["wrong server", { serverInstanceId: "40000000-0000-4000-8000-000000000004", instanceId: INSTANCE_ID }],
    ["wrong instance", { serverInstanceId: SERVER_INSTANCE_ID, instanceId: "other-instance" }],
  ])("rejects a %s identity and closes the database handle", async (_label, identity) => {
    const output = captureOutput();
    const harness = installCommonMocks(fakeDb(identity));

    expect(await resetPersonalProviderCustody(validOptions)).toBe(1);
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.end).toHaveBeenCalledTimes(1);
    expect(output.errors).toEqual([
      "Personal provider credentials unavailable: custody_unavailable",
    ]);
  });

  test("requires the provider-key policy to be disabled and closes the handle", async () => {
    const output = captureOutput();
    const harness = installCommonMocks();
    harness.policy.mockResolvedValue({ allowPersonalProviderKeys: true });

    expect(await resetPersonalProviderCustody(validOptions)).toBe(2);
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.end).toHaveBeenCalledTimes(1);
    expect(output.errors).toEqual([
      "Turn personal provider keys off and quiesce personal work before reset.",
    ]);
  });

  test("redacts database failures and closes an opened handle", async () => {
    const privateDatabaseDetail = "postgres password=database-secret";
    const output = captureOutput();
    const harness = installCommonMocks();
    harness.where.mockRejectedValue(new Error(privateDatabaseDetail));

    expect(await resetPersonalProviderCustody(validOptions)).toBe(1);
    expect(harness.reset).not.toHaveBeenCalled();
    expect(harness.end).toHaveBeenCalledTimes(1);
    const rendered = [...output.errors, ...output.logs].join("\n");
    expect(rendered).toBe(
      "Personal provider custody reset failed; persisted state must be inspected before retry.",
    );
    expect(rendered).not.toContain(privateDatabaseDetail);
  });

  test("resets only the confirmed lost key, reports safe evidence, and closes the handle", async () => {
    const output = captureOutput();
    const harness = installCommonMocks();
    harness.reset.mockImplementation(async (options) => {
      expect(options.instanceRootDir).toBe("/synthetic/instance");
      expect(options.lostKeyId).toBe(LOST_KEY_ID);
      expect(options.confirmReset).toBe(true);
      expect(await options.hasLostKeyRecords(LOST_KEY_ID)).toBe(true);
      return { formatVersion: 1, keyId: NEW_KEY_ID, keyHex: RAW_KEY };
    });

    expect(await resetPersonalProviderCustody(validOptions)).toBe(0);
    expect(harness.evidence).toHaveBeenCalledTimes(1);
    expect(harness.end).toHaveBeenCalledTimes(1);
    expect(output.errors).toEqual([]);
    expect(output.logs).toEqual([
      JSON.stringify({
        status: "custody-persisted",
        keyId: NEW_KEY_ID,
        oldRecords: "retained-unavailable",
      }),
    ]);
    const rendered = output.logs.join("\n");
    expect(rendered).not.toContain(RAW_KEY);
    expect(rendered).not.toContain("keyHex");
    expect(rendered).not.toContain(LOST_KEY_ID);
  });
});
