import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  createDirectDb,
  ensureDatabase,
  eq,
  serverProfile,
  upsertServerProfile,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { serverIconRoutes } from "../../src/routes/server-icon";
import {
  PRESET_IDS,
  presetAssetPath,
} from "../../src/routes/server-icon-presets";

bootstrapTestDbInstance();
const db = createDirectDb(1);
const app = Fastify({ logger: false });
serverIconRoutes(app);

beforeAll(async () => {
  await ensureDatabase();
});

afterAll(async () => {
  await db.delete(serverProfile).where(eq(serverProfile.id, "server"));
  await app.close();
  await db.end();
});

describe("server icon preset allowlist", () => {
  test("every canonical preset has non-empty bundled bytes and serves as PNG", async () => {
    for (const id of PRESET_IDS) {
      const assetPath = presetAssetPath(id);
      expect(assetPath).not.toBeNull();
      expect(statSync(assetPath!).size).toBeGreaterThan(0);

      await upsertServerProfile(db, { icon: { kind: "preset", id } });
      const response = await app.inject({ method: "GET", url: "/api/server/icon" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toStartWith("image/png");
      expect(response.headers.etag).toBe(`"${id}"`);
      expect(response.rawPayload.byteLength).toBeGreaterThan(0);
    }
  });

  test("legacy server-default remains a serving-only alias", async () => {
    await upsertServerProfile(db, {
      icon: { kind: "preset", id: "server-default" },
    });
    const response = await app.inject({ method: "GET", url: "/api/server/icon" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toStartWith("image/png");
    expect(response.headers.etag).toBe('"server-default"');
  });

  test("unknown preset IDs fail closed with 404", async () => {
    expect(presetAssetPath("preset-does-not-exist")).toBeNull();
    await upsertServerProfile(db, {
      icon: { kind: "preset", id: "preset-does-not-exist" },
    });
    const response = await app.inject({ method: "GET", url: "/api/server/icon" });
    expect(response.statusCode).toBe(404);
  });
});
