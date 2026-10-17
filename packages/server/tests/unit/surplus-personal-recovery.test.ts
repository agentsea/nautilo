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
  openSurplusPersonalDirectRecovery,
  resolveSurplusPersonalDirectRecovery,
} from "../../src/lib/surplus-personal-recovery";

const HUMAN = "10000000-0000-4000-8000-000000000001";
const OTHER_HUMAN = "20000000-0000-4000-8000-000000000002";
const CREDENTIAL = "30000000-0000-4000-8000-000000000003";
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

const primary: ModelFundingDecision = {
  kind: "server",
  humanUserId: HUMAN,
  modelId: MODEL,
  providerRoute: "surplus",
  workload: "foreground_text_chat",
};

function harness() {
  let row: PersonalProviderCredentialRecord | null = credential();
  let policyEnabled = true;
  let personalCapability = true;
  let primaryCurrent: ModelFundingDecision = primary;
  let decryptions = 0;
  let authorityChecks = 0;
  const credentialReads: string[] = [];
  let subscriptionReads = 0;
  const deps: ModelFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: policyEnabled, fundingPreference: "server_first" }),
    getCapabilities: async (human) => human === HUMAN
      ? ["use_server_provider_credentials", ...(personalCapability ? ["use_personal_provider_credentials"] : [])]
      : [],
    getCredential: async (human, provider) => {
      credentialReads.push(`${human}:${provider}`);
      return human === HUMAN && provider === "openrouter" ? row : null;
    },
    serverRoute: () => "surplus",
    personalSurplusRoute: () => true,
    readCustody: async () => custody,
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
    setPolicyEnabled(value: boolean) { policyEnabled = value; },
    setPersonalCapability(value: boolean) { personalCapability = value; },
    setPrimary(value: ModelFundingDecision) { primaryCurrent = value; },
    counts: () => ({ decryptions, authorityChecks, credentialReads, subscriptionReads }),
  };
}

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
      primaryDecision: primary, recheckPrimary: h.recheckPrimary,
    }, h.deps);

    expect(recovery.kind).toBe("personal");
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
