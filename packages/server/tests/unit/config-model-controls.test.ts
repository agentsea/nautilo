import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { z } from "zod";
import type { EligibleModel } from "@nautilo/trust";
import type { PersonalProviderCredentialRecord, PersonalProviderId } from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "@nautilo/agent";
import { ModelCatalogSchema } from "@nautilo/types";
import {
  configRoutes,
  resolveCallerModelAvailability,
} from "../../src/routes/config";
import {
  ModelFundingError,
  resolveModelFunding,
  type ModelFundingDeps,
} from "../../src/lib/model-funding";

describe("GET /api/config/models D462 controls", () => {
  afterEach(() => {
    resetRuntimeModelCatalog();
  });

  test("returns Kimi's public Standard/Priority/Fast DTO without selectors or provenance", async () => {
    const catalog = ModelCatalogSchema.parse(
      JSON.parse(
        await readFile(
          new URL(
            "../../../agent/tests/fixtures/model-catalog-controls-v2.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-28T12:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    const app = Fastify({ logger: false });
    let callerAvailabilityCalls = 0;
    configRoutes(app, {
      resolveCallerAvailability: async () => {
        callerAvailabilityCalls += 1;
        throw new Error("guest catalog must not resolve caller funding");
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/config/models?includeUnavailable=true" });
      expect(response.statusCode).toBe(200);
      const models = z.array(z.record(z.string(), z.unknown())).parse(response.json());
      const kimi = models.find(
        (model) => model["id"] === "fireworks:accounts/fireworks/models/kimi-k3",
      );
      expect(kimi).toMatchObject({
        controls: {
          serving: {
            defaultProfile: "standard",
            profiles: [
              { id: "standard", label: "Standard", pricing: { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 } },
              { id: "priority", label: "Priority", pricing: { inputPerMtok: 3.75, cachedInputPerMtok: 0.375, outputPerMtok: 18.75 } },
              { id: "fast", label: "Fast", pricing: { inputPerMtok: 4.5, cachedInputPerMtok: 0.45, outputPerMtok: 22.5 } },
            ],
          },
        },
      });
      expect(JSON.stringify(kimi)).not.toContain("selector");
      expect(JSON.stringify(kimi)).not.toContain("provenance");
      expect(JSON.stringify(models)).not.toContain("funding");
      expect(callerAvailabilityCalls).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("retained resolver returns only requested exact ids and bounds the batch", async () => {
    const app = Fastify({ logger: false });
    configRoutes(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/config/models/resolve",
        payload: { ids: ["legacy:one", "legacy:two"] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<unknown[]>()).toEqual([
        expect.objectContaining({ id: "legacy:one", availability: "unknown-model" }),
        expect.objectContaining({ id: "legacy:two", availability: "unknown-model" }),
      ]);

      const oversized = await app.inject({
        method: "POST",
        url: "/api/config/models/resolve",
        payload: { ids: Array.from({ length: 26 }, (_, index) => `legacy:${index}`) },
      });
      expect(oversized.statusCode).toBe(400);

      const overlong = await app.inject({
        method: "POST",
        url: "/api/config/models/resolve",
        payload: { ids: [`legacy:${"x".repeat(512)}`] },
      });
      expect(overlong.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("caller-scoped model availability", () => {
  afterEach(() => {
    resetRuntimeModelCatalog();
  });

  test("a personal key cannot make an image-output model selectable for chat", async () => {
    let fundingCalls = 0;
    const result = await resolveCallerModelAvailability(
      "human-1",
      "openrouter:openai/gpt-5.4-image-2",
      { purpose: "chat", env: {} },
      {
        resolveFunding: async () => {
          fundingCalls += 1;
          throw new Error("image-only model must not ask for chat funding");
        },
      },
    );
    expect(result.model.availability).toBe("unsupported-capability");
    expect(result.model.enabled).toBe(false);
    expect(result.model.unavailableReason).toBe("model does not produce text");
    expect(result.selectableInThisRelease).toBe(false);
    expect(fundingCalls).toBe(0);
  });

  test("admits personal funding for text chat without advertising unsupported paid features", async () => {
    const modelId = "anthropic:claude-sonnet-4-6";
    const result = await resolveCallerModelAvailability(
      "human-1",
      modelId,
      { purpose: "chat-tools", env: {} },
      {
        resolveFunding: async (input) => ({
          kind: "personal",
          humanUserId: input.humanUserId,
          payerHumanId: input.humanUserId,
          credentialId: "credential-1",
          credentialRevision: 4,
          modelId: input.modelId,
          providerRoute: "anthropic",
          workload: input.workload,
        }),
      },
    );

    expect(result.model).toMatchObject({
      id: modelId,
      availability: "selectable",
      enabled: true,
    });
    expect(result.model.unavailableReason).toBeUndefined();
    expect(result.funding).toMatchObject({
      kind: "personal",
      humanUserId: "human-1",
      credentialId: "credential-1",
      credentialRevision: 4,
    });
    expect(result.selectableInThisRelease).toBe(true);
    expect(result.model.capabilities).toMatchObject({
      tools: false,
      vision: false,
      webSearch: false,
    });
  });

  test("admits a server-funded Surplus-only route without changing personal capability isolation", async () => {
    const modelId = "venice:openai-gpt-55";
    const result = await resolveCallerModelAvailability(
      "human-1",
      modelId,
      { purpose: "chat-tools", env: {} },
      {
        resolveFunding: async (input) => ({
          kind: "server",
          humanUserId: input.humanUserId,
          modelId: input.modelId,
          providerRoute: "surplus",
          workload: input.workload,
        }),
      },
    );
    expect(result).toMatchObject({
      model: { id: modelId, availability: "selectable", enabled: true },
      funding: { kind: "server", providerRoute: "surplus" },
      selectableInThisRelease: true,
    });
  });

  test("server-funded caller rows obey the same tool qualification as model writes", async () => {
    const result = await resolveCallerModelAvailability(
      "human-1",
      "openrouter:moonshotai/kimi-k2.6",
      { purpose: "chat-tools", env: {} },
      {
        resolveFunding: async (input) => ({
          kind: "server",
          humanUserId: input.humanUserId,
          modelId: input.modelId,
          providerRoute: "openrouter",
          workload: input.workload,
        }),
      },
    );
    expect(result.model.availability).toBe("unsupported-capability");
    expect(result.selectableInThisRelease).toBe(false);
  });

  test("fails closed on caller funding denial and does not widen signed catalog restrictions", async () => {
    const denied = await resolveCallerModelAvailability(
      "human-1",
      "anthropic:claude-sonnet-4-6",
      { purpose: "chat-tools", env: { ANTHROPIC_API_KEY: "server-key" } },
      {
        resolveFunding: async () => {
          throw new ModelFundingError("server_credentials_forbidden");
        },
      },
    );
    expect(denied).toMatchObject({
      model: {
        availability: "missing-key",
        enabled: false,
        unavailableReason: "server provider credentials are not permitted for this caller",
      },
      funding: null,
      selectableInThisRelease: false,
    });

    let fundingCalls = 0;
    const unknown = await resolveCallerModelAvailability(
      "human-1",
      "unknown:not-signed",
      {},
      {
        resolveFunding: async () => {
          fundingCalls += 1;
          throw new Error("must not be called");
        },
      },
    );
    expect(unknown.model.availability).toBe("unknown-model");
    expect(unknown.selectableInThisRelease).toBe(false);
    expect(fundingCalls).toBe(0);
  });

  test("authenticated caller catalogue uses personal availability without a server key", async () => {
    const modelId = "anthropic:claude-sonnet-4-6";
    const candidate: EligibleModel = {
      id: modelId,
      displayName: "Claude Sonnet 4.6",
      provider: "anthropic",
      priority: 1,
      costCoefficient: 1,
      enabled: false,
      capabilities: { tools: true, vision: true, reasoning: true, e2ee: false, webSearch: true },
      availability: "missing-key",
      unavailableReason: "Anthropic credential is not configured",
    };
    const { unavailableReason: _unavailableReason, ...candidateWithoutReason } = candidate;
    const calls: Array<{ humanUserId: string; modelId: string; purpose: string | undefined }> = [];
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = request.headers["x-test-user"] === "human-1" ? "human-1" : null;
    });
    configRoutes(app, {
      getEligibleModels: () => [candidate],
      resolveCallerAvailability: async (humanUserId, resolvedModelId, options) => {
        calls.push({ humanUserId, modelId: resolvedModelId, purpose: options?.purpose });
        return {
          model: {
            ...candidateWithoutReason,
            enabled: true,
            availability: "selectable",
            capabilities: { ...candidate.capabilities, tools: false, vision: false, webSearch: false },
          },
          funding: {
            kind: "personal",
            humanUserId,
            payerHumanId: humanUserId,
            credentialId: "credential-1",
            credentialRevision: 2,
            modelId: resolvedModelId,
            providerRoute: "anthropic",
            workload: "foreground_text_chat",
          },
          selectableInThisRelease: true,
        };
      },
    });
    try {
      const guest = await app.inject({ method: "GET", url: "/api/config/models/caller" });
      expect(guest.statusCode).toBe(401);
      expect(calls).toEqual([]);

      const response = await app.inject({
        method: "GET",
        url: "/api/config/models/caller",
        headers: { "x-test-user": "human-1" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<EligibleModel[]>();
      expect(body).toHaveLength(1);
      expect(body[0]?.id).toBe(modelId);
      expect(body[0]?.enabled).toBe(true);
      expect(body[0]?.availability).toBe("selectable");
      expect(body[0]?.capabilities).toMatchObject({ tools: false, vision: false, webSearch: false });
      expect(response.body).not.toContain("credential-1");
      expect(response.body).not.toContain("funding");
      expect(calls).toEqual([{ humanUserId: "human-1", modelId, purpose: "chat-tools" }]);
    } finally {
      await app.close();
    }
  });

  test.each(["personal_first", "server_first"] as const)(
    "caller catalogue keeps the server-only, personal-only, and overlap union under %s",
    async (fundingPreference) => {
      const humanUserId = "human-union";
      const custody = createPersonalProviderCustody();
      const rows = new Map<PersonalProviderId, PersonalProviderCredentialRecord>();
      const addRow = (provider: PersonalProviderId, id: string) => {
        const record: PersonalProviderCredentialRecord = {
          id,
          userId: humanUserId,
          provider,
          revision: 1,
          validationStatus: "unverified",
          validatedAt: null,
          envelope: encryptPersonalProviderCredential(custody, `synthetic-${provider}`, {
            id,
            userId: humanUserId,
            provider,
            revision: 1,
          }),
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        rows.set(provider, record);
      };
      addRow("anthropic", "credential-anthropic");
      addRow("openrouter", "credential-openrouter");

      const personalOnly = "anthropic:claude-sonnet-4-6";
      const overlap = "openrouter:moonshotai/kimi-k3";
      const serverOnly = "fireworks:accounts/fireworks/models/kimi-k3";
      const modelIds = [personalOnly, overlap, serverOnly];
      const decisions = new Map<string, "personal" | "server">();
      const fundingDeps: ModelFundingDeps = {
        getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference }),
        getCapabilities: async () => [
          "use_personal_provider_credentials",
          "use_server_provider_credentials",
        ],
        getCredential: async (_userId, provider) => rows.get(provider) ?? null,
        serverRoute: (modelId) => modelId === overlap
          ? "openrouter"
          : modelId === serverOnly ? "fireworks" : null,
        readCustody: async () => custody,
        decrypt: decryptPersonalProviderCredential,
      };
      const candidates: EligibleModel[] = modelIds.map((id, priority) => ({
        id,
        displayName: id,
        provider: id.slice(0, id.indexOf(":")),
        priority,
        costCoefficient: 1,
        enabled: false,
        capabilities: {
          tools: true,
          vision: false,
          reasoning: true,
          e2ee: false,
          webSearch: false,
        },
        availability: "missing-key",
        unavailableReason: "No process-wide key",
      }));
      const app = Fastify({ logger: false });
      app.decorateRequest("sessionUserId", null);
      app.addHook("preHandler", async (request) => {
        request.sessionUserId = humanUserId;
      });
      configRoutes(app, {
        getEligibleModels: () => candidates,
        resolveCallerAvailability: async (userId, modelId, options) => {
          const result = await resolveCallerModelAvailability(userId, modelId, options, {
            resolveFunding: async (input) => {
              const decision = await resolveModelFunding(input, fundingDeps);
              decisions.set(modelId, decision.kind);
              return decision;
            },
          });
          return result;
        },
      });
      try {
        const response = await app.inject({ method: "GET", url: "/api/config/models/caller" });
        expect(response.statusCode).toBe(200);
        expect(response.json<EligibleModel[]>().map(({ id }) => id)).toEqual(modelIds);
        expect(decisions).toEqual(new Map([
          [personalOnly, "personal"],
          [overlap, fundingPreference === "personal_first" ? "personal" : "server"],
          [serverOnly, "server"],
        ]));
        expect(response.body).not.toContain("synthetic-anthropic");
        expect(response.body).not.toContain("synthetic-openrouter");
        expect(response.body).not.toContain("funding");
      } finally {
        await app.close();
      }
    },
  );
});
