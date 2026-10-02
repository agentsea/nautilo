import { describe, expect, test } from "bun:test";
import type { PersonalProviderCredentialRecord, PersonalProviderId } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import {
  ModelFundingError,
  resolveModelFunding,
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
  let serverRoute: string | null = "managed-gateway";
  const deps: ModelFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: enabled }),
    getCapabilities: async (userId) => capabilities.get(userId) ?? [],
    getCredential: async (userId, provider) => {
      reads.push(`${userId}:${provider}`);
      return rows.get(`${userId}:${provider}`) ?? null;
    },
    serverRoute: (modelId) => modelId.startsWith("gateway:") ? "gateway" : serverRoute,
    readCustody: async () => custody,
    decrypt: decryptPersonalProviderCredential,
  };
  return {
    deps, rows, capabilities, reads,
    setEnabled(value: boolean) { enabled = value; },
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
  test("stored service keys do not expand personal chat execution", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_personal_provider_credentials"]);
    for (const provider of ["typesafe", "nautilo-gateway", "elevenlabs", "groq", "tavily", "browser-use", "cloudconvert"] as const) {
      h.rows.set(`${ALICE}:${provider}`, row(ALICE, provider));
      expect(await code(resolveModelFunding(request(ALICE, `${provider}:example`), h.deps)))
        .toBe("unsupported_provider");
    }
    h.rows.set(`${ALICE}:gateway`, row(ALICE, "gateway"));
    expect(await code(resolveModelFunding(request(ALICE, "gateway:example"), h.deps)))
      .toBe("server_credentials_forbidden");
    expect(h.reads).toEqual([]);
  });
  test("off switch preserves server route without inspecting personal records", async () => {
    const h = harness();
    h.setEnabled(false);
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    expect(await resolveModelFunding(request(ALICE), h.deps)).toMatchObject({
      kind: "server", humanUserId: ALICE, providerRoute: "managed-gateway",
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
      .toBe("personal_credential_missing");
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

  test("generic Gateway remains server-only and cannot be entered by personal fallback", async () => {
    const h = harness();
    h.capabilities.set(ALICE, ["use_server_provider_credentials", "use_personal_provider_credentials"]);
    expect(await resolveModelFunding(request(ALICE, "gateway:example/model"), h.deps))
      .toMatchObject({ kind: "server", providerRoute: "gateway" });
    h.rows.set(`${ALICE}:openrouter`, row(ALICE, "openrouter"));
    const personal = await resolveModelFunding(request(ALICE), h.deps);
    expect(await code(resolveModelFunding({
      ...request(ALICE, "gateway:example/model"), priorDecision: personal,
    }, h.deps))).toBe("funding_source_changed");
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
