import { describe, expect, test } from "bun:test";
import {
  getServerProviderPolicy,
  upsertServerProviderPolicy,
} from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const FIREWORKS_MODEL = "fireworks:accounts/fireworks/models/kimi-k3";
const ANTHROPIC_MODEL = "anthropic:claude-sonnet-4-6";
const OPENROUTER_MODEL = "openrouter:moonshotai/kimi-k3";
const MODELS = [FIREWORKS_MODEL, ANTHROPIC_MODEL, OPENROUTER_MODEL] as const;

const SERVER_FIREWORKS_KEY = "synthetic-server-fireworks-selection";
const SERVER_OPENROUTER_KEY = "synthetic-server-openrouter-selection";
const PERSONAL_ANTHROPIC_KEY = "synthetic-personal-anthropic-selection";
const PERSONAL_OPENROUTER_KEY = "synthetic-personal-openrouter-selection";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe.serial("provider priority model selection routes", () => {
  test("both priorities expose and persist server-only, personal-only, and overlap models", async () => {
    const priorEnv = {
      anthropic: process.env["ANTHROPIC_API_KEY"],
      fireworks: process.env["FIREWORKS_API_KEY"],
      openrouter: process.env["OPENROUTER_API_KEY"],
    };
    const priorFetch = globalThis.fetch;
    let fx: AppFixture | undefined;
    let priorPolicy: Awaited<ReturnType<typeof getServerProviderPolicy>> | undefined;
    let bearer = "";
    const credentialRevisions = new Map<"anthropic" | "openrouter", number>();

    delete process.env["ANTHROPIC_API_KEY"];
    process.env["FIREWORKS_API_KEY"] = SERVER_FIREWORKS_KEY;
    process.env["OPENROUTER_API_KEY"] = SERVER_OPENROUTER_KEY;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const hostname = new URL(url).hostname;
      if (hostname === "127.0.0.1" || hostname === "localhost") {
        return priorFetch(input, init);
      }
      throw new Error(`Unexpected outbound request in model selection test: ${hostname}`);
    }) as typeof fetch;

    try {
      fx = await setupOwnerAppFixture({
        suiteName: "providerpriorityselection",
        withDefaultAgentGraph: true,
      });
      if (!fx.defaultRoomId || !fx.defaultAgentId) {
        throw new Error("owner model-selection graph missing");
      }
      bearer = await fx.mintOwnerBearer();
      priorPolicy = await getServerProviderPolicy(fx.db);

      const initialPolicy = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/server-provider-policy",
        bearer,
        payload: {
          allowPersonalProviderKeys: true,
          fundingPreference: "personal_first",
        },
      });
      expect(initialPolicy.statusCode, initialPolicy.body).toBe(200);

      for (const [provider, apiKey] of [
        ["anthropic", PERSONAL_ANTHROPIC_KEY],
        ["openrouter", PERSONAL_OPENROUTER_KEY],
      ] as const) {
        const saved = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/account/provider-credentials/${provider}`,
          bearer,
          payload: { apiKey },
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.body).not.toContain(apiKey);
        const body = saved.json<{ credential: { revision: number } }>();
        credentialRevisions.set(provider, body.credential.revision);
      }

      for (const fundingPreference of ["personal_first", "server_first"] as const) {
        const policy = await authedInject(fx.app, {
          method: "POST",
          url: "/api/admin/server-provider-policy",
          bearer,
          payload: { fundingPreference },
        });
        expect(policy.statusCode, policy.body).toBe(200);
        expect(policy.json<{
          allowPersonalProviderKeys: boolean;
          fundingPreference: string;
        }>()).toEqual({
          allowPersonalProviderKeys: true,
          fundingPreference,
        });

        const catalogue = await authedInject(fx.app, {
          method: "GET",
          url: "/api/config/models/caller",
          bearer,
        });
        expect(catalogue.statusCode, catalogue.body).toBe(200);
        const projected = catalogue.json<Array<{ id: string; availability: string }>>();
        for (const modelId of MODELS) {
          expect(projected.find((model) => model.id === modelId), modelId).toMatchObject({
            id: modelId,
            availability: "selectable",
          });
        }
        expect(catalogue.body).not.toContain(PERSONAL_ANTHROPIC_KEY);
        expect(catalogue.body).not.toContain(PERSONAL_OPENROUTER_KEY);

        for (const modelId of MODELS) {
          const profile = await authedInject(fx.app, {
            method: "PUT",
            url: "/api/profile",
            bearer,
            payload: { defaultModel: modelId },
          });
          expect(profile.statusCode, `${fundingPreference}: ${modelId}: ${profile.body}`).toBe(200);
          expect(profile.json<{ agent: { defaultModel: string | null } }>()
            .agent.defaultModel).toBe(modelId);
        }

        const fallback = await authedInject(fx.app, {
          method: "PATCH",
          url: "/api/profile/fallback",
          bearer,
          payload: { enabled: true, chain: [...MODELS] },
        });
        expect(fallback.statusCode, fallback.body).toBe(200);
        expect(fallback.json<{ enabled: boolean; chain: string[] }>()).toEqual({
          enabled: true,
          chain: [...MODELS],
        });

        for (const modelId of MODELS) {
          const selected = await authedInject(fx.app, {
            method: "PUT",
            url: `/api/rooms/${fx.defaultRoomId}/agents/${fx.defaultAgentId}/model-control-selection`,
            bearer,
            payload: { selection: { modelId } },
          });
          expect(selected.statusCode, `${fundingPreference}: ${modelId}: ${selected.body}`)
            .toBe(200);
          expect(selected.json<{ selection: { modelId: string } }>().selection)
            .toEqual({ modelId });

          const read = await authedInject(fx.app, {
            method: "GET",
            url: `/api/rooms/${fx.defaultRoomId}/agents/${fx.defaultAgentId}/model-control-selection`,
            bearer,
          });
          expect(read.statusCode, read.body).toBe(200);
          expect(read.json<{ selection: { modelId: string } }>().selection)
            .toEqual({ modelId });
        }
      }
    } finally {
      try {
        if (fx && bearer) {
          for (const provider of ["openrouter", "anthropic"] as const) {
            const expectedRevision = credentialRevisions.get(provider);
            if (expectedRevision !== undefined) {
              await authedInject(fx.app, {
                method: "DELETE",
                url: `/api/account/provider-credentials/${provider}`,
                bearer,
                payload: { expectedRevision },
              });
            }
          }
        }
      } finally {
        try {
          if (fx && priorPolicy) {
            await upsertServerProviderPolicy(fx.db, priorPolicy);
          }
        } finally {
          try {
            if (fx) await fx.cleanup();
          } finally {
            globalThis.fetch = priorFetch;
            restoreEnv("ANTHROPIC_API_KEY", priorEnv.anthropic);
            restoreEnv("FIREWORKS_API_KEY", priorEnv.fireworks);
            restoreEnv("OPENROUTER_API_KEY", priorEnv.openrouter);
          }
        }
      }
    }
  });
});
