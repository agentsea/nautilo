import { describe, expect, test } from "bun:test";
import { resolveCatalogModel } from "@nautilo/agent";
import type { EligibleModel } from "@nautilo/trust";
import {
  isSignedImageUnderstandingModel,
  listPersonalImageUnderstandingModels,
  resolveImageUnderstandingModel,
  type ImageUnderstandingPreferenceDeps,
} from "../../src/lib/image-model-preferences";
import {
  ModelFundingError,
  type ModelFundingDecision,
  type ResolveModelFundingInput,
} from "../../src/lib/model-funding";

const HUMAN = "synthetic-human";
const base = resolveCatalogModel("anthropic:claude-sonnet-4-6", { env: {} });

function eligible(id: string): EligibleModel {
  return {
    id,
    displayName: id,
    provider: "openai",
    priority: 1,
    costCoefficient: 1,
    enabled: false,
    availability: "missing-key",
    capabilities: { tools: false, vision: true, reasoning: false, e2ee: false, webSearch: false },
  };
}

function decision(modelId: string): ModelFundingDecision {
  return { humanUserId: HUMAN, modelId, providerRoute: "openai", workload: "image_assistance", kind: "server" };
}

function harness(ids = ["openai:cheap", "openai:costly"]) {
  const calls: string[] = [];
  const admissions: ResolveModelFundingInput[] = [];
  const textOnly = new Set<string>();
  const unavailable = new Map<string, ModelFundingError["code"]>();
  const deps: ImageUnderstandingPreferenceDeps = {
    listModels: () => ids.map(eligible),
    resolveCatalog: (id) => ({
      ...base,
      id,
      availability: "missing_credentials",
      input: textOnly.has(id) ? ["text"] : ["text", "image"],
    }),
    resolvePrice: (id) => ({
      price: { inputPerMtok: id.endsWith("cheap") ? 1 : 8, outputPerMtok: 1 },
      source: "catalog_coefficient",
    }),
    resolveFunding: async (input) => {
      admissions.push(input);
      const { modelId } = input;
      calls.push(modelId);
      const error = unavailable.get(modelId);
      if (error) throw new ModelFundingError(error);
      return decision(modelId);
    },
    getServerSelection: () => null,
  };
  return { deps, calls, admissions, textOnly, unavailable };
}

describe("image understanding model preferences", () => {
  test("lists only signed chat models with image input and text output", () => {
    const h = harness(["openai:vision", "openai:text-only"]);
    h.textOnly.add("openai:text-only");
    expect(isSignedImageUnderstandingModel("openai:vision", h.deps)).toBe(true);
    expect(isSignedImageUnderstandingModel("openai:text-only", h.deps)).toBe(false);
    expect(listPersonalImageUnderstandingModels(h.deps).map((row) => row.modelId))
      .toEqual(["openai:vision"]);
  });

  test("retains routing-filtered signed vision rows while excluding disabled and unknown rows", () => {
    const ids = ["venice:routing-filtered", "openai:disabled", "openai:unknown"];
    const h = harness(ids);
    const resolveCatalog = h.deps.resolveCatalog!;
    const deps: ImageUnderstandingPreferenceDeps = {
      ...h.deps,
      resolveCatalog: (id: string) => ({
        ...resolveCatalog(id, { env: {} }),
        availability: id.endsWith("routing-filtered")
          ? "routing_filtered" as const
          : id.endsWith("disabled") ? "disabled" as const : "unknown_model" as const,
      }),
    };

    expect(isSignedImageUnderstandingModel("venice:routing-filtered", deps)).toBe(true);
    expect(isSignedImageUnderstandingModel("openai:disabled", deps)).toBe(false);
    expect(isSignedImageUnderstandingModel("openai:unknown", deps)).toBe(false);
    expect(listPersonalImageUnderstandingModels(deps).map((row) => row.modelId))
      .toEqual(["venice:routing-filtered"]);
  });

  test("enforces live routing consent separately from signed vision membership", async () => {
    const h = harness(["venice:routing-filtered"]);
    const resolveCatalog = h.deps.resolveCatalog!;
    const deps: ImageUnderstandingPreferenceDeps = {
      ...h.deps,
      resolveCatalog: (id, options) => ({
        ...resolveCatalog(id, { env: {} }),
        availability: options?.env?.["NAUTILO_ALLOW_CHINA_UPSTREAM"] === "true"
          ? "missing_credentials" : "routing_filtered",
      }),
    };
    const input = {
      humanUserId: HUMAN,
      preferences: { revision: 4, overrides: { imageUnderstanding: "venice:routing-filtered" } },
      mainModelId: "venice:routing-filtered",
    };
    const previous = process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
    try {
      delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
      expect(isSignedImageUnderstandingModel("venice:routing-filtered", deps)).toBe(true);
      expect(await resolveImageUnderstandingModel(input, deps)
        .catch((error: unknown) => error)).toMatchObject({ code: "unsupported_workload" });
      expect(h.calls).toEqual([]);
      process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
      expect(await resolveImageUnderstandingModel(input, deps))
        .toMatchObject({ modelId: "venice:routing-filtered", preferenceRevision: 4 });
      expect(h.calls).toEqual(["venice:routing-filtered"]);
      h.unavailable.set("venice:routing-filtered", "provider_credentials_missing");
      expect(await resolveImageUnderstandingModel(input, deps)
        .catch((error: unknown) => error)).toMatchObject({ code: "provider_credentials_missing" });
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
      else process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = previous;
    }
  });

  test("resolves personal override before server default and preserves revision", async () => {
    const h = harness();
    const result = await resolveImageUnderstandingModel({
      humanUserId: HUMAN,
      preferences: { revision: 7, overrides: { imageUnderstanding: "openai:cheap" } },
    }, { ...h.deps, getServerSelection: () => "openai:costly" });
    expect(result).toMatchObject({
      modelId: "openai:cheap",
      preferenceRevision: 7,
      serverSelection: "openai:costly",
    });
    expect(h.calls).toEqual(["openai:cheap"]);
    expect(h.admissions[0]?.transport).toBeUndefined();
  });

  test("constrains a privacy-protected main model to direct helper admission", async () => {
    const h = harness(["openai:vision"]);
    const resolveCatalog = h.deps.resolveCatalog!;
    const deps: ImageUnderstandingPreferenceDeps = {
      ...h.deps,
      resolveCatalog: (id: string) => id === "openai:private-main"
        ? { ...resolveCatalog("openai:vision", { env: {} }), id, privacyLabel: "anonymized" }
        : { ...resolveCatalog(id, { env: {} }), privacyLabel: "anonymized" },
    };
    await resolveImageUnderstandingModel({
      humanUserId: HUMAN,
      preferences: { revision: 1, overrides: {} },
      mainModelId: "openai:private-main",
    }, deps);
    expect(h.admissions[0]?.transport).toBe("direct");
  });

  test("uses the explicit server default and never substitutes when it is invalid or unfundable", async () => {
    const h = harness();
    h.unavailable.set("openai:costly", "provider_credentials_missing");
    const unfundable = await resolveImageUnderstandingModel({
      humanUserId: HUMAN,
      preferences: { revision: 0, overrides: {} },
    }, { ...h.deps, getServerSelection: () => "openai:costly" }).catch((error: unknown) => error);
    expect(unfundable).toMatchObject({ code: "provider_credentials_missing" });
    expect(h.calls).toEqual(["openai:costly"]);

    const invalid = await resolveImageUnderstandingModel({
      humanUserId: HUMAN,
      preferences: { revision: 0, overrides: {} },
    }, { ...h.deps, getServerSelection: () => "openai:not-signed" }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "unsupported_workload" });
  });

  test("Automatic walks genuine absence but propagates broken credential custody", async () => {
    const h = harness();
    h.unavailable.set("openai:cheap", "provider_credentials_missing");
    expect(await resolveImageUnderstandingModel({
      humanUserId: HUMAN,
      preferences: { revision: 3, overrides: {} },
    }, h.deps)).toMatchObject({ modelId: "openai:costly", preferenceRevision: 3 });
    expect(h.calls).toEqual(["openai:cheap", "openai:costly"]);

    const broken = harness();
    broken.unavailable.set("openai:cheap", "personal_credential_unavailable");
    const failure = await resolveImageUnderstandingModel({
      humanUserId: HUMAN,
      preferences: { revision: 1, overrides: {} },
    }, broken.deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "personal_credential_unavailable" });
    expect(broken.calls).toEqual(["openai:cheap"]);
  });
});
