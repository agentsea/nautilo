import { expect, mock, test } from "bun:test";
import Fastify from "fastify";
import { enrollmentReviewRoutes } from "../../src/routes/enrollment-review";
import { ModerationError, type verifyLogtoAccessToken } from "@nautilo/trust";

const token = `inv_${"a".repeat(32)}`;
function fixture() {
  const review = mock(async (_input: unknown) => ({ required: true, paused: false, state: "pending" as const, message: "Join and learn.", revision: 1 }));
  const verify = mock(async (bearer: string) => {
    if (bearer !== "verified-fixture") throw new Error("Invalid bearer");
    return { sub: "verified-subject" } as Awaited<ReturnType<typeof verifyLogtoAccessToken>>;
  });
  const app = Fastify();
  enrollmentReviewRoutes(app, { verify, review, rateLimit: () => true });
  const headers = { authorization: "Bearer verified-fixture" };
  return { app, review, verify, headers, url: `/api/invites/${token}/enrollment-review` };
}

test("pending applicant route rejects missing or invalid bearer before reading requests", async () => {
  const f = fixture(); try {
    expect((await f.app.inject({ url: f.url })).statusCode).toBe(401);
    expect((await f.app.inject({ url: f.url, headers: { authorization: "Bearer invalid" } })).statusCode).toBe(401);
    expect(f.review).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

test("empty messages and caller-supplied identity cannot become requests", async () => {
  const f = fixture(); try {
    for (const payload of [{ message: " \n " }, {}, { message: "Hello", userId: "someone-else" }]) {
      expect((await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload })).statusCode).toBe(400);
    }
    expect(f.review).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

test("request identity comes only from verified bearer, and responses cannot be cached", async () => {
  const f = fixture(); try {
    const response = await f.app.inject({ method: "POST", url: f.url, headers: f.headers, payload: { message: "  Join and learn.  " } });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.review.mock.calls[0]?.[0]).toMatchObject({ subject: "verified-subject", inviteToken: token, message: "Join and learn." });
  } finally { await f.app.close(); }
});

test("known bans and service outages never grant entry", async () => {
  const f = fixture(); try {
    f.review.mockImplementation(async () => { throw new ModerationError("active_ban"); });
    expect((await f.app.inject({ url: f.url, headers: f.headers })).statusCode).toBe(403);
    f.review.mockImplementation(async () => { throw new Error("Private fixture diagnostic"); });
    const response = await f.app.inject({ url: f.url, headers: f.headers });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("Private fixture");
  } finally { await f.app.close(); }
});
