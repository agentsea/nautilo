/**
 * D429 Phase 7.3 — server route integration for the runtime model catalog.
 *
 * Verifies the public GET API compatibility contract is preserved (the models
 * route still returns an array) and the new non-secret provenance diagnostic
 * route is reachable and never leaks delivery internals. Uses the disposable
 * scratch instance via the shared app fixture (never an operator-owned DB).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "modelcat" });
});

afterAll(async () => {
  if (fx) await fx.cleanup();
});

describe("D429 Phase 7 — model catalog routes", () => {
  test("GET /api/config/models still returns an array (public API compatibility)", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/config/models" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/config/catalog-provenance returns non-secret provenance", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/config/catalog-provenance" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      source: string;
      stale: boolean;
      catalogVersion: string | null;
    };
    expect(["remote-fresh", "remote-stale", "checked-in-fallback"]).toContain(body.source);
    expect(typeof body.stale).toBe("boolean");
    // Provenance is non-secret: no URL, host, key, or credential material.
    const raw = res.body;
    expect(raw).not.toContain("media.nautilo.ai");
    expect(raw).not.toContain("publicKeyB64");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("API_KEY");
  });
});
