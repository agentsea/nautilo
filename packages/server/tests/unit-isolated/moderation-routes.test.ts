import { randomUUID } from "node:crypto";
import { expect, mock, test } from "bun:test";
import Fastify from "fastify";
import { ModerationError } from "@nautilo/trust";
import { moderationRoutes } from "../../src/routes/moderation";

function fixture() {
  let session: string | null = randomUUID();
  let allowed = true;
  let enabled = true;
  const policy = { enabled: true, joinsPaused: false, approvalRequired: true, revision: 1 };
  const services: NonNullable<Parameters<typeof moderationRoutes>[1]["services"]> = {
    hasCapability: async () => allowed,
    policy: async () => ({ ...policy, enabled }),
    updatePolicy: async (_caller, input) => ({ ...input, revision: input.revision + 1 }),
    people: mock(async () => ({ items: [], next: null })),
    person: async () => { throw new ModerationError("target_unavailable"); },
    act: mock(async () => ({ operationId: randomUUID(), action: "ban" as const, roomId: null, restrictionId: randomUUID(), createdAt: new Date().toISOString(), expiresAt: null,
      committed: true as const, replayed: false, auditRecorded: true, converged: false })),
    receipt: async () => { throw new ModerationError("target_unavailable"); },
    reviews: mock(async () => ({ items: [], next: null })),
    decideReview: mock(async () => {}),
  };
  const policyChanged = mock(async () => {});
  const reviewDecided = mock(async () => {});
  const app = Fastify();
  app.addHook("onRequest", async request => { request.sessionUserId = session; });
  moderationRoutes(app, { services, policyChanged, reviewDecided, delivery: { issuer: "https://identity.example", appendAudit: async () => {}, converge: async () => "pending" } });
  return { app, services, policy, policyChanged, reviewDecided,
    setSession: (value: string | null) => { session = value; }, setAllowed: (value: boolean) => { allowed = value; }, setEnabled: (value: boolean) => { enabled = value; } };
}

test("moderation routes require an authenticated delegated grant", async () => {
  const f = fixture(); try {
    f.setSession(null); expect((await f.app.inject({ url: "/api/moderation/policy" })).statusCode).toBe(401);
    f.setSession(randomUUID()); f.setAllowed(false);
    expect((await f.app.inject({ url: "/api/moderation/policy" })).statusCode).toBe(403);
    f.setAllowed(true); const response = await f.app.inject({ url: "/api/moderation/policy" });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
  } finally { await f.app.close(); }
});

test("disabled controls and unsupported Room actions never reach mutation owner", async () => {
  const f = fixture(); try {
    f.setEnabled(false);
    expect((await f.app.inject({ method: "POST", url: "/api/moderation/actions", payload: { action: "ban", roomId: null } })).statusCode).toBe(409);
    f.setEnabled(true);
    for (const payload of [{ action: "ban", roomId: randomUUID() }, { action: "mute", roomId: null }]) {
      expect((await f.app.inject({ method: "POST", url: "/api/moderation/actions", payload })).statusCode).toBe(400);
    }
    expect(f.services.act).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

test("saved policy and review remain successful when audit projection fails", async () => {
  const f = fixture(); try {
    f.policyChanged.mockImplementation(async () => { throw new Error("Offline audit"); });
    f.reviewDecided.mockImplementation(async () => { throw new Error("Offline audit"); });
    const policy = await f.app.inject({ method: "PUT", url: "/api/moderation/policy", payload: f.policy });
    expect(policy.statusCode).toBe(200); expect(policy.json<{ auditRecorded: boolean }>().auditRecorded).toBe(false);
    const decision = await f.app.inject({ method: "POST", url: "/api/moderation/enrollment/decision", payload: {
      inviteId: randomUUID(), userId: randomUUID(), revision: 1, decision: "approved" } });
    expect(decision.statusCode).toBe(200); expect(decision.json<{ ok: boolean; auditRecorded: boolean }>()).toEqual({ ok: true, auditRecorded: false });
  } finally { await f.app.close(); }
});

test("review pagination rejects partial cursors and reuses the Admin directory bounds", async () => {
  const f = fixture(); try {
    for (const suffix of ["?limit=0", "?limit=101", `?afterInviteId=${randomUUID()}`]) {
      expect((await f.app.inject({ url: `/api/moderation/enrollment${suffix}` })).statusCode).toBe(400);
    }
    expect(f.services.reviews).not.toHaveBeenCalled();
    expect((await f.app.inject({ url: "/api/moderation/enrollment" })).statusCode).toBe(200);
  } finally { await f.app.close(); }
});

test("member search validates cursors, keeps directory paging, and requires a grant", async () => {
  const f = fixture(); try {
    expect((await f.app.inject({ url: "/api/moderation/people?search=member&after=broken" })).statusCode).toBe(400);
    expect((await f.app.inject({ url: "/api/moderation/people?search=" })).statusCode).toBe(400);
    f.setAllowed(false);
    expect((await f.app.inject({ url: "/api/moderation/people?search=member" })).statusCode).toBe(403);
    expect(f.services.people).not.toHaveBeenCalled();
    f.setAllowed(true);
    expect((await f.app.inject({ url: "/api/moderation/people?search=%40Member" })).statusCode).toBe(200);
    expect(f.services.people).toHaveBeenCalledWith(expect.any(String), { search: "@Member", limit: 50, after: undefined });
    expect((await f.app.inject({ url: "/api/moderation/people?search=member&activeOnly=true" })).statusCode).toBe(200);
    expect(f.services.people).toHaveBeenLastCalledWith(expect.any(String), { search: "member", limit: 50, activeOnly: true });
    expect((await f.app.inject({ url: "/api/moderation/people?search=member&activeOnly=invalid" })).statusCode).toBe(400);
    expect((await f.app.inject({ url: "/api/moderation/enrollment?search=robotics" })).statusCode).toBe(200);
    expect(f.services.reviews).toHaveBeenCalledWith(expect.any(String), { search: "robotics", limit: 50 });
  } finally { await f.app.close(); }
});
