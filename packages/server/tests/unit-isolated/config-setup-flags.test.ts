import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type { ImageModelConfig } from "@nautilo/agent";
import { configRoutes, type ConfigRouteDeps } from "../../src/routes/config";

const openaiModel: ImageModelConfig = {
  id: "openai:gpt-image-2",
  apiModel: "gpt-image-2",
  displayName: "GPT Image 2",
  provider: "openai",
  enabled: true,
};

const googleModel: ImageModelConfig = {
  id: "google:gemini-2.5-flash-image",
  apiModel: "gemini-2.5-flash-image",
  displayName: "Gemini 2.5 Flash Image",
  provider: "google",
  enabled: true,
};

async function setupFlags(deps: ConfigRouteDeps): Promise<Record<string, unknown>> {
  const app = Fastify({ logger: false });
  configRoutes(app, deps);
  try {
    const response = await app.inject({ method: "GET", url: "/api/config/setup-flags" });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

function depsFor(model: ImageModelConfig, keys: Partial<Record<ImageModelConfig["provider"], string>>): ConfigRouteDeps {
  return {
    getDefaultImageModel: () => model,
    resolveProviderKey: (provider) => {
      if (provider === "openai") return keys.openai ?? null;
      if (provider === "google") return keys.google ?? null;
      return null;
    },
  };
}

describe("GET /api/config/setup-flags avatarGenAvail", () => {
  test("is true for an OpenAI default image model with an OpenAI key", async () => {
    const flags = await setupFlags(depsFor(openaiModel, { openai: "configured" }));
    expect(flags).toMatchObject({ avatarGenAvail: true });
    expect(typeof flags["motherEasterEgg"]).toBe("boolean");
  });

  test("is false for an OpenAI default image model without an OpenAI key", async () => {
    const flags = await setupFlags(depsFor(openaiModel, {}));
    expect(flags).toMatchObject({ avatarGenAvail: false });
  });

  test("is true for a Google default image model with a Google key", async () => {
    const flags = await setupFlags(depsFor(googleModel, { google: "configured" }));
    expect(flags).toMatchObject({ avatarGenAvail: true });
  });

  test("is false when only the non-selected provider has a key", async () => {
    const flags = await setupFlags(depsFor(googleModel, { openai: "configured" }));
    expect(flags).toMatchObject({ avatarGenAvail: false });
  });

  test("fails closed when the default image model cannot be resolved", async () => {
    const flags = await setupFlags({
      getDefaultImageModel: () => {
        throw new Error("no image model configured");
      },
      resolveProviderKey: () => "configured",
    });
    expect(flags).toMatchObject({ avatarGenAvail: false });
  });
});
