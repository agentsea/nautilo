import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

describe("GET /api/setup/status bearer follow-up (D112 Phase 7)", () => {
  let fx: AppFixture;
  let baseUrl: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "d112r7def" });
    baseUrl = await fx.app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("returns setupState on GET /api/setup/status after owner session (redeem-class defense)", async () => {
    const client = new NautiloApiClient(baseUrl.replace(/\/$/, ""));
    client.setToken(await fx.mintOwnerBearer());
    const st = await client.getSetupStatus();
    expect(st.setupState).toBeDefined();
    expect(["ready", "server-needs-keys", "claimed-needs-auth", "fresh-unclaimed"]).toContain(
      st.setupState,
    );
  });
});
