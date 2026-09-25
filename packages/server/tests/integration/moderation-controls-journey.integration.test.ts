import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, invites, serverModerationPolicy } from "@nautilo/db";
import type { EnrollmentReviewStatus, ModerationPerson, ModerationReceipt, ServerModerationPolicy } from "@nautilo/types";
import { redeemInviteWithLogtoSub } from "../../src/lib/redeem-invite";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { cleanupInvitee } from "./helpers/invite-redeem-helpers";

// Real app registration, JWT verification, capability checks, transactions and
// access withdrawal. Only the external identity provider uses the shared fixture.
let fx: AppFixture;
let ownerBearer: string;
let originalPolicy: ServerModerationPolicy;
let auditDirectory: string;
const userIds: string[] = [];
const inviteIds: string[] = [];
const clientAddresses = new Map<string, string>();

beforeAll(async () => {
  auditDirectory = await mkdtemp(join(tmpdir(), "moderation-journey-"));
  fx = await setupOwnerAppFixture({ suiteName: "modjourney", createAppExtras: { securityAuditLogPath: join(auditDirectory, "audit.jsonl") } });
  ownerBearer = await fx.mintOwnerBearer();
  const response = await fx.app.inject({ url: "/api/moderation/policy", headers: { authorization: `Bearer ${ownerBearer}` } });
  expect(response.statusCode).toBe(200);
  originalPolicy = response.json<ServerModerationPolicy>();
}, 120_000);

afterAll(async () => {
  if (!fx) {
    if (auditDirectory) await rm(auditDirectory, { recursive: true, force: true });
    return;
  }
  if (originalPolicy) await fx.db.update(serverModerationPolicy).set(originalPolicy);
  for (const id of inviteIds) await fx.db.delete(invites).where(eq(invites.id, id));
  for (const id of userIds) await cleanupInvitee(fx, id);
  await fx.cleanup();
  await rm(auditDirectory, { recursive: true, force: true });
});

function request(method: "GET" | "POST" | "PUT", url: string, bearer: string, payload?: object) {
  // Model separate clients without disabling the production Invite IP limiter.
  const remoteAddress = clientAddresses.get(bearer) ?? `198.51.100.${clientAddresses.size + 1}`;
  clientAddresses.set(bearer, remoteAddress);
  return fx.app.inject({ method, url, remoteAddress, headers: { authorization: `Bearer ${bearer}` }, ...(payload ? { payload } : {}) });
}

test("wired controls gate a reusable invite, review each account, withdraw access and preserve bans", async () => {
  let response = await request("PUT", "/api/moderation/policy", ownerBearer,
    { ...originalPolicy, enabled: true, joinsPaused: false, approvalRequired: true });
  expect(response.statusCode).toBe(200);
  let policy = (await request("GET", "/api/moderation/policy", ownerBearer)).json<ServerModerationPolicy>();
  response = await request("POST", "/api/invites", ownerBearer, { kind: "server", targetGroupRoleSlug: "member" });
  expect(response.statusCode).toBe(200);
  const invite = response.json<{ id: string; token: string }>();
  inviteIds.push(invite.id);

  const bind = async () => {
    const sub = randomUUID();
    const handle = `join${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const result = await redeemInviteWithLogtoSub(invite.token, sub, { handle, displayName: "Community applicant" }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Fixture binding failed: ${result.code}`);
    userIds.push(result.userId);
    return { sub, handle, userId: result.userId, bearer: await fx.mintBearerForOrphanSub(sub) };
  };
  const applicant = await bind();
  const reviewUrl = `/api/invites/${invite.token}/enrollment-review`;
  const completeUrl = `/api/invites/${invite.token}/complete-profile`;
  const complete = (bearer: string) => request("POST", completeUrl, bearer, { displayName: "Community applicant", pin: "847291" });
  response = await complete(applicant.bearer);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: "join_message_required" });
  expect((await request("POST", reviewUrl, applicant.bearer, { message: "  " })).statusCode).toBe(400);
  response = await request("POST", reviewUrl, applicant.bearer, { message: "I want to learn and contribute useful projects." });
  expect(response.statusCode).toBe(200);
  const review = response.json<EnrollmentReviewStatus>();
  expect(review.state).toBe("pending");
  expect((await request("GET", "/api/auth/whoami", applicant.bearer)).statusCode).toBe(403);
  expect((await request("GET", "/api/moderation/enrollment", applicant.bearer)).statusCode).toBe(403);
  expect((await complete(applicant.bearer)).json()).toMatchObject({ code: "enrollment_review_required" });

  response = await request("GET", "/api/moderation/enrollment", ownerBearer);
  expect(response.statusCode).toBe(200);
  expect(response.json<{ items: { userId: string }[] }>().items.some(item => item.userId === applicant.userId)).toBe(true);
  response = await request("POST", "/api/moderation/enrollment/decision", ownerBearer,
    { inviteId: invite.id, userId: applicant.userId, revision: review.revision, decision: "approved" });
  expect(response.statusCode).toBe(200);
  expect((await complete(applicant.bearer)).statusCode).toBe(200);
  expect((await request("GET", "/api/auth/whoami", applicant.bearer)).statusCode).toBe(200);

  response = await request("GET", `/api/moderation/person?handle=${applicant.handle}`, ownerBearer);
  expect(response.statusCode).toBe(200);
  const { person } = response.json<{ person: ModerationPerson }>();
  const command = { operationId: randomUUID(), targetUserId: applicant.userId, roomId: null, action: "ban",
    reason: "Repeated threats", privateNote: null, expiresAt: null, restrictionId: null,
    restrictionRevision: null, targetRevision: person.targetRevision };
  response = await request("POST", "/api/moderation/actions", ownerBearer, command);
  expect(response.statusCode).toBe(200);
  const receipt = response.json<ModerationReceipt>();
  expect(receipt.committed).toBe(true);
  expect((await request("POST", "/api/moderation/actions", ownerBearer, command)).json()).toMatchObject({ replayed: true, operationId: command.operationId });
  expect((await request("GET", "/api/auth/whoami", applicant.bearer)).statusCode).toBe(403);
  expect((await complete(applicant.bearer)).statusCode).toBe(403);
  const rebind = await redeemInviteWithLogtoSub(invite.token, applicant.sub, { handle: applicant.handle, displayName: "Community applicant" }, {});
  expect(rebind).toMatchObject({ ok: false, code: "active_ban" });

  const second = await bind();
  expect((await complete(second.bearer)).json()).toMatchObject({ code: "join_message_required" });
  response = await request("POST", reviewUrl, second.bearer, { message: "A new account must receive its own review." });
  expect(response.json()).toMatchObject({ state: "pending" });
  const secondReview = response.json<EnrollmentReviewStatus>();
  expect((await complete(second.bearer)).json()).toMatchObject({ code: "enrollment_review_required" });

  response = await request("PUT", "/api/moderation/policy", ownerBearer, { ...policy, joinsPaused: true });
  expect(response.statusCode).toBe(200);
  policy = (await request("GET", "/api/moderation/policy", ownerBearer)).json<ServerModerationPolicy>();
  expect((await complete(second.bearer)).json()).toMatchObject({ code: "enrollment_paused" });
  response = await request("PUT", "/api/moderation/policy", ownerBearer, { ...policy, enabled: false });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ joinsPaused: true, approvalRequired: true });
  expect((await request("GET", "/api/auth/whoami", applicant.bearer)).statusCode).toBe(403);

  policy = (await request("GET", "/api/moderation/policy", ownerBearer)).json<ServerModerationPolicy>();
  expect((await request("PUT", "/api/moderation/policy", ownerBearer, { ...policy, enabled: true, joinsPaused: false })).statusCode).toBe(200);
  response = await request("GET", `/api/moderation/person?userId=${applicant.userId}`, ownerBearer);
  const banned = response.json<{ person: ModerationPerson; restrictions: { id: string; revision: number }[] }>();
  expect(banned.restrictions).toMatchObject([{ id: receipt.restrictionId }]);
  expect(banned.person.allowedActions).toContain("lift");
  response = await request("POST", "/api/moderation/actions", ownerBearer, { ...command,
    operationId: randomUUID(), action: "lift", reason: "Appeal reviewed", targetRevision: banned.person.targetRevision,
    restrictionId: receipt.restrictionId, restrictionRevision: banned.restrictions[0]!.revision });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ committed: true, action: "lift" });
  const lifted = (await request("GET", `/api/moderation/person?userId=${applicant.userId}`, ownerBearer))
    .json<{ person: ModerationPerson; restrictions: unknown[] }>();
  expect(lifted.restrictions).toEqual([]);
  expect(lifted.person.allowedActions).not.toContain("lift");
  expect((await request("GET", "/api/auth/whoami", applicant.bearer)).statusCode).toBe(403);
  expect((await complete(applicant.bearer)).statusCode).toBe(403);

  expect((await request("POST", "/api/moderation/enrollment/decision", ownerBearer,
    { inviteId: invite.id, userId: second.userId, revision: secondReview.revision, decision: "approved" })).statusCode).toBe(200);
  expect((await complete(second.bearer)).statusCode).toBe(200);
  expect((await request("GET", "/api/auth/whoami", second.bearer)).statusCode).toBe(200);
  response = await request("GET", `/api/moderation/person?userId=${second.userId}`, ownerBearer);
  const kickTarget = response.json<{ person: ModerationPerson }>().person;
  response = await request("POST", "/api/moderation/actions", ownerBearer, { ...command,
    operationId: randomUUID(), action: "kick", reason: "Community rule violation", targetUserId: second.userId,
    targetRevision: kickTarget.targetRevision });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ committed: true, action: "kick" });
  expect((await request("GET", "/api/auth/whoami", second.bearer)).statusCode).toBe(403);
  expect((await complete(second.bearer)).statusCode).toBe(403);
}, 120_000);
