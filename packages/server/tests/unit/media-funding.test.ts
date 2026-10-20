import { describe, expect, test } from "bun:test";
import type { PersonalProviderCredentialRecord, PersonalProviderId } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import type { PaidServiceProvider } from "@nautilo/types";
import { openMediaFunding, type MediaFundingDependencies } from "../../src/lib/media-funding";
import { resolveSurplusPersonalDirectRecovery } from "../../src/lib/surplus-personal-recovery";
import { resolveModelFunding, type ModelFundingDeps } from "../../src/lib/model-funding";
import { bindAdmittedServiceFunding, runWithDurableServiceFunding, type ServiceFundingDeps } from "../../src/lib/service-funding";

const HUMAN = "10000000-0000-4000-8000-000000000001";
const MODEL = "venice:gpt-image-2";

function harness(kind: "personal" | "server") {
  const custody = createPersonalProviderCustody();
  const rows = new Map<PersonalProviderId, PersonalProviderCredentialRecord>();
  const serverKeys = new Map<PaidServiceProvider, string>([["surplus", "server-surplus"], ["venice", "server-venice"]]);
  let allowed = true;
  for (const [provider, id] of [["surplus", "20000000-0000-4000-8000-000000000002"], ["venice", "30000000-0000-4000-8000-000000000003"]] as const) {
    const identity = { userId: HUMAN, provider, id, revision: 1 };
    rows.set(provider, { ...identity, envelope: encryptPersonalProviderCredential(custody, `personal-${provider}`, identity),
      validationStatus: "unverified", validatedAt: null, destination: null, receiptReadStatus: "unknown", createdAt: new Date(0), updatedAt: new Date(0) });
  }
  const serviceDeps: ServiceFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: allowed, fundingPreference: kind === "server" ? "server_first" : "personal_first" }),
    getCapabilities: async () => ["use_server_provider_credentials", "use_personal_provider_credentials"],
    getCredential: async (human, provider) => human === HUMAN ? rows.get(provider) ?? null : null,
    serverKey: (provider) => serverKeys.get(provider) ?? null,
    readCustody: async () => custody,
    decrypt: decryptPersonalProviderCredential,
  };
  const modelDeps: ModelFundingDeps = {
    ...serviceDeps,
    getCredential: async (human, provider) => human === HUMAN ? rows.get(provider) ?? null : null,
    serverRoute: (_model, _workload, transport) => transport === "direct"
      ? serverKeys.has("venice") ? "venice" : null
      : serverKeys.has("surplus") ? "surplus" : serverKeys.has("venice") ? "venice" : null,
    personalSurplusRoute: () => true,
  };
  const lookups: string[] = [];
  let found = true;
  let afterLookup = () => {};
  const dependencies: MediaFundingDependencies = {
    resolveFunding: (input) => resolveModelFunding(input, modelDeps),
    bindFunding: (human, provider, binding) => bindAdmittedServiceFunding(human, provider, binding, serviceDeps),
    runFunding: (binding, intent, run) => runWithDurableServiceFunding(binding, intent, run, serviceDeps),
    resolvePersonalRecovery: (input) => resolveSurplusPersonalDirectRecovery(input, modelDeps),
    findModel: async (input) => { lookups.push(input.apiKey); afterLookup(); return found; },
  };
  return { dependencies, rows, serverKeys, lookups,
    setFound: (value: boolean) => { found = value; },
    afterLookup: (run: () => void) => { afterLookup = run; },
    disable: () => { allowed = false; } };
}

describe("exact media marketplace funding", () => {
  for (const kind of ["personal", "server"] as const) {
    test(`${kind} exact match uses only the admitted Surplus account`, async () => {
      const h = harness(kind);
      const admitted = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
      expect(admitted.modelId).toBe(MODEL);
      expect(admitted.funding.provider).toBe("surplus");
      expect(admitted.funding.binding.kind).toBe(kind);
      expect(h.lookups).toEqual([`${kind}-surplus`]);
      expect(await admitted.runAttempt(async ({ apiKey }) => apiKey)).toBe(`${kind}-surplus`);
    });

    test(`${kind} absent exact model falls back to the same model and payer before spending`, async () => {
      const h = harness(kind); h.setFound(false);
      const admitted = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
      expect(admitted.modelId).toBe(MODEL);
      expect(admitted.funding.provider).toBe("venice");
      expect(admitted.funding.binding.kind).toBe(kind);
      expect(await admitted.runAttempt(async ({ apiKey }) => apiKey)).toBe(`${kind}-venice`);
    });

    test(`${kind} direct-only contract skips marketplace discovery`, async () => {
      const h = harness(kind);
      const admitted = await openMediaFunding(HUMAN, MODEL, "image", { directOnly: true }, undefined, h.dependencies);
      expect(admitted.funding.provider).toBe("venice");
      expect(h.lookups).toEqual([]);
    });
  }

  test("missing personal direct key cannot borrow an available server key", async () => {
    const h = harness("personal"); h.setFound(false); h.rows.delete("venice");
    expect(openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies)).rejects.toThrow("no direct-provider credential");
    expect(h.lookups).toEqual(["personal-surplus"]);
  });

  test("lookup cannot hide credential replacement or policy revocation before fallback", async () => {
    for (const mutation of [
      (h: ReturnType<typeof harness>) => h.rows.delete("surplus"),
      (h: ReturnType<typeof harness>) => h.disable(),
    ]) {
      const h = harness("personal"); h.setFound(false); h.afterLookup(() => mutation(h));
      expect(openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies)).rejects.toThrow();
    }
  });

  test("explicit safe fallback retains the admitted Human and payer class", async () => {
    const h = harness("personal");
    const first = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
    const direct = await openMediaFunding(HUMAN, MODEL, "image", {
      prior: first.funding, transport: "direct", directOnly: true,
    }, undefined, h.dependencies);
    expect(direct.funding.provider).toBe("venice");
    expect(direct.funding.binding.kind).toBe("personal");
    expect(h.lookups).toHaveLength(1);
    expect(openMediaFunding("40000000-0000-4000-8000-000000000004", MODEL, "image", {
      prior: first.funding, transport: "direct",
    }, undefined, h.dependencies)).rejects.toThrow("funding_source_changed");
  });

  test("missing server direct uses the same model's personal key before a media reservation", async () => {
    const h = harness("server"); h.setFound(false); h.serverKeys.delete("venice");
    const admitted = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
    expect(admitted.modelId).toBe(MODEL);
    expect(admitted.funding.binding).toMatchObject({ kind: "personal", providerRoute: "venice", credentialRevision: 1 });
    expect(h.lookups).toEqual(["server-surplus"]);
    expect(await admitted.runAttempt(async ({ apiKey }) => apiKey)).toBe("personal-venice");
  });

  test("a server Surplus key remains sufficient when the exact media route is found", async () => {
    const h = harness("server"); h.serverKeys.delete("venice"); h.rows.clear();
    const admitted = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
    expect(admitted.funding.binding.kind).toBe("server");
    expect(await admitted.runAttempt(async ({ apiKey }) => apiKey)).toBe("server-surplus");
  });

  test("safe image refusal may bind personal direct when server direct is absent", async () => {
    const h = harness("server"); h.serverKeys.delete("venice");
    const first = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
    const direct = await openMediaFunding(HUMAN, MODEL, "image", {
      prior: first.funding, transport: "direct", directOnly: true,
    }, undefined, h.dependencies);
    expect(first.funding.binding.kind).toBe("server");
    expect(direct.funding.binding.kind).toBe("personal");
    expect(await direct.runAttempt(async ({ apiKey }) => apiKey)).toBe("personal-venice");
  });

  test("no personal key or disabled personal policy leaves Surplus-only media failure explicit", async () => {
    for (const disabled of [false, true]) {
      const h = harness("server"); h.setFound(false); h.serverKeys.delete("venice");
      if (disabled) h.disable(); else h.rows.delete("venice");
      expect(openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies)).rejects.toThrow(
        disabled ? "personal_credentials_disabled" : "personal_credential_missing",
      );
    }
  });

  test("a replaced creating server key cannot be hidden by direct fallback", async () => {
    const h = harness("server");
    const first = await openMediaFunding(HUMAN, MODEL, "image", undefined, undefined, h.dependencies);
    h.serverKeys.set("surplus", "replacement-server-key");
    expect(openMediaFunding(HUMAN, MODEL, "image", {
      prior: first.funding, transport: "direct", directOnly: true,
    }, undefined, h.dependencies)).rejects.toThrow("funding_source_changed");
  });
});
