import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installSurplusCatalogFixture } from "../../../agent/tests/helpers/surplus-catalog-fixture";
import { resetSurplusModelCatalog } from "../../../agent/src/providers/surplus-catalog";
import { resolveCatalogModel } from "@nautilo/agent";
import type { PersonalProviderCredentialRecord, PersonalProviderId } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import { createCapabilityFundingSession } from "../../src/lib/capability-funding";
import {
  ModelFundingError,
  type ModelFundingDeps,
} from "../../src/lib/model-funding";

const HUMAN_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "20000000-0000-4000-8000-000000000002";
const DECISION_MODEL = "openrouter:typesafe/jev-1.13";
const RESEARCH_MODEL = "openrouter:anthropic/claude-sonnet-4.6";
const VISION_MODEL = "anthropic:claude-sonnet-4-6";
const SUBSCRIPTION_VISION_MODEL = "openai:gpt-5.6-luna";
beforeEach(installSurplusCatalogFixture);
afterEach(resetSurplusModelCatalog);

function credential(
  provider: PersonalProviderId,
  custody = createPersonalProviderCustody(),
): PersonalProviderCredentialRecord {
  const identity = {
    id: CREDENTIAL_ID,
    userId: HUMAN_ID,
    provider,
    revision: 1,
  } as const;
  return {
    ...identity,
    validationStatus: "unverified",
    validatedAt: null,
    destination: null,
    receiptReadStatus: "unknown",
    envelope: encryptPersonalProviderCredential(custody, "test-only-secret", identity),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function personalProjectionDeps(row: PersonalProviderCredentialRecord): ModelFundingDeps {
  return {
    getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference: "personal_first" }),
    getCapabilities: async () => ["use_personal_provider_credentials"],
    getCredential: async (humanId, provider) => humanId === HUMAN_ID && provider === row.provider ? row : null,
    serverRoute: () => null,
    personalSurplusRoute: () => false,
    readCustody: async () => { throw new Error("projection must not decrypt credentials"); },
    decrypt: decryptPersonalProviderCredential,
  };
}

function serverProjectionDeps(): ModelFundingDeps {
  return {
    getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference: "server_first" }),
    getCapabilities: async () => ["use_server_provider_credentials"],
    getCredential: async () => null,
    serverRoute: () => "openrouter",
    personalSurplusRoute: () => false,
    readCustody: async () => { throw new Error("server projection must not read custody"); },
    decrypt: decryptPersonalProviderCredential,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelFundingError) return error.code;
    throw error;
  }
  return undefined;
}

describe("capability funding projection", () => {
  test("propagates ordinary marketplace broadening into non-Memory capability funding", async () => {
    const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, serverProjectionDeps(), {
      allowUnpinnedSurplusRetry: true,
    });
    const decision = await session.openModel(DECISION_MODEL, "decision");
    const research = await session.openModel(RESEARCH_MODEL, "research");
    const memory = await session.openModel(RESEARCH_MODEL, "memory");

    expect(decision.fundingSession.allowUnpinnedSurplusRetry).toBe(true);
    expect(research.fundingSession.allowUnpinnedSurplusRetry).toBe(true);
    expect(memory.fundingSession.allowUnpinnedSurplusRetry).toBeUndefined();
  });

  test("marks a personal choice unavailable when its envelope belongs to replaced custody", async () => {
    const replacedCustody = createPersonalProviderCustody();
    const currentCustody = {
      ...createPersonalProviderCustody(),
      resetFromKeyId: replacedCustody.keyId,
    };
    const row = credential("openrouter", replacedCustody);
    let custodyReads = 0;
    const session = createCapabilityFundingSession(
      HUMAN_ID,
      async () => {},
      personalProjectionDeps(row),
      {
        readPreferences: async () => ({ revision: 3, overrides: { decision: DECISION_MODEL } }),
        readProjectionCustody: async () => {
          custodyReads += 1;
          return currentCustody;
        },
      },
    );

    expect(await errorCode(session.resolveModel("decision"))).toBe("personal_credential_unavailable");
    expect(await errorCode(session.openModel(DECISION_MODEL, "decision"))).toBe("personal_credential_unavailable");
    expect(custodyReads).toBe(1);
  });

  test("media and speech projections reject replaced custody without decrypting", async () => {
    for (const [role, provider, modelId] of [
      ["speech", "elevenlabs", "elevenlabs:eleven_v3"],
      ["imageGeneration", "openai", "openai:gpt-image-2"],
    ] as const) {
      const row = credential(provider);
      const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, personalProjectionDeps(row), {
        readPreferences: async () => ({ revision: 1, overrides: { [role]: modelId } }),
        readProjectionCustody: async () => createPersonalProviderCustody(),
      });
      expect(await errorCode(session.resolveModel(role))).toBe("personal_credential_unavailable");
      expect(await errorCode(session.projectMediaFunding!(modelId, role))).toBe("personal_credential_unavailable");
    }
  });

  test("does not inspect personal custody for a server-funded projection", async () => {
    let custodyReads = 0;
    const session = createCapabilityFundingSession(
      HUMAN_ID,
      async () => {},
      serverProjectionDeps(),
      {
        readProjectionCustody: async () => {
          custodyReads += 1;
          return createPersonalProviderCustody();
        },
      },
    );

    expect(await session.openModel(RESEARCH_MODEL, "research")).toMatchObject({
      binding: { kind: "server", providerRoute: "openrouter" },
    });
    expect(custodyReads).toBe(0);
  });

  test("resolves and opens the sparse image-understanding preference with its revision", async () => {
    const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, serverProjectionDeps(), {
      readPreferences: async () => ({
        revision: 6,
        overrides: { imageUnderstanding: VISION_MODEL },
      }),
    });
    expect(await session.resolveModel("imageUnderstanding")).toEqual({
      modelId: VISION_MODEL,
      preferenceRevision: 6,
    });
    expect(await session.openModel(VISION_MODEL, "image_assistance")).toMatchObject({
      binding: { kind: "server", providerRoute: "openrouter" },
      fundingSession: { workload: "image_assistance" },
    });
  });

  test("keeps a qualified Surplus image-understanding admission through readiness and open", async () => {
    const projectionDeps: ModelFundingDeps = {
      ...serverProjectionDeps(),
      serverRoute: (_modelId, _workload, transport) => transport === "direct" ? "anthropic" : "surplus",
    };
    const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, projectionDeps, {
      readPreferences: async () => ({
        revision: 2,
        overrides: { imageUnderstanding: VISION_MODEL },
      }),
    });
    expect(await session.resolveModel("imageUnderstanding")).toEqual({
      modelId: VISION_MODEL,
      preferenceRevision: 2,
    });
    const opened = await session.openModel(VISION_MODEL, "image_assistance");
    expect(opened.binding).toEqual({ kind: "server", providerRoute: "surplus" });
  });

  test("projects image-understanding availability for the requested payer under either priority", async () => {
    for (const fundingPreference of ["personal_first", "server_first"] as const) {
      const custody = createPersonalProviderCustody();
      const personalRow = credential("anthropic", custody);
      const personalOnlyDeps: ModelFundingDeps = {
        getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference }),
        getCapabilities: async () => ["use_personal_provider_credentials", "use_server_provider_credentials"],
        getCredential: async (humanId, provider) => humanId === HUMAN_ID && provider === "anthropic"
          ? personalRow : null,
        serverRoute: () => null,
        personalSurplusRoute: () => false,
        readCustody: async () => { throw new Error("projection must not decrypt credentials"); },
        decrypt: decryptPersonalProviderCredential,
      };
      let authorityChecks = 0;
      const personalOnly = createCapabilityFundingSession(HUMAN_ID, async () => {
        authorityChecks += 1;
      }, personalOnlyDeps, {
        readPreferences: async () => ({ revision: 4, overrides: {} }),
        readProjectionCustody: async () => custody,
      });

      expect(await personalOnly.projectImageUnderstandingFunding!(VISION_MODEL, "personal")).toEqual({
        modelId: VISION_MODEL,
        binding: {
          kind: "personal",
          providerRoute: "anthropic",
          credentialId: CREDENTIAL_ID,
          credentialRevision: 1,
        },
      });
      expect(await errorCode(personalOnly.projectImageUnderstandingFunding!(VISION_MODEL, "server")))
        .toBe("provider_credentials_missing");
      expect(authorityChecks).toBe(2);

      const serverOnlyDeps: ModelFundingDeps = {
        getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference }),
        getCapabilities: async () => ["use_personal_provider_credentials", "use_server_provider_credentials"],
        getCredential: async () => null,
        serverRoute: () => "anthropic",
        personalSurplusRoute: () => false,
        readCustody: async () => { throw new Error("server projection must not read custody"); },
        decrypt: decryptPersonalProviderCredential,
      };
      const serverOnly = createCapabilityFundingSession(HUMAN_ID, async () => {}, serverOnlyDeps, {
        readPreferences: async () => ({ revision: 5, overrides: {} }),
        readProjectionCustody: async () => { throw new Error("server projection must not read custody"); },
      });

      expect(await serverOnly.projectImageUnderstandingFunding!(VISION_MODEL, "server")).toEqual({
        modelId: VISION_MODEL,
        binding: { kind: "server", providerRoute: "anthropic" },
      });
      expect(await errorCode(serverOnly.projectImageUnderstandingFunding!(VISION_MODEL, "personal")))
        .toBe("personal_credential_missing");
    }
  });

  test("projects an exact image-understanding candidate or inherits the saved preference", async () => {
    const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, serverProjectionDeps(), {
      readPreferences: async () => ({
        revision: 7,
        overrides: { imageUnderstanding: VISION_MODEL },
      }),
    });

    expect(await session.projectImageUnderstandingFunding!(null, "server")).toEqual({
      modelId: VISION_MODEL,
      binding: { kind: "server", providerRoute: "openrouter" },
    });
    expect(await errorCode(session.projectImageUnderstandingFunding!("unknown:model", "server")))
      .toBe("unsupported_workload");
  });

  test("projects an eligible subscription image model without API-key custody", async () => {
    const deps: ModelFundingDeps = {
      ...personalProjectionDeps(credential("openai")),
      getCredential: async () => null,
      getSubscription: async () => ({
        id: CREDENTIAL_ID,
        revision: 1,
        available: true,
        modelIds: [SUBSCRIPTION_VISION_MODEL],
      }),
      getSubscriptionModels: async () => [SUBSCRIPTION_VISION_MODEL],
    };
    const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, deps, {
      readPreferences: async () => ({
        revision: 8,
        overrides: { imageUnderstanding: SUBSCRIPTION_VISION_MODEL },
      }),
      readProjectionCustody: async () => {
        throw new Error("subscription projection must not read API-key custody");
      },
    });

    expect(await session.resolveModel("imageUnderstanding")).toEqual({
      modelId: SUBSCRIPTION_VISION_MODEL,
      preferenceRevision: 8,
    });
    expect(await session.projectImageUnderstandingFunding!(null, "personal")).toEqual({
      modelId: SUBSCRIPTION_VISION_MODEL,
      binding: {
        kind: "personal",
        providerRoute: "openai-chatgpt",
        credentialId: CREDENTIAL_ID,
        credentialRevision: 1,
      },
    });
  });

  test("rejects non-text research and decision models without choice support", async () => {
    const resolvedDecision = resolveCatalogModel(DECISION_MODEL, { env: {} });
    const invalidResearch = {
      ...resolvedDecision,
      id: "openrouter:invalid-research",
      workload: "chat",
      output: ["image"],
      decision: null,
    } as ReturnType<typeof resolveCatalogModel>;
    const invalidDecision = {
      ...resolvedDecision,
      id: "openrouter:invalid-decision",
      decision: { ...resolvedDecision.decision!, operations: ["score"] },
    } as ReturnType<typeof resolveCatalogModel>;
    const projectionDeps = serverProjectionDeps();

    const research = createCapabilityFundingSession(HUMAN_ID, async () => {}, projectionDeps, {
      resolveCatalog: () => invalidResearch,
    });
    const decision = createCapabilityFundingSession(HUMAN_ID, async () => {}, projectionDeps, {
      resolveCatalog: () => invalidDecision,
    });

    expect(await errorCode(research.openModel(invalidResearch.id, "research"))).toBe("unsupported_workload");
    expect(await errorCode(decision.openModel(invalidDecision.id, "decision"))).toBe("unsupported_workload");
  });
});

test("subscription parent cannot fund auxiliary work through another credential", async () => {
  const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, serverProjectionDeps(), {
    parentBinding: { kind: "personal", providerRoute: "openai-chatgpt", credentialId: CREDENTIAL_ID, credentialRevision: 1 },
    readPreferences: async () => ({ revision: 1, overrides: {} }),
  });
  expect(await errorCode(session.openModel(RESEARCH_MODEL, "research"))).toBe("personal_credentials_forbidden");
  expect(await errorCode(session.openModel(DECISION_MODEL, "decision"))).toBe("unsupported_workload");
  expect(await errorCode(session.openModel(RESEARCH_MODEL, "memory"))).toBe("unsupported_workload");
  expect(await errorCode(session.resolveModel("memoryReview"))).toBe("unsupported_workload");
  expect(await errorCode(session.resolveModel("imageUnderstanding"))).toBe("unsupported_workload");
  expect(await errorCode(session.openModel(VISION_MODEL, "image_assistance"))).toBe("unsupported_workload");
  expect(await errorCode(session.projectImageUnderstandingFunding!(VISION_MODEL, "personal"))).toBe("unsupported_workload");
  expect(await errorCode(session.openService("tavily"))).toBe("unsupported_workload");
  expect(await errorCode(session.openMedia!("openai:gpt-image-2", "image"))).toBe("unsupported_workload");
  expect(await errorCode(session.projectMediaFunding!("openai:gpt-image-2", "imageGeneration"))).toBe("unsupported_workload");
});

describe("personal Memory funding projection", () => {
  test("admitted Memory uses an optional sparse exact model without changing payer priority", async () => {
    const custody = createPersonalProviderCustody();
    const row = credential("openrouter", custody);
    const session = createCapabilityFundingSession(HUMAN_ID, undefined, personalProjectionDeps(row), {
      readPreferences: async () => ({ revision: 8, overrides: { memoryReview: RESEARCH_MODEL } }),
      readProjectionCustody: async () => custody,
    });
    expect(await session.resolveModel("memoryReview")).toEqual({modelId:RESEARCH_MODEL,preferenceRevision:8});
    expect(await session.openModel(RESEARCH_MODEL,"memory")).toMatchObject({binding:{kind:"personal",providerRoute:"openrouter",credentialId:CREDENTIAL_ID,credentialRevision:1},fundingSession:{workload:"memory"}});
  });
  test("Memory selection respects server-first priority even with a Human override", async () => {
    const session = createCapabilityFundingSession(HUMAN_ID, undefined, serverProjectionDeps(), {
      readPreferences: async () => ({ revision:9,overrides:{memorySummarization:RESEARCH_MODEL} }),
    });
    expect(await session.resolveModel("memorySummarization")).toEqual({modelId:RESEARCH_MODEL,preferenceRevision:9});
    expect((await session.openModel(RESEARCH_MODEL,"memory")).binding.kind).toBe("server");
  });
  test("a disabled explicit Memory model produces repair rather than silent replacement", async () => {
    const session = createCapabilityFundingSession(HUMAN_ID, undefined, serverProjectionDeps(), {
      readPreferences: async () => ({revision:10,overrides:{memoryReflection:"unknown:model"}}),
    });
    const failure = await session.resolveModel("memoryReflection").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
  });
});

test("server Surplus capability sessions expose recovery for inference but never Memory", async () => {
  const recoveryCustody = createPersonalProviderCustody();
  const personalRow = credential("openrouter", recoveryCustody);
  const deps: ModelFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference: "server_first" }),
    getCapabilities: async () => ["use_server_provider_credentials", "use_personal_provider_credentials"],
    getCredential: async (humanId, provider) =>
      humanId === HUMAN_ID && provider === "openrouter" ? personalRow : null,
    serverRoute: () => "surplus",
    personalSurplusRoute: () => true,
    readCustody: async () => recoveryCustody,
    decrypt: decryptPersonalProviderCredential,
  };
  const session = createCapabilityFundingSession(HUMAN_ID, async () => {}, deps);
  const research = await session.openModel(RESEARCH_MODEL, "research");
  const memory = await session.openModel(RESEARCH_MODEL, "memory");

  expect(research.binding).toEqual({ kind: "server", providerRoute: "surplus" });
  expect(research.fundingSession.openPersonalDirectRecovery).toBeFunction();
  expect(research.fundingSession.openPersonalRecovery).toBeFunction();
  expect(memory.fundingSession.openPersonalDirectRecovery).toBeUndefined();
  expect(memory.fundingSession.openPersonalRecovery).toBeUndefined();

  const recovery = await research.fundingSession.openPersonalDirectRecovery!(RESEARCH_MODEL);
  expect(recovery).toMatchObject({ kind: "personal", workload: "research" });
  expect(recovery.capabilityFunding).toBeUndefined();
  const attempt = await recovery.runAttempt(RESEARCH_MODEL, async (value) => value);
  expect(attempt).toMatchObject({
    usageFunding: {
      kind: "personal",
      payerHumanId: HUMAN_ID,
      providerRoute: "openrouter",
      credentialId: CREDENTIAL_ID,
      credentialRevision: 1,
    },
    personalCredential: { apiKey: "test-only-secret" },
  });

  const fullRecovery = await research.fundingSession.openPersonalRecovery!(RESEARCH_MODEL);
  expect(fullRecovery).toMatchObject({ kind: "personal", workload: "research" });
  expect(fullRecovery.capabilityFunding).toBeUndefined();
  expect(fullRecovery.openPersonalRecovery).toBeUndefined();
  expect(await fullRecovery.runAttempt(RESEARCH_MODEL, async (value) => value)).toMatchObject({
    usageFunding: {
      kind: "personal",
      providerRoute: "openrouter",
      credentialId: CREDENTIAL_ID,
      credentialRevision: 1,
    },
    personalCredential: { apiKey: "test-only-secret" },
  });
});
