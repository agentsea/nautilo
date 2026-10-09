import { describe, expect, test } from "bun:test";
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
