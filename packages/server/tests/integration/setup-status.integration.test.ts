import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;
let baseUrl: string;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "d112ss" });
  baseUrl = await fx.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await fx.cleanup();
});

describe("GET /api/setup/status (D112)", () => {
  test("redacted response without bearer", async () => {
    const client = new NautiloApiClient(baseUrl.replace(/\/$/, ""));
    const body = await client.getSetupStatus();
    expect(body.setupState).toBeDefined();
    expect(typeof body.claimRequired).toBe("boolean");
    expect(body.viewer).toBeUndefined();
    expect(body.providers).toBeUndefined();
    expect(body.recommendedSetupSurface?.kind).toBeDefined();
  });

  test("authenticated response includes viewer and providers", async () => {
    const client = new NautiloApiClient(baseUrl.replace(/\/$/, ""));
    client.setToken(await fx.mintOwnerBearer());
    const body = await client.getSetupStatus();
    expect(body.viewer).toBeDefined();
    expect(body.viewer?.canManageServerSettings).toBe(true);
    expect(body.providers).toBeDefined();
    expect(typeof body.providers?.hasLlm).toBe("boolean");
    expect(body.recommendedSetupSurface?.kind).toBeDefined();
  });
});
