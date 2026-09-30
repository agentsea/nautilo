import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { z } from "zod";
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
import { ModelFundingError } from "../../src/lib/model-funding";

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
    configRoutes(app);
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

  test("represents personal funding internally without enabling selection in this release", async () => {
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
});
