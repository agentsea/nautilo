/**
 * The server integration runner executes every file in its own Bun process,
 * which contains this file's sticky `mock.module("@nautilo/trust", …)`.
 */
/**
 * M120 — openLogtoRecoverySession orchestration (real Postgres + mocked trust
 * code verification). Never mock `@nautilo/db`: Bun's `mock.module` is
 * process-global and downstream modules bind `db` at import time.
 *
 * Asserts the recovery-code verification contract and that a successful run
 * opens a relay session bound to the user's synthetic email. The new password
 * is never part of this path — it is set entirely inside Logto.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createDirectDb, ensureDatabase, users, eq } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

const TEST_EMAIL = "logto-recover-unit@test.local";

const HANDLE_UNLINKED = "lr_unlinked";
const HANDLE_LINKED = "lr_linked";
const HANDLE_LOGTO_DOWN = "lr_down";
const HANDLE_MISSING = "lr_missing";

const LOGTO_ENDPOINT = "https://logto.example";

const verifyCalls: string[] = [];
const releaseCalls: string[] = [];

let poolDb: ReturnType<typeof createDirectDb>;
const PREV_WORKBENCH_APP_ID = process.env["LOGTO_WORKBENCH_APP_ID"];
const PREV_PUBLIC_BASE_URL = process.env["NAUTILO_PUBLIC_BASE_URL"];

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["LOGTO_WORKBENCH_APP_ID"] = "workbench-client";
  process.env["NAUTILO_PUBLIC_BASE_URL"] = "http://localhost:3101";
  await ensureDatabase();
  poolDb = createDirectDb(1);
});

beforeEach(async () => {
  mock.restore();
  verifyCalls.length = 0;
  releaseCalls.length = 0;
  await poolDb.delete(users).where(eq(users.email, TEST_EMAIL));

  const realTrust = await import("@nautilo/trust");
  mock.module("@nautilo/trust", () => ({
    ...realTrust,
    findMatchingUnusedLogtoAccountRecoveryCode: async (_userId: string, code: string) => {
      verifyCalls.push(code);
      return code === "good" ? "row-1" : null;
    },
    releaseLogtoAccountRecoveryCode: async (_userId: string, id: string) => {
      releaseCalls.push(id);
    },
  }));
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  if (PREV_WORKBENCH_APP_ID === undefined) delete process.env["LOGTO_WORKBENCH_APP_ID"];
  else process.env["LOGTO_WORKBENCH_APP_ID"] = PREV_WORKBENCH_APP_ID;
  if (PREV_PUBLIC_BASE_URL === undefined) delete process.env["NAUTILO_PUBLIC_BASE_URL"];
  else process.env["NAUTILO_PUBLIC_BASE_URL"] = PREV_PUBLIC_BASE_URL;
  if (poolDb) {
    await poolDb.delete(users).where(eq(users.email, TEST_EMAIL));
    await poolDb.end();
  }
});

// Admin shaped for ensureLogtoPrimaryEmail: getUser + patchUser.
function adminWithEmail(email: string | null) {
  return {
    getUser: async () => ({
      id: "logto-sub",
      isSuspended: false,
      primaryEmail: email,
      username: "lr",
    }),
    patchUser: async () => 200,
  };
}

describe("openLogtoRecoverySession (M120)", () => {
  test("reject when no user row (code not checked)", async () => {
    const { openLogtoRecoverySession } = await import("../../src/lib/logto-recover-with-code");
    const r = await openLogtoRecoverySession({
      handle: HANDLE_MISSING,
      recoveryCode: "good",
      admin: adminWithEmail("x@nautilo.local"),
      logtoEndpoint: LOGTO_ENDPOINT,
    });
    expect(r).toEqual({ outcome: "reject" });
    expect(verifyCalls).toHaveLength(0);
  });

  test("reject when user not Logto-linked", async () => {
    await poolDb.insert(users).values({
      name: "lr",
      email: TEST_EMAIL,
      handle: HANDLE_UNLINKED,
      externalId: null,
      server: null,
    });
    const { openLogtoRecoverySession } = await import("../../src/lib/logto-recover-with-code");
    const r = await openLogtoRecoverySession({
      handle: HANDLE_UNLINKED,
      recoveryCode: "good",
      admin: adminWithEmail("x@nautilo.local"),
      logtoEndpoint: LOGTO_ENDPOINT,
    });
    expect(r).toEqual({ outcome: "reject" });
  });

  test("success path verifies code and opens a session bound to the synthetic email", async () => {
    await poolDb.insert(users).values({
      name: "lr",
      email: TEST_EMAIL,
      handle: HANDLE_LINKED,
      externalId: "logto-sub",
      server: null,
    });
    const { openLogtoRecoverySession } = await import("../../src/lib/logto-recover-with-code");
    const { bindCodeForEmail, consumeCodeForSession } = await import(
      "../../src/lib/logto-recovery-session"
    );
    const r = await openLogtoRecoverySession({
      handle: HANDLE_LINKED,
      recoveryCode: "good",
      admin: adminWithEmail("lr@nautilo.local"),
      logtoEndpoint: LOGTO_ENDPOINT,
    });
    expect(r.outcome).toBe("success");
    if (r.outcome !== "success") return;
    expect(r.email).toBe("lr@nautilo.local");
    const resetUrl = new URL(r.resetUrl);
    expect(resetUrl.origin).toBe("https://logto.example");
    expect(resetUrl.pathname).toBe("/oidc/auth");
    expect(resetUrl.searchParams.get("client_id")).toBe("workbench-client");
    expect(resetUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3101/auth/callback");
    expect(resetUrl.searchParams.get("first_screen")).toBe("reset_password");
    expect(resetUrl.searchParams.get("identifier")).toBe("email");
    expect(resetUrl.searchParams.get("login_hint")).toBe("lr@nautilo.local");
    expect(resetUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(verifyCalls).toEqual(["good"]);
    expect(releaseCalls).toHaveLength(0);

    // A code delivered for that email becomes readable via the session token.
    expect(bindCodeForEmail("lr@nautilo.local", "778899")).toBe(true);
    expect(consumeCodeForSession(r.sessionId, r.sessionToken)).toMatchObject({
      status: "ready",
      code: "778899",
    });
  });

  test("logto_unavailable does not burn code when email backfill fails", async () => {
    await poolDb.insert(users).values({
      name: "lr",
      email: TEST_EMAIL,
      handle: HANDLE_LOGTO_DOWN,
      externalId: "logto-sub",
      server: null,
    });
    const { openLogtoRecoverySession } = await import("../../src/lib/logto-recover-with-code");
    const r = await openLogtoRecoverySession({
      handle: HANDLE_LOGTO_DOWN,
      recoveryCode: "good",
      admin: {
        getUser: async () => {
          throw new Error("Logto getUser failed: 503 timeout");
        },
        patchUser: async () => 200,
      },
      logtoEndpoint: LOGTO_ENDPOINT,
    });
    expect(r.outcome).toBe("logto_unavailable");
    expect(verifyCalls).toEqual(["good"]);
    expect(releaseCalls).toHaveLength(0);
  });
});
