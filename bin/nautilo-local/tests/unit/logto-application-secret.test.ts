import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguredM2mSecret, readLogtoApplicationSecret } from "../../src/logto-application-secret";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const app = "application-fixture";
const secret = (value = "existing-value", expiresAt: number | null = null) => ({ applicationId: app, name: "fixture", value, expiresAt });

async function expectSelectionRefusal(result: Promise<string>): Promise<void> {
  await result.then(
    () => { throw Error("expected secret selection refusal"); },
    (error: unknown) => { expect(String(error)).toContain("could not be selected safely"); },
  );
}

describe("existing Logto application secret readback", () => {
  test("keeps a matching legacy credential without calling newer endpoints", async () => {
    const value = await readLogtoApplicationSecret({ applicationId: app, legacySecret: "legacy-value", preferredSecret: "legacy-value", readSecrets: () => { throw Error("must not fetch"); } });
    expect(value).toBe("legacy-value");
  });

  test("reads a unique active modern secret when the legacy field is omitted", async () => {
    let reads = 0;
    const value = await readLogtoApplicationSecret({ applicationId: app, readSecrets: async () => { reads++; return [secret()]; } });
    expect(value).toBe("existing-value");
    expect(reads).toBe(1);
  });

  test("preserves the configured active secret instead of selecting another credential", async () => {
    const value = await readLogtoApplicationSecret({ applicationId: app, legacySecret: "legacy-value", preferredSecret: "existing-value", readSecrets: async () => [secret("other-value"), secret()], now: 1000 });
    expect(value).toBe("existing-value");
  });

  test("ignores expired secrets but never silently replaces an expired configured credential", async () => {
    const rows = [secret("expired-value", 1000), secret("active-value", 1001)];
    expect(await readLogtoApplicationSecret({ applicationId: app, readSecrets: async () => rows, now: 1000 })).toBe("active-value");
    await expectSelectionRefusal(readLogtoApplicationSecret({ applicationId: app, preferredSecret: "expired-value", readSecrets: async () => rows, now: 1000 }));
  });

  test("retains an unlisted legacy credential only after its token grant succeeds", async () => {
    const checked: string[] = [];
    const value = await readLogtoApplicationSecret({ applicationId: app, preferredSecret: "legacy-value", readSecrets: async () => [secret("modern-value")], verifyPreferredSecret: async (candidate) => { checked.push(candidate); return true; } });
    expect(value).toBe("legacy-value");
    expect(checked).toEqual(["legacy-value"]);
  });

  test("refuses an unlisted configured credential when validation fails or throws", async () => {
    for (const verifyPreferredSecret of [async () => false, async () => { throw Error("private-response-canary"); }]) {
      await expectSelectionRefusal(readLogtoApplicationSecret({ applicationId: app, preferredSecret: "legacy-value", readSecrets: async () => [secret("modern-value")], verifyPreferredSecret }));
    }
  });

  test("does not use token validation to bypass an explicitly expired listed secret", async () => {
    let checks = 0;
    await expectSelectionRefusal(readLogtoApplicationSecret({ applicationId: app, preferredSecret: "expired-value", readSecrets: async () => [secret("expired-value", 999)], now: 1000, verifyPreferredSecret: async () => { checks++; return true; } }));
    expect(checks).toBe(0);
  });

  test.each([
    { rows: [] },
    { rows: [secret("first-value"), secret("second-value")] },
    { rows: [secret("expired-value", 999)] },
    { rows: [{ ...secret(), applicationId: "another-application" }] },
    { rows: [{ ...secret(), value: "" }] },
    { rows: [{ ...secret(), expiresAt: "never" }] },
    { rows: [{ ...secret(), expiresAt: Number.NaN }] },
    { rows: { secrets: [secret()] } },
  ])("fails closed on absent, ambiguous or malformed modern secrets (%j)", async ({ rows }) => {
    await expectSelectionRefusal(readLogtoApplicationSecret({ applicationId: app, readSecrets: async () => rows, now: 1000 }));
  });

  test("does not disclose secret values or provider error bodies", async () => {
    try {
      await readLogtoApplicationSecret({ applicationId: app, readSecrets: async () => { throw Error("private-value-canary"); } });
      throw Error("expected refusal");
    } catch (error) {
      expect(String(error)).toContain("could not be selected safely");
      expect(String(error)).not.toContain("private-value-canary");
    }
  });

  test("uses the last configured value only for the exact application identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "logto-secret-test-")); directories.push(directory);
    const path = join(directory, "instance.env");
    writeFileSync(path, `LOGTO_M2M_APP_ID=${app}\nLOGTO_M2M_APP_SECRET=old-value\nLOGTO_M2M_APP_SECRET="existing-value"\n`, { mode: 0o600 });
    expect(readConfiguredM2mSecret(path, app)).toBe("existing-value");
    expect(readConfiguredM2mSecret(path, "another-application")).toBeUndefined();
    expect(readConfiguredM2mSecret(join(directory, "absent.env"), app)).toBeUndefined();
  });
});
