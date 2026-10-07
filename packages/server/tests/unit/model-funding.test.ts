import { describe, expect, test } from "bun:test";
import type { PersonalProviderCredentialRecord, PersonalProviderId } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import {
  PersonalDirectFundingUnavailableError,
  PersonalModelFundingUnavailableError,
} from "@nautilo/agent";
import {
  ModelFundingError,
  resolveModelFunding,
  resolveServerFundingRoute,
  withAdmittedPersonalProviderKey,
  type ModelFundingDeps,
} from "../../src/lib/model-funding";

const ALICE = "10000000-0000-4000-8000-000000000001";
const BOB = "20000000-0000-4000-8000-000000000002";
const MODEL = "openrouter:example/model";
const custody = createPersonalProviderCustody();

function row(userId: string, provider: PersonalProviderId, revision = 1): PersonalProviderCredentialRecord {
  const id = userId === ALICE
    ? "30000000-0000-4000-8000-000000000003"
    : "40000000-0000-4000-8000-000000000004";
  return {
    id, userId, provider, revision,
    validationStatus: "rejected", validatedAt: null,
    destination: null, receiptReadStatus: "unknown",
    envelope: encryptPersonalProviderCredential(custody, `private-${userId}`, {
      id, userId, provider, revision,
    }),
    createdAt: new Date(0), updatedAt: new Date(0),
  };
}

function harness() {
  const rows = new Map<string, PersonalProviderCredentialRecord>();
  const capabilities = new Map<string, string[]>();
  const reads: string[] = [];
  let enabled = true;
  let fundingPreference: "personal_first" | "server_first" = "personal_first";
  let serverRoute: string | null = "openrouter";
  let surplusEligible = false;
  const deps: ModelFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: enabled, fundingPreference }),
    getCapabilities: async (userId) => capabilities.get(userId) ?? [],
    getCredential: async (userId, provider) => {
      reads.push(`${userId}:${provider}`);
      return rows.get(`${userId}:${provider}`) ?? null;
    },
    serverRoute: (modelId) => modelId.startsWith("gateway:") ? "gateway" : serverRoute,
    personalSurplusRoute: () => surplusEligible,
    readCustody: async () => custody,
    decrypt: decryptPersonalProviderCredential,
  };
  return {
    deps, rows, capabilities, reads,
    setSurplusEligible(value: boolean) { surplusEligible = value; },
    setEnabled(value: boolean) { enabled = value; },
    setFundingPreference(value: "personal_first" | "server_first") { fundingPreference = value; },
    setServerRoute(value: string | null) { serverRoute = value; },
  };
}

function request(humanUserId: string, modelId = MODEL) {
  return { humanUserId, modelId, workload: "foreground_text_chat" as const };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelFundingError) return error.code;
    throw error;
  }
  return undefined;
}

describe("trusted model funding", () => {
  test("server route admits only an exact qualified Surplus mapping when direct credentials are absent", () => {
    const route = {
      catalogModelId: "venice:openai-gpt-55",
      surplusModelId: "gpt-5.5",
      providerPin: "venice" as const,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 8_000,
    };
    const input = { env: {}, preferSurplus: true, surplusKeyConfigured: true, routes: [route] };
    expect(resolveServerFundingRoute(route.catalogModelId, input)).toBe("surplus");
    expect(resolveServerFundingRoute("openai:not-signed", input)).toBeNull();
    expect(resolveServerFundingRoute(route.catalogModelId, { ...input, preferSurplus: false })).toBeNull();
    expect(resolveServerFundingRoute(route.catalogModelId, { ...input, surplusKeyConfigured: false })).toBeNull();
  });

  test("Prefer Surplus wins an eligible server route even when direct credentials exist", () => {
    const route = {
      catalogModelId: "venice:openai-gpt-55",
      surplusModelId: "gpt-5.5",
      providerPin: "venice" as const,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 8_000,
    };
    const env = { VENICE_API_KEY: "direct" };
    expect(resolveServerFundingRoute(route.catalogModelId, {
      env, preferSurplus: true, surplusKeyConfigured: true, routes: [route],
    })).toBe("surplus");
    expect(resolveServerFundingRoute(route.catalogModelId, {
      env, preferSurplus: false, surplusKeyConfigured: true, routes: [route],
    })).toBe("venice");
  });

  test("native text Tasks admit independently and pin their own source", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const parent = await resolveModelFunding(request(ALICE), h.deps);
    expect(parent.kind).toBe("personal");
    h.setFundingPreference("server_first");
    const taskRequest = { ...request(ALICE), workload: "native_text_task" as const };
    const task = await resolveModelFunding(taskRequest, h.deps);
    expect(task.kind).toBe("server");
    h.setFundingPreference("personal_first");
    expect((await resolveModelFunding({ ...taskRequest, priorDecision: task }, h.deps)).kind).toBe("server");
    expect((await resolveModelFunding(taskRequest, h.deps)).kind).toBe("personal");
    expect(await code(resolveModelFunding({ ...taskRequest, priorDecision: parent }, h.deps))).toBe("funding_source_changed");
  });

  test("native personal Task fails closed on revision loss even if server is permitted", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const input = { ...request(ALICE), workload: "native_text_task" as const };
    const admitted = await resolveModelFunding(input, h.deps);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter", 2));
    let calls = 0;
    if (admitted.kind !== "personal") throw new Error("Expected personal admission");
    expect(await code(withAdmittedPersonalProviderKey(admitted, async () => { calls++; }, h.deps))).toBe("personal_credential_stale");
    expect(calls).toBe(0);
    h.setEnabled(false);
    expect(await code(resolveModelFunding({ ...input, priorDecision: admitted }, h.deps))).toBe("personal_credentials_disabled");
  });
  test("stored service keys do not expand personal chat execution", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
    for (const provider of ["typesafe", "nautilo-gateway", "elevenlabs", "groq", "tavily", "browser-use", "cloudconvert", "gateway"] as const) {
      h.rows.set(`${ALICE}:${provider}`, row(ALICE, provider));
      expect(await code(resolveModelFunding(request(ALICE, `${provider}:example`), h.deps)))
        .toBe("unsupported_provider");
    }
    expect(h.reads).toEqual([]);
  });

  test("off switch preserves server route without inspecting personal records", async () => {
    const h = harness();
    h.setEnabled(false);
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    expect(await resolveModelFunding(request(ALICE), h.deps)).toMatchObject({
      kind: "server", humanUserId: ALICE, providerRoute: "openrouter",
    });
    expect(h.reads).toEqual([]);
  });

  test("configured personal key wins even when validation observed rejection", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const decision = await resolveModelFunding(request(ALICE), h.deps);
    expect(decision).toMatchObject({
      kind: "personal", humanUserId: ALICE, payerHumanId: ALICE,
      providerRoute: "openrouter", credentialRevision: 1,
    });
    if (decision.kind !== "personal") throw new Error("Expected personal funding");
    expect(await withAdmittedPersonalProviderKey(decision, async (key) => key, h.deps))
      .toBe(`private-${ALICE}`);
  });

  test("fresh overlap follows funding priority and server-first avoids personal lookup", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));

    expect(await resolveModelFunding(request(ALICE), h.deps)).toMatchObject({
      kind: "personal",
      providerRoute: "openrouter",
      credentialRevision: 1,
    });
    expect(h.reads).toEqual([`${ALICE}:openrouter`]);

    h.reads.length = 0;
    h.setFundingPreference("server_first");
    expect(await resolveModelFunding(request(ALICE), h.deps)).toMatchObject({
      kind: "server",
      providerRoute: "openrouter",
    });
    expect(h.reads).toEqual([]);
  });

  test.each(["personal_first", "server_first"] as const)(
    "%s treats Surplus as server funding while preserving personal lookup priority",
    async (preference) => {
      const h = harness();
      h.setFundingPreference(preference);
      h.setServerRoute("surplus");
      h.capabilities.set(ALICE, [
        "use_server_provider_credentials",
        "use_personal_provider_credentials",
      ]);

      expect(await resolveModelFunding(request(ALICE), h.deps)).toMatchObject({
        kind: "server",
        providerRoute: "surplus",
      });
      expect(h.reads).toEqual(preference === "personal_first" ? [`${ALICE}:openrouter`] : []);
    },
  );

  test.each(["personal_first", "server_first"] as const)(
    "%s keeps each sole funding source usable and denies a route with neither source",
    async (preference) => {
      const personalOnly = harness();
      personalOnly.setFundingPreference(preference);
      personalOnly.setServerRoute(null);
      personalOnly.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
      personalOnly.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
      expect((await resolveModelFunding(request(ALICE), personalOnly.deps)).kind).toBe("personal");

      const serverOnly = harness();
      serverOnly.setFundingPreference(preference);
      serverOnly.capabilities.set(ALICE, ["use_server_provider_credentials"]);
      expect((await resolveModelFunding(request(ALICE), serverOnly.deps)).kind).toBe("server");

      const neither = harness();
      neither.setFundingPreference(preference);
      neither.setServerRoute(null);
      neither.capabilities.set(ALICE, [
        "use_personal_provider_credentials",
        "use_server_provider_credentials",
      ]);
      expect(await code(resolveModelFunding(request(ALICE), neither.deps)))
        .toBe("provider_credentials_missing");
    },
  );

  test("fresh admissions observe policy changes while admitted sources remain pinned", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));

    const personal = await resolveModelFunding(request(ALICE), h.deps);
    expect(personal.kind).toBe("personal");
    h.setFundingPreference("server_first");
    expect((await resolveModelFunding(request(ALICE), h.deps)).kind).toBe("server");
    expect((await resolveModelFunding({ ...request(ALICE), priorDecision: personal }, h.deps)).kind)
      .toBe("personal");

    const server = await resolveModelFunding(request(ALICE), h.deps);
    expect(server.kind).toBe("server");
    h.setFundingPreference("personal_first");
    expect((await resolveModelFunding(request(ALICE), h.deps)).kind).toBe("personal");
    expect((await resolveModelFunding({ ...request(ALICE), priorDecision: server }, h.deps)).kind)
      .toBe("server");
  });

  test("server attempts preserve the admitted transport and expose only an explicit direct fallback", async () => {
    const h = harness();
    h.setFundingPreference("server_first");
    h.capabilities.set(ALICE, ["use_server_provider_credentials"]);
    let ordinaryRoute: string | null = "surplus";
    let surplusRoute: string | null = "surplus";
    let directRoute: string | null = "openrouter";
    const calls: Array<string | undefined> = [];
    const deps: ModelFundingDeps = {
      ...h.deps,
      serverRoute: (_modelId, _workload, transport) => {
        calls.push(transport);
        return transport === "surplus" ? surplusRoute
          : transport === "direct" ? directRoute : ordinaryRoute;
      },
    };

    const admitted = await resolveModelFunding(request(ALICE), deps);
    expect(admitted).toMatchObject({ kind: "server", providerRoute: "surplus" });

    // A global preference change does not move an admitted operation while
    // the pinned marketplace route remains available.
    ordinaryRoute = "openrouter";
    const retry = await resolveModelFunding({
      ...request(ALICE), priorDecision: admitted,
    }, deps);
    expect(retry).toMatchObject({ kind: "server", providerRoute: "surplus" });

    // Only a caller's definitive-refusal path may request the direct rail.
    const fallback = await resolveModelFunding({
      ...request(ALICE), priorDecision: admitted, transport: "direct",
    }, deps);
    expect(fallback).toMatchObject({ kind: "server", providerRoute: "openrouter" });
    expect(calls).toEqual([undefined, "surplus", "direct"]);

    directRoute = null;
    expect(await code(resolveModelFunding({
      ...request(ALICE), priorDecision: admitted, transport: "direct",
    }, deps))).toBe("provider_credentials_missing");
    surplusRoute = null;
    expect(await code(resolveModelFunding({
      ...request(ALICE), priorDecision: admitted,
    }, deps))).toBe("provider_credentials_missing");
  });

  test("a direct server binding cannot silently move onto Surplus", async () => {
    const h = harness();
    h.setFundingPreference("server_first");
    h.capabilities.set(ALICE, ["use_server_provider_credentials"]);
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    expect(admitted).toMatchObject({ kind: "server", providerRoute: "openrouter" });

    const deps: ModelFundingDeps = {
      ...h.deps,
      // Simulate an implementation that ignores the requested pinned rail.
      serverRoute: () => "surplus",
    };
    expect(await code(resolveModelFunding({
      ...request(ALICE), priorDecision: admitted,
    }, deps))).toBe("funding_source_changed");
    expect(await code(resolveModelFunding({
      ...request(ALICE), priorDecision: admitted, transport: "surplus",
    }, deps))).toBe("funding_source_changed");
  });

  test("a server admission cannot cross to a personal-only fallback after priority or authority changes", async () => {
    const h = harness();
    h.setFundingPreference("server_first");
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    h.rows.set(`${ALICE}:openai`, row(ALICE, "openai"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    expect(admitted.kind).toBe("server");

    h.setFundingPreference("personal_first");
    h.setServerRoute(null);
    expect(await code(resolveModelFunding({
      ...request(ALICE, "openai:synthetic/fallback"),
      priorDecision: admitted,
    }, h.deps))).toBe("provider_credentials_missing");
    expect(h.reads).toEqual([]);

    h.setServerRoute("openai");
    h.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
    expect(await code(resolveModelFunding({
      ...request(ALICE, "openai:synthetic/fallback"),
      priorDecision: admitted,
    }, h.deps))).toBe("server_credentials_forbidden");
  });

  test("a personal admission marks a server-only mixed-provider fallback as unavailable without crossing payer", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    expect(admitted.kind).toBe("personal");

    h.setFundingPreference("server_first");
    const unavailable = await resolveModelFunding({
      ...request(ALICE, "openai:synthetic/server-only-fallback"),
      priorDecision: admitted,
    }, h.deps).then(() => null, (error: unknown) => error);
    expect(unavailable).toBeInstanceOf(PersonalModelFundingUnavailableError);
  });

  test("personal custody failure cannot unlock an eligible server route", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const personal = await resolveModelFunding(request(ALICE), h.deps);
    if (personal.kind !== "personal") throw new Error("Expected personal funding");
    h.deps.readCustody = async () => {
      throw new Error("synthetic custody failure");
    };

    expect(await code(withAdmittedPersonalProviderKey(personal, () => {
      throw new Error("Provider must not be reached");
    }, h.deps))).toBe("personal_credential_unavailable");
    expect(h.reads).toEqual([`${ALICE}:openrouter`, `${ALICE}:openrouter`, `${ALICE}:openrouter`]);
  });

  test("missing personal key falls back only for a server-authorized Human", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.capabilities.set(BOB, ["use_personal_provider_credentials"]);
    expect((await resolveModelFunding(request(ALICE), h.deps)).kind).toBe("server");
    expect(await code(resolveModelFunding(request(BOB), h.deps)))
      .toBe("personal_credential_missing");
    h.setServerRoute(null);
    expect(await code(resolveModelFunding(request(ALICE), h.deps)))
      .toBe("provider_credentials_missing");
  });

  test("a personal operation cannot change payer or spend server keys after delete or revocation", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    expect(admitted.kind).toBe("personal");
    h.rows.delete(`${ALICE}:openrouter`);
    expect(await code(resolveModelFunding({ ...request(ALICE), priorDecision: admitted }, h.deps)))
      .toBe("personal_credential_stale");
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    h.capabilities.set(ALICE, ["use_server_provider_credentials"]);
    expect(await code(resolveModelFunding({ ...request(ALICE), priorDecision: admitted }, h.deps)))
      .toBe("personal_credentials_forbidden");
    h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.setEnabled(false);
    expect(await code(resolveModelFunding({ ...request(ALICE), priorDecision: admitted }, h.deps)))
      .toBe("personal_credentials_disabled");
  });

  test("replacement invalidates the admitted revision before decryption or another attempt", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    if (admitted.kind !== "personal") throw new Error("Expected personal funding");
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter", 2));
    expect(await code(withAdmittedPersonalProviderKey(admitted, () => {
      throw new Error("Provider must not be reached");
    }, h.deps))).toBe("personal_credential_stale");
  });

  test("two Humans remain isolated and callback errors are not recast as custody failures", async () => {
    const h = harness();
    for (const userId of [ALICE, BOB]) {
      h.capabilities.set(userId, ["use_personal_provider_credentials"]);
      h.rows.set(`${userId}:openrouter`, row(userId, "openrouter"));
    }
    const [alice, bob] = await Promise.all([
      resolveModelFunding(request(ALICE), h.deps),
      resolveModelFunding(request(BOB), h.deps),
    ]);
    if (alice.kind !== "personal" || bob.kind !== "personal") throw new Error("Expected personal funding");
    expect(alice.credentialId).not.toBe(bob.credentialId);
    const [aliceKey, bobKey] = await Promise.all([
      withAdmittedPersonalProviderKey(alice, (key) => key, h.deps),
      withAdmittedPersonalProviderKey(bob, (key) => key, h.deps),
    ]);
    expect(aliceKey).toBe(`private-${ALICE}`);
    expect(bobKey).toBe(`private-${BOB}`);
    let providerError: unknown;
    try {
      await withAdmittedPersonalProviderKey(alice, () => {
        throw new Error("Provider rejected request");
      }, h.deps);
    } catch (error) {
      providerError = error;
    }
    expect(providerError).toBeInstanceOf(Error);
    expect((providerError as Error).message).toBe("Provider rejected request");
  });

  test("server-funded fallback stays on server even if a personal key is added later", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const retry = await resolveModelFunding({ ...request(ALICE), priorDecision: admitted }, h.deps);
    expect(retry.kind).toBe("server");
    expect(h.reads).toEqual([`${ALICE}:openrouter`]);
  });

  test("generic Gateway remains server-only and never changes a pinned personal payer", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    expect(await resolveModelFunding(request(ALICE, "gateway:example/model"), h.deps))
      .toMatchObject({ kind: "server", providerRoute: "gateway" });
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const personal = await resolveModelFunding(request(ALICE), h.deps);
    expect(await code(resolveModelFunding({
      ...request(ALICE, "gateway:example/model"), priorDecision: personal,
    }, h.deps))).toBe("unsupported_provider");
  });

  test("personal fallback to another provider stays personal and checks the original revision", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    h.rows.set(`${ALICE}:openai`, row(ALICE, "openai"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    const fallback = await resolveModelFunding({
      ...request(ALICE, "openai:synthetic/model"), priorDecision: admitted,
    }, h.deps);
    expect(fallback).toMatchObject({ kind: "personal", payerHumanId: ALICE, providerRoute: "openai" });
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter", 2));
    expect(await code(resolveModelFunding({
      ...request(ALICE, "openai:synthetic/model"), priorDecision: admitted,
    }, h.deps))).toBe("personal_credential_stale");
  });

  test("fallback decryption rechecks the initially admitted credential after candidate selection", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    h.rows.set(`${ALICE}:openai`, row(ALICE, "openai"));
    const initial = await resolveModelFunding(request(ALICE), h.deps);
    if (initial.kind !== "personal") throw new Error("Expected personal funding");
    const fallback = await resolveModelFunding({
      ...request(ALICE, "openai:synthetic/model"), priorDecision: initial,
    }, h.deps);
    if (fallback.kind !== "personal") throw new Error("Expected personal fallback");
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter", 2));
    expect(await code(withAdmittedPersonalProviderKey(fallback, () => {
      throw new Error("Provider must not receive the fallback key");
    }, h.deps, initial))).toBe("personal_credential_stale");
  });
});


describe("personal marketplace transport funding", () => {
  test.each(["personal_first", "server_first"] as const)("%s admits a sole personal marketplace and exact account", async (preference) => {
    const h = harness(); h.setFundingPreference(preference); h.setServerRoute(null); h.setSurplusEligible(true);
    h.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:surplus`, row(ALICE, "surplus"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    expect(admitted).toMatchObject({ kind: "personal", providerRoute: "surplus", payerHumanId: ALICE });
    if (admitted.kind !== "personal") throw new Error("Expected personal admission");
    expect(await withAdmittedPersonalProviderKey(admitted, (key) => key, h.deps)).toBe(`private-${ALICE}`);
    h.capabilities.set(BOB, ["use_personal_provider_credentials"]);
    expect(await code(resolveModelFunding(request(BOB), h.deps))).toBe("personal_credential_missing");
  });
  test("safe direct fallback uses a distinct caller credential and keeps original revision authority", async () => {
    const h = harness(); h.setSurplusEligible(true); h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    const marketplace = row(ALICE, "surplus"); const direct = { ...row(ALICE, "openrouter"), id: "50000000-0000-4000-8000-000000000005" };
    direct.envelope = encryptPersonalProviderCredential(custody, "caller-direct", direct);
    h.rows.set(`${ALICE}:surplus`, marketplace); h.rows.set(`${ALICE}:openrouter`, direct);
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    const fallback = await resolveModelFunding({ ...request(ALICE), priorDecision: admitted, transport: "direct" }, h.deps);
    expect(fallback).toMatchObject({ kind: "personal", providerRoute: "openrouter", credentialId: direct.id });
    if (fallback.kind !== "personal") throw new Error("Expected personal admission");
    expect(await withAdmittedPersonalProviderKey(fallback, (key) => key, h.deps, admitted)).toBe("caller-direct");
    h.rows.set(`${ALICE}:surplus`, row(ALICE, "surplus", 2));
    expect(await code(resolveModelFunding({ ...request(ALICE), priorDecision: admitted, transport: "direct" }, h.deps))).toBe("personal_credential_stale");
  });
  test("missing direct fallback never borrows a server credential", async () => {
    const h = harness(); h.setSurplusEligible(true); h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:surplus`, row(ALICE, "surplus"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    const unavailable = await resolveModelFunding({
      ...request(ALICE), priorDecision: admitted, transport: "direct",
    }, h.deps).then(() => null, (error: unknown) => error);
    expect(unavailable).toBeInstanceOf(PersonalDirectFundingUnavailableError);
    h.rows.delete(`${ALICE}:surplus`);
    expect(await code(resolveModelFunding({ ...request(ALICE), priorDecision: admitted, transport: "direct" }, h.deps))).toBe("personal_credential_stale");
  });
  test("original marketplace custody failure stays terminal before a missing-direct signal", async () => {
    const h = harness(); h.setSurplusEligible(true); h.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:surplus`, row(ALICE, "surplus"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    if (admitted.kind !== "personal") throw new Error("Expected personal marketplace admission");
    h.deps.readCustody = async () => { throw new Error("synthetic custody failure"); };

    expect(await code(withAdmittedPersonalProviderKey(admitted, () => {
      throw new Error("Marketplace transport must not run");
    }, h.deps))).toBe("personal_credential_unavailable");
  });
  test("custody loss after refusal cannot bypass the original marketplace admission through a chain key", async () => {
    const h = harness(); h.setSurplusEligible(true); h.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:surplus`, row(ALICE, "surplus"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    if (admitted.kind !== "personal") throw new Error("Expected personal marketplace admission");
    const unavailable = await resolveModelFunding({
      ...request(ALICE), priorDecision: admitted, transport: "direct",
    }, h.deps).then(() => null, (error: unknown) => error);
    expect(unavailable).toBeInstanceOf(PersonalDirectFundingUnavailableError);

    h.setSurplusEligible(false);
    h.rows.set(`${ALICE}:openai`, row(ALICE, "openai"));
    const chainCandidate = await resolveModelFunding({
      ...request(ALICE, "openai:synthetic/fallback"),
      priorDecision: admitted,
    }, h.deps);
    if (chainCandidate.kind !== "personal") throw new Error("Expected personal chain candidate");
    h.deps.readCustody = async () => { throw new Error("synthetic custody loss"); };
    let invoked = false;

    expect(await code(withAdmittedPersonalProviderKey(chainCandidate, () => {
      invoked = true;
    }, h.deps, admitted))).toBe("personal_credential_unavailable");
    expect(invoked).toBe(false);
  });
  test("later models without pinned personal funding are skippable only after original authority is revalidated", async () => {
    const h = harness(); h.setSurplusEligible(true); h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:surplus`, row(ALICE, "surplus"));
    const admitted = await resolveModelFunding(request(ALICE), h.deps);
    if (admitted.kind !== "personal") throw new Error("Expected personal marketplace admission");
    h.setSurplusEligible(false);

    const unavailable = await resolveModelFunding({
      ...request(ALICE, "openai:synthetic/no-personal-key"), priorDecision: admitted,
    }, h.deps).then(() => null, (error: unknown) => error);
    expect(unavailable).toBeInstanceOf(PersonalModelFundingUnavailableError);

    h.rows.delete(`${ALICE}:surplus`);
    expect(await code(resolveModelFunding({
      ...request(ALICE, "openai:synthetic/no-personal-key"), priorDecision: admitted,
    }, h.deps))).toBe("personal_credential_stale");
  });
  test("a legacy personal Gateway decision is rejected before lookup or decryption", async () => {
    const h = harness(); h.capabilities.set(ALICE, ["use_personal_provider_credentials", "use_server_provider_credentials"]);
    h.rows.set(`${ALICE}:gateway`, row(ALICE, "gateway"));
    const admitted = {
      kind: "personal" as const,
      humanUserId: ALICE,
      payerHumanId: ALICE,
      modelId: "gateway:example",
      providerRoute: "gateway",
      workload: "foreground_text_chat" as const,
      credentialId: "30000000-0000-4000-8000-000000000003",
      credentialRevision: 1,
    };
    let invoked = false;
    expect(await code(withAdmittedPersonalProviderKey(admitted, () => { invoked = true; }, h.deps)))
      .toBe("unsupported_provider");
    expect(invoked).toBe(false);
    expect(h.reads).toEqual([]);
  });
});
