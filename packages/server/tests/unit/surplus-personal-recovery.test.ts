import { describe, expect, test } from "bun:test";
import type { PersonalProviderCredentialRecord } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import {
  ModelFundingError,
  type ModelFundingDecision,
  type ModelFundingDeps,
} from "../../src/lib/model-funding";
import {
  openServerFirstPersonalRecovery,
  openSurplusPersonalDirectRecovery,
  resolveSurplusPersonalDirectRecovery,
} from "../../src/lib/surplus-personal-recovery";

const HUMAN = "10000000-0000-4000-8000-000000000001";
const OTHER_HUMAN = "20000000-0000-4000-8000-000000000002";
const CREDENTIAL = "30000000-0000-4000-8000-000000000003";
const SURPLUS_CREDENTIAL = "40000000-0000-4000-8000-000000000004";
const MODEL = "openrouter:example/model";
const custody = createPersonalProviderCustody();

function credential(revision = 1): PersonalProviderCredentialRecord {
  const identity = { id: CREDENTIAL, userId: HUMAN, provider: "openrouter" as const, revision };
  return {
    ...identity,
    validationStatus: "unverified",
    validatedAt: null,
    destination: null,
    receiptReadStatus: "unknown",
    envelope: encryptPersonalProviderCredential(custody, `secret-${revision}`, identity),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function surplusCredential(revision = 1): PersonalProviderCredentialRecord {
  const identity = { id: SURPLUS_CREDENTIAL, userId: HUMAN, provider: "surplus" as const, revision };
  return {
    ...identity,
    validationStatus: "unverified",
    validatedAt: null,
    destination: null,
    receiptReadStatus: "unknown",
    envelope: encryptPersonalProviderCredential(custody, `surplus-${revision}`, identity),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const primary: ModelFundingDecision = {
  kind: "server",
  humanUserId: HUMAN,
  modelId: MODEL,
  providerRoute: "surplus",
  workload: "foreground_text_chat",
};

function harness() {
  let row: PersonalProviderCredentialRecord | null = credential();
  let surplusRow: PersonalProviderCredentialRecord | null = null;
  let policyEnabled = true;
  let fundingPreference: "personal_first" | "server_first" = "server_first";
  let personalCapability = true;
  let surplusEligible = true;
  let primaryCurrent: ModelFundingDecision = primary;
  let currentCustody = custody;
  let decryptions = 0;
  let authorityChecks = 0;
  const credentialReads: string[] = [];
  let subscriptionReads = 0;
  const deps: ModelFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: policyEnabled, fundingPreference }),
    getCapabilities: async (human) => human === HUMAN
      ? ["use_server_provider_credentials", ...(personalCapability ? ["use_personal_provider_credentials"] : [])]
      : [],
    getCredential: async (human, provider) => {
      credentialReads.push(`${human}:${provider}`);
      return human === HUMAN
        ? provider === "openrouter" ? row : provider === "surplus" ? surplusRow : null
        : null;
    },
    serverRoute: () => "surplus",
    personalSurplusRoute: () => surplusEligible,
    readCustody: async () => currentCustody,
    decrypt: (...args) => {
      decryptions += 1;
      return decryptPersonalProviderCredential(...args);
    },
    getSubscription: async () => {
      subscriptionReads += 1;
      return { id: "40000000-0000-4000-8000-000000000004", revision: 1,
        available: true, modelIds: [MODEL] };
    },
  };
  return {
    deps,
    recheckPrimary: async () => { authorityChecks += 1; return primaryCurrent; },
    setRow(value: PersonalProviderCredentialRecord | null) { row = value; },
    setSurplusRow(value: PersonalProviderCredentialRecord | null) { surplusRow = value; },
    setPolicyEnabled(value: boolean) { policyEnabled = value; },
    setFundingPreference(value: "personal_first" | "server_first") { fundingPreference = value; },
    setPersonalCapability(value: boolean) { personalCapability = value; },
    setSurplusEligible(value: boolean) { surplusEligible = value; },
    setCustody(value: typeof custody) { currentCustody = value; },
    setPrimary(value: ModelFundingDecision) { primaryCurrent = value; },
    counts: () => ({ decryptions, authorityChecks, credentialReads, subscriptionReads }),
  };
}

describe("server-first full personal recovery", () => {
  test("pins personal Surplus, then separately pins the same model's direct key", async () => {
    const h = harness();
    h.setSurplusRow(surplusCredential());
    const recovery = await openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      primaryDecision: primary,
      allowUnpinnedSurplusRetry: true,
      recheckPrimary: h.recheckPrimary,
    }, h.deps);

    expect(recovery).toMatchObject({ kind: "personal" });
    expect(recovery.allowUnpinnedSurplusRetry).toBe(true);
    expect(recovery.admission).toBeUndefined();
    expect(recovery.capabilityFunding).toBeUndefined();
    expect(recovery.personalTaskControls).toBeUndefined();
    expect(recovery.runnableModelIds).toBeUndefined();
    expect(recovery.openPersonalRecovery).toBeUndefined();
    expect(recovery.openPersonalDirectRecovery).toBeUndefined();
    expect(h.counts()).toMatchObject({ decryptions: 0, subscriptionReads: 0 });

    const preferred = await recovery.runAttempt(MODEL, async (attempt) => attempt);
    expect(preferred).toMatchObject({
      usageFunding: {
        kind: "personal",
        payerHumanId: HUMAN,
        providerRoute: "surplus",
        credentialId: SURPLUS_CREDENTIAL,
        credentialRevision: 1,
      },
      personalCredential: { apiKey: "surplus-1" },
    });
    const pinned = await recovery.runAttempt(MODEL, async (attempt) => attempt, "surplus");
    expect(pinned.usageFunding).toMatchObject({ providerRoute: "surplus", credentialId: SURPLUS_CREDENTIAL });
    const direct = await recovery.runAttempt(MODEL, async (attempt) => attempt, "direct");
    expect(direct).toMatchObject({
      usageFunding: {
        kind: "personal",
        payerHumanId: HUMAN,
        providerRoute: "openrouter",
        credentialId: CREDENTIAL,
        credentialRevision: 1,
      },
      personalCredential: { apiKey: "secret-1" },
    });
    expect(h.counts().subscriptionReads).toBe(0);
  });

  test("uses the direct personal key when no personal Surplus key is configured", async () => {
    const h = harness();
    const directPrimary = { ...primary, providerRoute: "openrouter" };
    h.setPrimary(directPrimary);
    const recovery = await openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      primaryDecision: directPrimary,
      recheckPrimary: h.recheckPrimary,
    }, h.deps);
    expect(recovery.allowUnpinnedSurplusRetry).toBeUndefined();

    expect(await recovery.runAttempt(MODEL, async (attempt) => attempt)).toMatchObject({
      usageFunding: { kind: "personal", providerRoute: "openrouter", credentialId: CREDENTIAL },
      personalCredential: { apiKey: "secret-1" },
    });
    expect(await errorCode(recovery.recheckAttempt(MODEL, "surplus")))
      .toBe("funding_source_changed");
  });

  test("ends on live policy, preference, capability, route, or personal Surplus changes", async () => {
    const cases: Array<{
      mutate: (h: ReturnType<typeof harness>) => void;
      code: string;
    }> = [
      { mutate: (h) => h.setPolicyEnabled(false), code: "personal_credentials_disabled" },
      { mutate: (h) => h.setFundingPreference("personal_first"), code: "funding_source_changed" },
      { mutate: (h) => h.setPersonalCapability(false), code: "personal_credentials_forbidden" },
      { mutate: (h) => h.setPrimary({ ...primary, providerRoute: "openrouter" }), code: "funding_source_changed" },
      { mutate: (h) => h.setSurplusEligible(false), code: "funding_source_changed" },
      { mutate: (h) => h.setSurplusRow(surplusCredential(2)), code: "personal_credential_stale" },
    ];
    for (const testCase of cases) {
      const h = harness();
      h.setSurplusRow(surplusCredential());
      const recovery = await openServerFirstPersonalRecovery({
        humanUserId: HUMAN,
        modelId: MODEL,
        workload: "foreground_text_chat",
        primaryDecision: primary,
        recheckPrimary: h.recheckPrimary,
      }, h.deps);
      testCase.mutate(h);
      let invoked = false;
      expect(await errorCode(recovery.runAttempt(MODEL, async () => { invoked = true; })))
        .toBe(testCase.code);
      expect(invoked).toBe(false);
    }
  });

  test("pins direct revision, rechecks the original Surplus key, and rejects custody replacement", async () => {
    const h = harness();
    h.setSurplusRow(surplusCredential());
    const recovery = await openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      primaryDecision: primary,
      recheckPrimary: h.recheckPrimary,
    }, h.deps);

    await recovery.recheckAttempt(MODEL, "direct");
    h.setRow(credential(2));
    expect(await errorCode(recovery.recheckAttempt(MODEL, "direct")))
      .toBe("personal_credential_stale");

    h.setRow(credential());
    h.setSurplusRow(surplusCredential(2));
    expect(await errorCode(recovery.recheckAttempt(MODEL, "direct")))
      .toBe("personal_credential_stale");

    const custodyHarness = harness();
    custodyHarness.setSurplusRow(surplusCredential());
    const custodyRecovery = await openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      primaryDecision: primary,
      recheckPrimary: custodyHarness.recheckPrimary,
    }, custodyHarness.deps);
    custodyHarness.setCustody(createPersonalProviderCustody());
    let invoked = false;
    expect(await errorCode(custodyRecovery.runAttempt(MODEL, async () => { invoked = true; })))
      .toBe("personal_credential_unavailable");
    expect(invoked).toBe(false);
  });

  test("rejects another model, personal or Memory primary, and never recovers to server", async () => {
    const h = harness();
    h.setSurplusRow(surplusCredential());
    const recovery = await openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      primaryDecision: primary,
      recheckPrimary: h.recheckPrimary,
    }, h.deps);
    expect(await errorCode(recovery.recheckAttempt("anthropic:other")))
      .toBe("funding_source_changed");

    h.setSurplusRow(null);
    h.setRow(null);
    expect(await errorCode(recovery.recheckAttempt(MODEL)))
      .toBe("personal_credential_missing");

    const personalPrimary: ModelFundingDecision = {
      kind: "personal",
      humanUserId: HUMAN,
      payerHumanId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      providerRoute: "openrouter",
      credentialId: CREDENTIAL,
      credentialRevision: 1,
    };
    expect(await errorCode(openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "foreground_text_chat",
      primaryDecision: personalPrimary,
      recheckPrimary: async () => personalPrimary,
    }, h.deps))).toBe("funding_source_changed");
    expect(await errorCode(openServerFirstPersonalRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "memory" as never,
      primaryDecision: { ...primary, workload: "memory" },
      recheckPrimary: async () => ({ ...primary, workload: "memory" }),
    }, h.deps))).toBe("unsupported_workload");
  });
});

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; }
  catch (error) {
    if (error instanceof ModelFundingError) return error.code;
    throw error;
  }
  return undefined;
}

describe("server Surplus personal direct recovery", () => {
  test("resolves a non-secret generation decision for a safe pre-dispatch boundary", async () => {
    const h = harness();
    const generationPrimary: ModelFundingDecision = {
      ...primary,
      workload: "generation",
    };
    const decision = await resolveSurplusPersonalDirectRecovery({
      humanUserId: HUMAN,
      modelId: MODEL,
      workload: "generation",
      primaryDecision: generationPrimary,
      recheckPrimary: async () => generationPrimary,
    }, h.deps);
    expect(decision).toMatchObject({
      kind: "personal",
      payerHumanId: HUMAN,
      modelId: MODEL,
      workload: "generation",
      providerRoute: "openrouter",
      credentialId: CREDENTIAL,
      credentialRevision: 1,
    });
    expect(h.counts().decryptions).toBe(0);
  });

  test("pins an exact own credential without decrypting until the attempt callback", async () => {
    const h = harness();
    const recovery = await openSurplusPersonalDirectRecovery({
      humanUserId: HUMAN, modelId: MODEL, workload: "foreground_text_chat",
      primaryDecision: primary, allowUnpinnedSurplusRetry: true,
      recheckPrimary: h.recheckPrimary,
    }, h.deps);

    expect(recovery.kind).toBe("personal");
    expect(recovery.allowUnpinnedSurplusRetry).toBe(true);
    expect(recovery.admission).toBeUndefined();
    expect(recovery.capabilityFunding).toBeUndefined();
    expect(recovery.openPersonalDirectRecovery).toBeUndefined();
    expect(h.counts()).toMatchObject({ decryptions: 0, authorityChecks: 1, subscriptionReads: 0 });

    await recovery.recheckAttempt(MODEL);
    expect(h.counts().decryptions).toBe(0);
    const result = await recovery.runAttempt(MODEL, async (attempt) => ({
      funding: attempt.usageFunding,
      key: attempt.personalCredential?.apiKey,
    }));
    expect(result).toEqual({
      key: "secret-1",
      funding: {
        kind: "personal", humanUserId: HUMAN, payerHumanId: HUMAN,
        providerRoute: "openrouter", credentialId: CREDENTIAL, credentialRevision: 1,
      },
    });
    expect(h.counts().credentialReads.every((read) => read.startsWith(`${HUMAN}:`))).toBe(true);
    expect(h.counts().credentialReads).not.toContain(`${OTHER_HUMAN}:openrouter`);
    expect(h.counts()).toMatchObject({ decryptions: 1, subscriptionReads: 0 });
  });

  test("rejects model or transport changes before callback execution", async () => {
    const h = harness();
    const recovery = await openSurplusPersonalDirectRecovery({
      humanUserId: HUMAN, modelId: MODEL, workload: "foreground_text_chat",
      primaryDecision: primary, recheckPrimary: h.recheckPrimary,
    }, h.deps);
    let invoked = false;
    expect(await errorCode(recovery.runAttempt("anthropic:other", async () => { invoked = true; })))
      .toBe("funding_source_changed");
    expect(await errorCode(recovery.runAttempt(MODEL, async () => { invoked = true; }, "surplus")))
      .toBe("funding_source_changed");
    expect(invoked).toBe(false);
    expect(h.counts().decryptions).toBe(0);
  });

  test("rechecks primary authority, current personal permission, and exact revision", async () => {
    const h = harness();
    const recovery = await openSurplusPersonalDirectRecovery({
      humanUserId: HUMAN, modelId: MODEL, workload: "foreground_text_chat",
      primaryDecision: primary, recheckPrimary: h.recheckPrimary,
    }, h.deps);
    let invoked = false;

    h.setRow(credential(2));
    expect(await errorCode(recovery.runAttempt(MODEL, async () => { invoked = true; })))
      .toBe("personal_credential_stale");
    h.setRow(credential());
    h.setPersonalCapability(false);
    expect(await errorCode(recovery.runAttempt(MODEL, async () => { invoked = true; })))
      .toBe("personal_credentials_forbidden");
    h.setPersonalCapability(true);
    h.setPolicyEnabled(false);
    expect(await errorCode(recovery.runAttempt(MODEL, async () => { invoked = true; })))
      .toBe("personal_credentials_disabled");
    h.setPolicyEnabled(true);
    h.setPrimary({ ...primary, providerRoute: "openrouter" });
    expect(await errorCode(recovery.runAttempt(MODEL, async () => { invoked = true; })))
      .toBe("funding_source_changed");
    expect(invoked).toBe(false);
    expect(h.counts().decryptions).toBe(0);
  });

  test("requires a server Surplus primary and excludes durable memory recovery", async () => {
    const h = harness();
    const personalPrimary: ModelFundingDecision = {
      kind: "personal", humanUserId: HUMAN, payerHumanId: HUMAN,
      modelId: MODEL, workload: "foreground_text_chat", providerRoute: "openrouter",
      credentialId: CREDENTIAL, credentialRevision: 1,
    };
    expect(await errorCode(openSurplusPersonalDirectRecovery({
      humanUserId: HUMAN, modelId: MODEL, workload: "foreground_text_chat",
      primaryDecision: personalPrimary, recheckPrimary: async () => personalPrimary,
    }, h.deps))).toBe("funding_source_changed");
    expect(await errorCode(openSurplusPersonalDirectRecovery({
      humanUserId: HUMAN, modelId: MODEL, workload: "memory" as never,
      primaryDecision: { ...primary, workload: "memory" },
      recheckPrimary: async () => ({ ...primary, workload: "memory" }),
    }, h.deps))).toBe("unsupported_workload");
  });
});
