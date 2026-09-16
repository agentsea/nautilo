/**
 * M120 — Logto HTTP Email connector receiver + recovery-session binding.
 *
 * Security posture is load-bearing: Logto's verification code must never be
 * accepted without the connector bearer secret, must not be echoed from the
 * POST handler, and must only be readable through the session-token relay —
 * never from the webhook endpoint itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { logtoInternalRoutes } from "../../src/routes/logto-internal";
import { NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV } from "../../src/lib/logto-http-email-webhook";
import {
  createRecoverySession,
  consumeCodeForSession,
  resetRecoverySessionsForTests,
} from "../../src/lib/logto-recovery-session";

const SECRET = "test-secret-that-is-long-enough";

afterEach(() => {
  delete process.env[NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV];
  resetRecoverySessionsForTests();
});

describe("Logto HTTP Email webhook (M120)", () => {
  test("rejects missing and wrong bearer without binding the code", async () => {
    process.env[NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV] = SECRET;
    const session = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    const app = await makeApp();
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/internal/logto/email-webhook",
        payload: forgotPasswordPayload("111222"),
      });
      const wrong = await app.inject({
        method: "POST",
        url: "/api/internal/logto/email-webhook",
        headers: { authorization: "Bearer wrong-secret" },
        payload: forgotPasswordPayload("333444"),
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      // No code bound to the session despite two posts.
      expect(consumeCodeForSession(session.id, session.sessionToken)).toEqual({
        status: "pending",
      });
    } finally {
      await app.close();
    }
  });

  test("binds ForgotPassword code to the matching session but redacts the response", async () => {
    process.env[NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV] = SECRET;
    const session = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    const app = await makeApp();
    try {
      const post = await app.inject({
        method: "POST",
        url: "/api/internal/logto/email-webhook",
        headers: authHeaders(),
        payload: forgotPasswordPayload("654321"),
      });
      const body = JSON.parse(post.body) as Record<string, unknown>;

      expect(post.statusCode).toBe(202);
      expect(body).toMatchObject({
        ok: true,
        to: "alice@nautilo.local",
        type: "ForgotPassword",
      });
      // The code is never echoed, and there is no `bound` oracle.
      expect(JSON.stringify(body)).not.toContain("654321");
      expect(body).not.toHaveProperty("code");
      expect(body).not.toHaveProperty("bound");
      // The code is readable only through the session relay.
      expect(consumeCodeForSession(session.id, session.sessionToken)).toMatchObject({
        status: "ready",
        code: "654321",
      });
    } finally {
      await app.close();
    }
  });

  test("acks (202) even when no session matches, without leaking a miss", async () => {
    process.env[NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV] = SECRET;
    const app = await makeApp();
    try {
      const post = await app.inject({
        method: "POST",
        url: "/api/internal/logto/email-webhook",
        headers: authHeaders(),
        payload: forgotPasswordPayload("999000"),
      });
      expect(post.statusCode).toBe(202);
      const body = JSON.parse(post.body) as Record<string, unknown>;
      expect(body).not.toHaveProperty("bound");
      expect(JSON.stringify(body)).not.toContain("999000");
    } finally {
      await app.close();
    }
  });

  test("rejects non-ForgotPassword email payloads", async () => {
    process.env[NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET_ENV] = SECRET;
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/logto/email-webhook",
        headers: authHeaders(),
        payload: {
          to: "alice@nautilo.local",
          type: "SignIn",
          payload: { code: "123456" },
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain("123456");
    } finally {
      await app.close();
    }
  });

  test("stays closed when webhook secret is unset", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/logto/email-webhook",
        headers: authHeaders(),
        payload: forgotPasswordPayload("123456"),
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

async function makeApp() {
  const app = Fastify({ logger: false });
  logtoInternalRoutes(app);
  await app.ready();
  return app;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${SECRET}` };
}

function forgotPasswordPayload(code: string) {
  return {
    to: "alice@nautilo.local",
    type: "ForgotPassword",
    payload: { code },
    ip: "203.0.113.10",
  };
}
