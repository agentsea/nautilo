import { describe, expect, test } from "bun:test";
import { createPersonalProviderCustody, decryptPersonalProviderCredential, encryptPersonalProviderCredential } from "@nautilo/operator-secrets";
import { primeServerModelConfigCache, type PersonalProviderCredentialRecord } from "@nautilo/db";
import { resolvePersonalMediaModel, mediaPreferenceFunding } from "../../src/lib/media-model-preferences";
import type { ModelFundingDeps } from "../../src/lib/model-funding";

const HUMAN = "10000000-0000-4000-8000-000000000001";
function funding() {
  const custody = createPersonalProviderCustody();
  const rows = new Map<string, PersonalProviderCredentialRecord>();
  for (const provider of ["openai", "google", "venice", "elevenlabs"] as const) {
    const identity = { userId: HUMAN, provider, revision: 1, id: "20000000-0000-4000-8000-000000000002" };
    rows.set(provider, { ...identity, envelope: encryptPersonalProviderCredential(custody, "personal-test-key", identity),
      destination: null, validationStatus: "unverified", validatedAt: null, receiptReadStatus: "unknown", createdAt: new Date(), updatedAt: new Date() });
  }
  const deps: ModelFundingDeps = {
    getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference: "personal_first" }),
    getCapabilities: async (human) => human === HUMAN ? ["use_personal_provider_credentials"] : [],
    getCredential: async (human, provider) => human === HUMAN ? rows.get(provider) ?? null : null,
    serverRoute: () => null,
    readCustody: async () => { throw new Error("Preference projections must not decrypt"); },
    decrypt: decryptPersonalProviderCredential,
  };
  return { deps, rows };
}

describe("personal media model selection", () => {
  test("Automatic image selection uses the shared server candidate order", async () => {
    const { deps } = funding();
    const previous = process.env["NAUTILO_IMAGE_MODEL"];
    delete process.env["NAUTILO_IMAGE_MODEL"];
    primeServerModelConfigCache(null);
    try {
      expect(await resolvePersonalMediaModel(HUMAN, "imageGeneration", null, {
        revision: 5,
        overrides: {},
      }, deps)).toEqual({
        modelId: "venice:gpt-image-2",
        preferenceRevision: 5,
      });
    } finally {
      primeServerModelConfigCache(null);
      if (previous === undefined) delete process.env["NAUTILO_IMAGE_MODEL"];
      else process.env["NAUTILO_IMAGE_MODEL"] = previous;
    }
  });

  test("explicit image model wins over a sparse preference and preserves its revision", async () => {
    const { deps } = funding();
    const choice = await resolvePersonalMediaModel(HUMAN, "imageGeneration", "google:gemini-2.5-flash-image", {
      revision: 4, overrides: { imageGeneration: "openai:gpt-image-2" },
    }, deps);
    expect(choice).toEqual({ modelId: "google:gemini-2.5-flash-image", preferenceRevision: 4 });
  });

  test("a missing key for an explicit choice does not silently select another model", async () => {
    const { deps, rows } = funding(); rows.delete("openai");
    expect(resolvePersonalMediaModel(HUMAN, "imageGeneration", null, {
      revision: 2, overrides: { imageGeneration: "openai:gpt-image-2" },
    }, deps)).rejects.toThrow("personal_credential_missing");
  });

  test("personal speech is selectable without an environment key and never decrypts in projection", async () => {
    const { deps } = funding();
    expect(await resolvePersonalMediaModel(HUMAN, "speech", null, {
      revision: 2, overrides: { speech: "elevenlabs:eleven_v3" },
    }, deps)).toEqual({ modelId: "elevenlabs:eleven_v3", preferenceRevision: 2 });
    expect(await mediaPreferenceFunding(HUMAN, "elevenlabs:eleven_v3", "speech", deps))
      .toMatchObject({ kind: "personal", providerRoute: "elevenlabs", credentialRevision: 1 });
  });

  test("workload boundaries reject speech as images and cannot select common embeddings", async () => {
    const { deps } = funding();
    for (const modelId of ["elevenlabs:eleven_v3", "openai:text-embedding-3-small"]) {
      expect(resolvePersonalMediaModel(HUMAN, "imageGeneration", modelId, { revision: 0, overrides: {} }, deps))
        .rejects.toThrow("unsupported_workload");
    }
  });
});
