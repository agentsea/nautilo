/**
 * M120 — POST /api/account/password/recover-with-code route contract (no DB).
 *
 * The route no longer sets a password; it opens a recovery session and
 * returns the Logto reset URL + session token. A stale client that still
 * sends `newPassword` must be tolerated, not rejected.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { OpenRecoverySessionResult } from "../../src/lib/logto-recover-with-code";

const openLogtoRecoverySession = mock(
  (): Promise<OpenRecoverySessionResult> =>
    Promise.resolve({
      outcome: "success",
      sessionId: "sess-1",
      sessionToken: "tok-1",
      resetUrl: "https://logto.example/forgot-password",
      email: "alice@nautilo.local",
    }),
);
const markRecoveryCodeUsed = mock(() => Promise.resolve(true));
const markPasswordRecoveryCompleted = mock(() => Promise.resolve(true));

mock.module("../../src/lib/logto-recover-with-code", () => ({
  openLogtoRecoverySession,
}));

// The route also imports the recovery-session relay helper; keep it real
// (it is a pure in-memory module). Drive it directly to exercise the relay route.
import { accountRoutes } from "../../src/routes/account";
import {
  createRecoverySession,
  bindCodeForEmail,
  resetRecoverySessionsForTests,
} from "../../src/lib/logto-recovery-session";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";

beforeEach(() => {
  process.env["LOGTO_ENDPOINT"] = "https://logto.example";
  // The route constructs a LogtoAdminClient (passed to the mocked
  // openLogtoRecoverySession), so the M2M env must be present even though
  // no real Logto call is made.
  process.env["LOGTO_M2M_APP_ID"] = "test-m2m-id";
  process.env["LOGTO_M2M_APP_SECRET"] = "test-m2m-secret";
  delete process.env["NAUTILO_PUBLIC_BASE_URL"];
});

afterEach(() => {
  openLogtoRecoverySession.mockClear();
  markRecoveryCodeUsed.mockClear();
  markPasswordRecoveryCompleted.mockClear();
  resetRecoverySessionsForTests();
  delete process.env["LOGTO_ENDPOINT"];
  delete process.env["LOGTO_M2M_APP_ID"];
  delete process.env["LOGTO_M2M_APP_SECRET"];
  delete process.env["NAUTILO_PUBLIC_BASE_URL"];
});

async function makeApp(auditRows?: SecurityAuditEvent[], sessionUserId?: string) {
  const app = Fastify({ logger: false });
  if (sessionUserId) {
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = sessionUserId;
    });
  }
  accountRoutes(app, {
    markRecoveryCodeUsed,
    markPasswordRecoveryCompleted,
    ...(auditRows
      ? {
          auditEvent: (event) => {
            auditRows.push(event);
          },
        }
      : {}),
  });
  await app.ready();
  return app;
}

describe("POST /api/account/password/recover-with-code (M120)", () => {
  test("rejects legacy { email } payload (no handle) and does not open a session", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json" },
      payload: { email: "alice@example.com", recoveryCode: "12345678" },
      remoteAddress: "127.0.0.1",
    });

    expect(res.statusCode).toBe(400);
    expect(openLogtoRecoverySession).not.toHaveBeenCalled();
    await app.close();
  });

  test("happy path returns session + reset URL, never a password field", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json" },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "127.0.0.1",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      sessionId: "sess-1",
      sessionToken: "tok-1",
      resetUrl: "https://logto.example/forgot-password",
      email: "alice@nautilo.local",
    });
    expect(openLogtoRecoverySession).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test("tolerates a stale client that still sends newPassword (ignored, still succeeds)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json" },
      payload: { handle: "alice", recoveryCode: "abcd1234", newPassword: "P@ssw0rd1" },
      remoteAddress: "127.0.0.1",
    });

    expect(res.statusCode).toBe(200);
    const calls = openLogtoRecoverySession.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    const callArg = calls[0]?.[0] ?? {};
    expect(callArg).not.toHaveProperty("newPassword");
    await app.close();
  });

  test("reject outcome → generic 400", async () => {
    openLogtoRecoverySession.mockResolvedValueOnce({ outcome: "reject" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json" },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  test("logto_unavailable outcome → 502", async () => {
    openLogtoRecoverySession.mockResolvedValueOnce({ outcome: "logto_unavailable" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json" },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  test("unexpected error → 500 and redacted JSONL audit row", async () => {
    openLogtoRecoverySession.mockImplementationOnce(() => {
      throw new Error("boom with sensitive details");
    });
    const auditRows: SecurityAuditEvent[] = [];
    const app = await makeApp(auditRows);
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json", "user-agent": "test-agent" },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(500);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      kind: "recovery_session_rejected",
      actorId: null,
      ip: "127.0.0.1",
      userAgent: "test-agent",
      reason: "unexpected_error",
    });
    expect(JSON.stringify(auditRows[0])).not.toContain("abcd1234");
    expect(JSON.stringify(auditRows[0])).not.toContain("boom");
    await app.close();
  });

  test("non-localhost IP → 403", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: { "content-type": "application/json" },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "203.0.113.7",
    });
    expect(res.statusCode).toBe(403);
    expect(openLogtoRecoverySession).not.toHaveBeenCalled();
    await app.close();
  });

  test("local compose bridge IP with loopback Host is allowed", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: {
        "content-type": "application/json",
        host: "localhost:3101",
      },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "172.18.0.1",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  test("loopback Host does not bypass gate when public base URL is configured", async () => {
    process.env["NAUTILO_PUBLIC_BASE_URL"] = "https://upgrade.example.test";
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recover-with-code",
      headers: {
        "content-type": "application/json",
        host: "localhost:3101",
      },
      payload: { handle: "alice", recoveryCode: "abcd1234" },
      remoteAddress: "172.18.0.1",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/account/password/recovery-relay/:sessionId (M120)", () => {
  function makeSession() {
    const s = createRecoverySession({
      userId: "u1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    return s;
  }

  test("missing bearer → 400, no code", async () => {
    const s = makeSession();
    bindCodeForEmail("alice@nautilo.local", "424242");
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("424242");
    await app.close();
  });

  test("wrong bearer → 404, no code (no oracle vs unknown session)", async () => {
    const s = makeSession();
    bindCodeForEmail("alice@nautilo.local", "424242");
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: "Bearer not-the-token" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("424242");
    await app.close();
  });

  test("unknown session → 404", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/account/password/recovery-relay/does-not-exist",
      headers: { authorization: "Bearer whatever" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test("valid token, code not yet delivered → pending", async () => {
    const s = makeSession();
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "pending" });
    await app.close();
  });

  test("valid token after delivery → ready with code", async () => {
    const s = makeSession();
    bindCodeForEmail("alice@nautilo.local", "424242");
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ready", code: "424242" });
    expect(markRecoveryCodeUsed).toHaveBeenCalledWith({
      userId: "u1",
      recoveryCodeRowId: "rc1",
    });
    await app.close();
  });

  test("second valid read from same session returns code without burning again", async () => {
    const s = makeSession();
    bindCodeForEmail("alice@nautilo.local", "424242");
    const app = await makeApp();
    const first = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
      remoteAddress: "127.0.0.1",
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ status: "ready", code: "424242" });
    expect(markRecoveryCodeUsed).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test("already-consumed recovery code row denies first relay read", async () => {
    markRecoveryCodeUsed.mockResolvedValueOnce(false);
    const s = makeSession();
    bindCodeForEmail("alice@nautilo.local", "424242");
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("424242");
    await app.close();
  });

  test("non-localhost IP → 403", async () => {
    const s = makeSession();
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: { authorization: `Bearer ${s.sessionToken}` },
      remoteAddress: "203.0.113.7",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  test("local compose bridge IP with loopback Host can poll relay", async () => {
    const s = makeSession();
    bindCodeForEmail("alice@nautilo.local", "424242");
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${s.id}`,
      headers: {
        authorization: `Bearer ${s.sessionToken}`,
        host: "localhost:3101",
      },
      remoteAddress: "172.18.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ready", code: "424242" });
    await app.close();
  });
});

describe("POST /api/account/password/recovery-completed (M120)", () => {
  test("requires auth", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recovery-completed",
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(markPasswordRecoveryCompleted).not.toHaveBeenCalled();
    await app.close();
  });

  test("authenticated caller clears forced password-change flag", async () => {
    const app = await makeApp(undefined, "user-1");
    const session = createRecoverySession({
      userId: "user-1",
      syntheticEmail: "alice@nautilo.local",
      recoveryCodeRowId: "rc1",
    });
    bindCodeForEmail("alice@nautilo.local", "424242");
    const relay = await app.inject({
      method: "GET",
      url: `/api/account/password/recovery-relay/${session.id}`,
      headers: { authorization: `Bearer ${session.sessionToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(relay.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recovery-completed",
      headers: { "content-type": "application/json" },
      payload: {
        sessionId: session.id,
        sessionToken: session.sessionToken,
      },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(markPasswordRecoveryCompleted).toHaveBeenCalledWith("user-1");
    await app.close();
  });

  test("authenticated caller cannot clear flag without consumed relay proof", async () => {
    const app = await makeApp(undefined, "user-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/account/password/recovery-completed",
      headers: { "content-type": "application/json" },
      payload: {
        sessionId: "missing",
        sessionToken: "missing",
      },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(404);
    expect(markPasswordRecoveryCompleted).not.toHaveBeenCalled();
    await app.close();
  });
});
