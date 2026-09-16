/**
 * D124 — users.last_seen_at bump on authenticated HTTP requests.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect } from "bun:test";
import { eq, users } from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("D124 last_seen bump", () => {
  test("authenticated whoami bumps last_seen_at; anonymous health does not", async () => {
    if (process.env["AUTH_MODE"] === "logto") {
      return;
    }
    const fx = await setupOwnerAppFixture({
      suiteName: "lsb",
      withDefaultAgentGraph: true,
    });
    try {
      const token = await fx.mintOwnerBearer();
      await fx.db.update(users).set({ lastSeenAt: null }).where(eq(users.id, fx.ownerId));

      const res = await authedInject(fx.app, {
        method: "GET",
        url: "/api/auth/whoami",
        bearer: token,
      });
      expect(res.statusCode).toBe(200);

      await new Promise((r) => setTimeout(r, 150));

      const [row] = await fx.db
        .select({ lastSeenAt: users.lastSeenAt })
        .from(users)
        .where(eq(users.id, fx.ownerId));
      expect(row?.lastSeenAt).toBeTruthy();
      const seenAfterAuth = row!.lastSeenAt;
      if (!seenAfterAuth) throw new Error("lastSeenAt");

      const health = await fx.app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const [row2] = await fx.db
        .select({ lastSeenAt: users.lastSeenAt })
        .from(users)
        .where(eq(users.id, fx.ownerId));
      expect(row2?.lastSeenAt?.getTime()).toBe(seenAfterAuth.getTime());
    } finally {
      await fx.cleanup();
    }
  });
});
