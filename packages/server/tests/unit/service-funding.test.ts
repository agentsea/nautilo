import { describe, expect, test } from "bun:test";
import { createPersonalProviderCustody, decryptPersonalProviderCredential, encryptPersonalProviderCredential } from "@nautilo/operator-secrets";
import type { PersonalProviderCredentialRecord } from "@nautilo/db";
import type { PaidServiceProvider } from "@nautilo/types";
import {
  admitDurableServiceFunding,
  admitLegacyServerServiceFunding,
  openServiceFunding,
  resolveServiceFunding,
  runWithDurableServiceFunding,
  type ServiceFundingDeps,
} from "../../src/lib/service-funding";

const ALICE = "10000000-0000-4000-8000-000000000001";
const BOB = "20000000-0000-4000-8000-000000000002";
function harness() {
  const custody = createPersonalProviderCustody();
  const rows = new Map<string, PersonalProviderCredentialRecord>();
  const serverKeys = new Map<PaidServiceProvider, string>([
    ["tavily", "server-tavily-key"],
    ["browser-use", "server-browser-use-key"],
    ["cloudconvert", "server-cloudconvert-key"],
  ]);
  let enabled = true;
  let preference: "personal_first" | "server_first" = "personal_first";
  let caps = ["use_personal_provider_credentials", "use_server_provider_credentials"];
  const deps: ServiceFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: enabled, fundingPreference: preference }),
    getCapabilities: async () => caps,
    getCredential: async (human, provider) => rows.get(`${human}:${provider}`) ?? null,
    serverKey: (provider) => serverKeys.get(provider) ?? null,
    readCustody: async () => custody,
    decrypt: decryptPersonalProviderCredential,
  };
  function put(human = ALICE, revision = 1, provider: PaidServiceProvider = "tavily", apiKey = `personal-${human}-${provider}`) {
    const identity = { userId: human, provider, revision, id: human === ALICE ? "30000000-0000-4000-8000-000000000003" : "40000000-0000-4000-8000-000000000004" };
    rows.set(`${human}:${provider}`, { ...identity, envelope: encryptPersonalProviderCredential(custody, apiKey, identity),
      validationStatus: "unverified", validatedAt: null, destination: null, receiptReadStatus: "unknown", createdAt: new Date(), updatedAt: new Date() });
  }
  return { deps, rows, serverKeys, put, enable: (value: boolean) => { enabled = value; },
    priority: (value: typeof preference) => { preference = value; }, capabilities: (value: string[]) => { caps = value; } };
}

describe("independent paid service funding", () => {
  test("priorities apply to new operations while an accepted operation retains its payer", async () => {
    const h = harness(); h.put();
    const personal = await openServiceFunding(ALICE, "tavily", undefined, h.deps);
    h.priority("server_first");
    expect((await resolveServiceFunding(ALICE, "tavily", undefined, h.deps)).kind).toBe("server");
    expect(await personal.runAttempt(async ({ apiKey, usageFunding }) => ({ apiKey, usageFunding }))).toMatchObject({
      apiKey: `personal-${ALICE}-tavily`, usageFunding: { kind: "personal", payerHumanId: ALICE, credentialRevision: 1 },
    });
    const server = await openServiceFunding(ALICE, "tavily", undefined, h.deps);
    h.priority("personal_first");
    expect(await server.runAttempt(async ({ apiKey }) => apiKey)).toBe("server-tavily-key");
  });
  test("replacement, deletion, admin disable and capability revocation stop before the wire", async () => {
    for (const mutate of [
      (h: ReturnType<typeof harness>) => h.put(ALICE, 2),
      (h: ReturnType<typeof harness>) => h.rows.delete(`${ALICE}:tavily`),
      (h: ReturnType<typeof harness>) => h.enable(false),
      (h: ReturnType<typeof harness>) => h.capabilities(["use_server_provider_credentials"]),
    ]) {
      const h = harness(); h.put();
      const operation = await openServiceFunding(ALICE, "tavily", undefined, h.deps);
      mutate(h); let sent = false;
      expect(operation.runAttempt(async () => { sent = true; })).rejects.toThrow();
      expect(sent).toBe(false);
    }
  });
  test("other Humans cannot reopen the originating credential, even with overlapping permission", async () => {
    const h = harness(); h.put(); h.put(BOB);
    const accepted = await resolveServiceFunding(ALICE, "tavily", undefined, h.deps);
    expect(openServiceFunding(BOB, "tavily", accepted, h.deps)).rejects.toThrow("personal_credential_stale");
  });
  test("personal-only search never reads the server key", async () => {
    const h = harness(); h.put(); h.capabilities(["use_personal_provider_credentials"]);
    h.deps.serverKey = () => { throw new Error("server key must not be read"); };
    const accepted = await openServiceFunding(ALICE, "tavily", undefined, h.deps);
    expect(await accepted.runAttempt(async ({ usageFunding }) => usageFunding.kind)).toBe("personal");
    h.rows.clear();
    expect(openServiceFunding(ALICE, "tavily", undefined, h.deps)).rejects.toThrow("personal_credential_missing");
  });

  test("foreground admission supports every paid service provider", async () => {
    for (const provider of ["tavily", "browser-use", "cloudconvert"] as const) {
      const h = harness();
      h.put(ALICE, 1, provider);
      const operation = await openServiceFunding(ALICE, provider, undefined, h.deps);
      expect(operation.binding.providerRoute).toBe(provider);
      expect(await operation.runAttempt(async ({ apiKey }) => apiKey)).toBe(`personal-${ALICE}-${provider}`);
    }
  });
});

describe("durable paid service funding", () => {
  test("persists only non-secret creating-account facts and opens the key inside the callback", async () => {
    const h = harness();
    h.put(ALICE, 1, "browser-use", "bu_private_value");
    const admitted = await admitDurableServiceFunding(ALICE, "browser-use", undefined, h.deps);
    expect(admitted).toMatchObject({
      humanUserId: ALICE,
      provider: "browser-use",
      binding: { kind: "personal", providerRoute: "browser-use", credentialRevision: 1 },
    });
    expect(admitted.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(admitted)).not.toContain("bu_private_value");
    expect(await runWithDurableServiceFunding(admitted, "spend", async ({ apiKey, usageFunding }) => ({ apiKey, usageFunding }), h.deps)).toMatchObject({
      apiKey: "bu_private_value",
      usageFunding: { kind: "personal", humanUserId: ALICE, payerHumanId: ALICE, providerRoute: "browser-use" },
    });
  });

  test("recovery uses the exact creating key after spending authority is revoked", async () => {
    const h = harness();
    h.put(ALICE, 1, "cloudconvert");
    const admitted = await admitDurableServiceFunding(ALICE, "cloudconvert", undefined, h.deps);
    h.enable(false);
    h.capabilities([]);

    let spent = false;
    expect(runWithDurableServiceFunding(admitted, "spend", async () => { spent = true; }, h.deps)).rejects.toThrow("personal_credentials_disabled");
    expect(spent).toBe(false);
    expect(await runWithDurableServiceFunding(admitted, "recover", async ({ apiKey }) => apiKey, h.deps))
      .toBe(`personal-${ALICE}-cloudconvert`);
  });

  test("recovery never rebinds a replaced personal key to the available server payer", async () => {
    const h = harness();
    h.put(ALICE, 1, "cloudconvert", "creating-key");
    const admitted = await admitDurableServiceFunding(ALICE, "cloudconvert", undefined, h.deps);
    h.put(ALICE, 2, "cloudconvert", "replacement-key");
    h.priority("server_first");

    let called = false;
    expect(runWithDurableServiceFunding(admitted, "recover", async () => { called = true; }, h.deps)).rejects.toThrow("personal_credential_stale");
    expect(called).toBe(false);
  });

  test("recovery rejects a raw personal key change even when id and revision are unchanged", async () => {
    const h = harness();
    h.put(ALICE, 1, "cloudconvert", "creating-key");
    const admitted = await admitDurableServiceFunding(ALICE, "cloudconvert", undefined, h.deps);
    h.put(ALICE, 1, "cloudconvert", "changed-key-same-revision");

    let called = false;
    expect(runWithDurableServiceFunding(admitted, "recover", async () => { called = true; }, h.deps))
      .rejects.toThrow("personal_credential_stale");
    expect(called).toBe(false);
  });

  test("server recovery rejects key rotation and does not fall back to a personal key", async () => {
    const h = harness();
    h.priority("server_first");
    h.put(ALICE, 1, "browser-use", "personal-fallback");
    const admitted = await admitDurableServiceFunding(ALICE, "browser-use", undefined, h.deps);
    h.serverKeys.set("browser-use", "rotated-server-key");

    expect(runWithDurableServiceFunding(admitted, "recover", async ({ apiKey }) => apiKey, h.deps))
      .rejects.toThrow("funding_source_changed");
  });

  test("legacy server resource recovery survives revoked spend permission without personal fallback", async () => {
    const h = harness();
    h.put(ALICE, 1, "browser-use", "personal-key");
    h.capabilities(["use_personal_provider_credentials"]);

    const adopted = await admitLegacyServerServiceFunding(ALICE, "browser-use", h.deps);
    expect(adopted.binding).toEqual({ kind: "server", providerRoute: "browser-use" });
    expect(await runWithDurableServiceFunding(adopted, "recover", async ({ apiKey }) => apiKey, h.deps))
      .toBe("server-browser-use-key");
    expect(runWithDurableServiceFunding(adopted, "spend", async ({ apiKey }) => apiKey, h.deps))
      .rejects.toThrow("server_credentials_forbidden");
  });

  test("a prior durable binding cannot cross Human or provider boundaries", async () => {
    const h = harness();
    h.put(ALICE, 1, "browser-use");
    h.put(BOB, 1, "browser-use");
    const admitted = await admitDurableServiceFunding(ALICE, "browser-use", undefined, h.deps);

    expect(admitDurableServiceFunding(BOB, "browser-use", admitted, h.deps)).rejects.toThrow("funding_source_changed");
    expect(admitDurableServiceFunding(ALICE, "cloudconvert", admitted, h.deps)).rejects.toThrow("funding_source_changed");
  });
});
