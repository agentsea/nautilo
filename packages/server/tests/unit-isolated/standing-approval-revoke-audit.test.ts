/**
 * D235 Phase 2 — DELETE /api/security/standing-approvals/:id audit contract.
 *
 * Hermetic route test: stubs `listCommandApprovals` / `revokeCommandApproval`
 * so we exercise the handler's pre-read → revoke → safeAudit ordering without
 * Postgres. Lives in unit-isolated/ because Bun's mock.module is process-global.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

const RULE_ID = "rule-abc-123";
const OTHER_RULE_ID = "rule-other-456";
const ROOM_ID = "room-xyz-789";

let listCommandApprovalsImpl: (
  userId: string,
) => Promise<
  Array<{
    id: string;
    scope: "room" | "server";
    roomId: string | null;
    roomLabel: string | null;
    toolPattern: string;
    label: string;
    approvalKind: "tool" | "capability";
    capabilitySlug: string | null;
    active: boolean;
    createdAt: string;
  }>
> = async () => [];

const revokeCommandApprovalCalls: Array<{ id: string; userId: string }> = [];

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    listCommandApprovals: (userId: string) => listCommandApprovalsImpl(userId),
    revokeCommandApproval: async (id: string, userId: string) => {
      revokeCommandApprovalCalls.push({ id, userId });
    },
  };
});

import type { ChallengeProvider } from "@nautilo/trust";
import { securityRoutes } from "../../src/routes/security";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";
import { SessionStore } from "../helpers/test-session-store";

const OWNER_ACTOR_ID = "owner-actor";
const OWNER_USER_ID = "owner-user";

function installBearerSessionPreHandler(
  app: FastifyInstance,
  store: SessionStore,
): void {
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const session = token ? store.validateSession(token) : null;
    if (!session) return;
    request.sessionUserId = session.userId;
    request.sessionActorId = session.actorId;
    request.policyContext = {
      actorRole: session.userId === session.ownerId ? "owner" : "guest",
      actorLabel: "owner",
    } as unknown as typeof request.policyContext;
  });
}

class NoopChallengeProvider implements ChallengeProvider {
  verifyProof(): Promise<boolean> {
    return Promise.resolve(false);
  }
  isEnrolled(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

let app: FastifyInstance;
let sessionStore: SessionStore;
let ownerToken: string;
let auditCalls: SecurityAuditEvent[] = [];

beforeAll(async () => {
  sessionStore = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installBearerSessionPreHandler(app, sessionStore);
  securityRoutes(app, {
    pinProvider: new NoopChallengeProvider(),
    mutatePosture: async () => {
      /* not exercised */
    },
    auditEvent: async (event) => {
      auditCalls.push(event);
    },
    getCapabilities: async () => [],
    now: () => new Date("2026-06-15T12:00:00.000Z"),
  });
  await app.ready();

  ownerToken = sessionStore.createSession(
    OWNER_ACTOR_ID,
    OWNER_USER_ID,
    OWNER_USER_ID,
  ).token;
});

beforeEach(() => {
  auditCalls = [];
  revokeCommandApprovalCalls.length = 0;
  listCommandApprovalsImpl = async (userId) => {
    if (userId !== OWNER_USER_ID) return [];
    return [
      {
        id: RULE_ID,
        scope: "room",
        roomId: ROOM_ID,
        roomLabel: "#proj",
        toolPattern: "shell",
        label: "shell: ls /proj/**",
        approvalKind: "tool",
        capabilitySlug: null,
        active: true,
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ];
  };
});

afterAll(async () => {
  if (app) await app.close();
});

describe("DELETE /api/security/standing-approvals/:id — standing_approval_revoked audit", () => {
  test("revoking the caller's rule writes exactly one audit row with actor + ruleId", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/security/standing-approvals/${RULE_ID}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: { ok: boolean } = res.json();
    expect(body).toEqual({ ok: true });
    expect(revokeCommandApprovalCalls).toEqual([
      { id: RULE_ID, userId: OWNER_USER_ID },
    ]);
    expect(auditCalls).toHaveLength(1);
    const row = auditCalls[0]!;
    expect(row.kind).toBe("standing_approval_revoked");
    if (row.kind !== "standing_approval_revoked") throw new Error("narrow");
    expect(row.actorUserId).toBe(OWNER_USER_ID);
    expect(row.actorId).toBe(OWNER_ACTOR_ID);
    expect(row.ruleId).toBe(RULE_ID);
    expect(row.scope).toBe("room");
    expect(row.roomId).toBe(ROOM_ID);
    expect(row.label).toBe("shell: ls /proj/**");
    expect(row.toolPattern).toBe("shell");
    expect(row.ts).toBe("2026-06-15T12:00:00.000Z");
    expect(row.route).toBe("DELETE /api/security/standing-approvals/:id");
  });

  test("revoking an id that is not the caller's writes no audit row", async () => {
    listCommandApprovalsImpl = async () => [];

    const res = await app.inject({
      method: "DELETE",
      url: `/api/security/standing-approvals/${OTHER_RULE_ID}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: { ok: boolean } = res.json();
    expect(body).toEqual({ ok: true });
    expect(revokeCommandApprovalCalls).toEqual([
      { id: OTHER_RULE_ID, userId: OWNER_USER_ID },
    ]);
    expect(auditCalls).toHaveLength(0);
  });

  test("thrown auditor does not block the 200 response", async () => {
    const throwingApp = Fastify({ logger: false });
    const throwingStore = new SessionStore(undefined, { persistPath: null });
    installBearerSessionPreHandler(throwingApp, throwingStore);
    const token = throwingStore.createSession(
      OWNER_ACTOR_ID,
      OWNER_USER_ID,
      OWNER_USER_ID,
    ).token;
    securityRoutes(throwingApp, {
      pinProvider: new NoopChallengeProvider(),
      mutatePosture: async () => {
        /* not exercised */
      },
      auditEvent: async () => {
        throw new Error("synthetic auditor failure");
      },
      getCapabilities: async () => [],
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });
    await throwingApp.ready();

    const res = await throwingApp.inject({
      method: "DELETE",
      url: `/api/security/standing-approvals/${RULE_ID}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body: { ok: boolean } = res.json();
    expect(body).toEqual({ ok: true });

    await throwingApp.close();
  });
});
