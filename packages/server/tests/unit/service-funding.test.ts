import { describe, expect, test } from "bun:test";
import { createPersonalProviderCustody, decryptPersonalProviderCredential, encryptPersonalProviderCredential } from "@nautilo/operator-secrets";
import type { PersonalProviderCredentialRecord } from "@nautilo/db";
import { openServiceFunding, resolveServiceFunding, type ServiceFundingDeps } from "../../src/lib/service-funding";

const ALICE = "10000000-0000-4000-8000-000000000001";
const BOB = "20000000-0000-4000-8000-000000000002";
function harness() {
  const custody = createPersonalProviderCustody();
  const rows = new Map<string, PersonalProviderCredentialRecord>();
  let enabled = true;
  let preference: "personal_first" | "server_first" = "personal_first";
  let caps = ["use_personal_provider_credentials", "use_server_provider_credentials"];
  const deps: ServiceFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: enabled, fundingPreference: preference }),
    getCapabilities: async () => caps,
    getCredential: async (human) => rows.get(human) ?? null,
    serverKey: () => "server-test-key",
    readCustody: async () => custody,
    decrypt: decryptPersonalProviderCredential,
  };
  function put(human = ALICE, revision = 1) {
    const identity = { userId: human, provider: "tavily" as const, revision, id: human === ALICE ? "30000000-0000-4000-8000-000000000003" : "40000000-0000-4000-8000-000000000004" };
    rows.set(human, { ...identity, envelope: encryptPersonalProviderCredential(custody, `personal-${human}`, identity),
      validationStatus: "unverified", validatedAt: null, destination: null, receiptReadStatus: "unknown", createdAt: new Date(), updatedAt: new Date() });
  }
  return { deps, rows, put, enable: (value: boolean) => { enabled = value; },
    priority: (value: typeof preference) => { preference = value; }, capabilities: (value: string[]) => { caps = value; } };
}

describe("independent paid service funding", () => {
  test("priorities apply to new operations while an accepted operation retains its payer", async () => {
    const h = harness(); h.put();
    const personal = await openServiceFunding(ALICE, "tavily", undefined, h.deps);
    h.priority("server_first");
    expect((await resolveServiceFunding(ALICE, "tavily", undefined, h.deps)).kind).toBe("server");
    expect(await personal.runAttempt(async ({ apiKey, usageFunding }) => ({ apiKey, usageFunding }))).toMatchObject({
      apiKey: `personal-${ALICE}`, usageFunding: { kind: "personal", payerHumanId: ALICE, credentialRevision: 1 },
    });
    const server = await openServiceFunding(ALICE, "tavily", undefined, h.deps);
    h.priority("personal_first");
    expect(await server.runAttempt(async ({ apiKey }) => apiKey)).toBe("server-test-key");
  });
  test("replacement, deletion, admin disable and capability revocation stop before the wire", async () => {
    for (const mutate of [
      (h: ReturnType<typeof harness>) => h.put(ALICE, 2),
      (h: ReturnType<typeof harness>) => h.rows.delete(ALICE),
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
});
