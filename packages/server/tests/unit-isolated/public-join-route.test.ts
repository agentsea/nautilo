import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  publicJoinInviteToken,
  publicJoinRoutes,
} from "../../src/routes/public-join";

describe("public community join route", () => {
  test("redirects the stable entry to the configured ordinary invite on the same origin", async () => {
    const app = Fastify();
    publicJoinRoutes(app, { inviteToken: `inv_${"a".repeat(32)}` });

    const response = await app.inject({ method: "GET", url: "/join" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/redeem/inv_${"a".repeat(32)}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    await app.close();
  });

  test("reports unavailable without exposing invalid configuration", async () => {
    const app = Fastify();
    publicJoinRoutes(app, { inviteToken: "not-an-invite" });

    const response = await app.inject({ method: "GET", url: "/join" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Community enrollment is unavailable");
    expect(response.body).not.toContain("not-an-invite");
    await app.close();
  });

  test("accepts only the canonical ordinary invite token shape", () => {
    expect(publicJoinInviteToken(` inv_${"Z".repeat(32)} `)).toBe(`inv_${"Z".repeat(32)}`);
    expect(publicJoinInviteToken(`inv_${"a".repeat(31)}`)).toBeNull();
    expect(publicJoinInviteToken(`inv_${"a".repeat(33)}`)).toBeNull();
    expect(publicJoinInviteToken(undefined)).toBeNull();
  });
});
