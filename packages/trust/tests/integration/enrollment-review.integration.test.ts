import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { __resetSharedDirectDbForTests, ensureDatabase, eq, getSharedDirectDb, invites, inviteRedemptions,
  users, serverAdmission, serverModerationPolicy, capabilities, roles, groups, roleCapabilities, groupRoles, groupMembers, sql } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { applicantEnrollmentReview, decideEnrollmentReview, listEnrollmentReviews } from "../../src/enrollment-review";
import { completeModerationEnrollmentInTx } from "../../src/moderation-enrollment";
import { readServerModerationPolicy } from "../../src/moderation-settings";

const issuer = "https://identity.example";
beforeAll(async () => { bootstrapTestDbInstance(); await ensureDatabase(); }, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); });
async function fixture() {
  const db = getSharedDirectDb();
  const policy = await readServerModerationPolicy();
  const [manager, applicant, other] = await db.insert(users).values(["Reviewer", "Applicant", "Second applicant"].map(name => ({ name, externalId: randomUUID() }))).returning();
  if (!manager || !applicant || !other) throw new Error("Fixture missing");
  await db.insert(serverAdmission).values([{ userId: manager.id, admitted: true }, { userId: applicant.id }, { userId: other.id }]);
  await db.insert(capabilities).values({ slug: "manage_server_enrollment", description: "Review requests", category: "moderation" }).onConflictDoNothing();
  const [cap] = await db.select().from(capabilities).where(eq(capabilities.slug, "manage_server_enrollment"));
  const [role] = await db.insert(roles).values({ slug: `review-${randomUUID()}`, label: "Reviewer" }).returning();
  const [group] = await db.insert(groups).values({ ownerId: manager.id, type: `custom:review-${randomUUID()}`, label: "Reviewers" }).returning();
  await db.insert(roleCapabilities).values({ roleId: role!.id, capabilityId: cap!.id });
  await db.insert(groupRoles).values({ groupId: group!.id, roleId: role!.id });
  await db.insert(groupMembers).values({ groupId: group!.id, userId: manager.id });
  const token = `inv_${randomUUID().replaceAll("-", "")}`;
  const [invite] = await db.insert(invites).values({ tokenHash: createHash("sha256").update(token).digest("hex"), kind: "server", createdBy: manager.id, targetGroupId: group!.id }).returning();
  await db.insert(inviteRedemptions).values([{ inviteId: invite!.id, userId: applicant.id }, { inviteId: invite!.id, userId: other.id }]);
  await db.update(serverModerationPolicy).set({ approvalRequired: true, joinsPaused: false });
  const input = { inviteToken: token, subject: applicant.externalId!, issuer };
  const decide = (revision: number, decision: "approved" | "rejected" = "approved") => decideEnrollmentReview(manager.id,
    { inviteId: invite!.id, userId: applicant.id, revision, decision }, issuer);
  const complete = (userId = applicant.id) => db.transaction(tx => completeModerationEnrollmentInTx(tx, userId, issuer, null, 0, invite!.id));
  const cleanup = async () => {
    await db.update(serverModerationPolicy).set(policy);
    await db.delete(invites).where(eq(invites.id, invite!.id));
    await db.delete(groups).where(eq(groups.id, group!.id));
    await db.delete(roles).where(eq(roles.id, role!.id));
    for (const user of [applicant, other, manager]) await db.delete(users).where(eq(users.id, user.id));
  };
  return { db, manager, applicant, other, invite: invite!, input, decide, complete, cleanup };
}

test("a joining message is mandatory and a pending request grants no access", async () => {
  const f = await fixture(); try {
    await Promise.resolve(expect(applicantEnrollmentReview({ ...f.input, message: " \n " })).rejects.toThrow("join_message_required"));
    await Promise.resolve(expect(f.complete()).rejects.toThrow("join_message_required"));
    const pending = await applicantEnrollmentReview({ ...f.input, message: "I want to learn and contribute." });
    expect(pending.state).toBe("pending");
    await Promise.resolve(expect(f.complete()).rejects.toThrow("enrollment_review_required"));
    const [admission] = await f.db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.applicant.id));
    expect(admission?.admitted).toBe(false);
  } finally { await f.cleanup(); }
});

test("approval is bound to the account; reusing the same invite cannot inherit it", async () => {
  const f = await fixture(); try {
    const review = await applicantEnrollmentReview({ ...f.input, message: "Build useful things." });
    await f.decide(review.revision);
    const [before] = await f.db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.applicant.id));
    expect(before?.admitted).toBe(false);
    await f.complete();
    await applicantEnrollmentReview({ ...f.input, subject: f.other.externalId!, message: "A different person." });
    await Promise.resolve(expect(f.complete(f.other.id)).rejects.toThrow("enrollment_review_required"));
  } finally { await f.cleanup(); }
});

test("editing a pending message invalidates stale staff approval; approved text is immutable to applicant", async () => {
  const f = await fixture(); try {
    const initial = await applicantEnrollmentReview({ ...f.input, message: "Initial goal." });
    const changed = await applicantEnrollmentReview({ ...f.input, message: "Changed goal." });
    await Promise.resolve(expect(f.decide(initial.revision)).rejects.toThrow("stale_revision"));
    await f.decide(changed.revision); await f.decide(changed.revision);
    const after = await applicantEnrollmentReview({ ...f.input, message: "Replacement after approval." });
    expect(after.message).toBe("Changed goal."); expect(after.state).toBe("approved");
  } finally { await f.cleanup(); }
});

test("pause and account withdrawal remain authoritative after approval", async () => {
  const f = await fixture(); try {
    const review = await applicantEnrollmentReview({ ...f.input, message: "Learn from the community." });
    await f.decide(review.revision);
    await f.db.update(serverModerationPolicy).set({ joinsPaused: true });
    await Promise.resolve(expect(f.complete()).rejects.toThrow("enrollment_paused"));
    await f.db.update(serverModerationPolicy).set({ joinsPaused: false });
    await f.db.update(serverAdmission).set({ epoch: 1, admitted: false }).where(eq(serverAdmission.userId, f.applicant.id));
    await Promise.resolve(expect(f.complete()).rejects.toThrow("admission_withdrawn"));
  } finally { await f.cleanup(); }
});

test("staff can decline an obsolete request; applicants cannot override a rejection", async () => {
  const f = await fixture(); try {
    const review = await applicantEnrollmentReview({ ...f.input, message: "Review this request." });
    await f.db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, f.invite.id));
    await Promise.resolve(expect(f.decide(review.revision)).rejects.toThrow("target_unavailable"));
    await f.decide(review.revision, "rejected");
    await f.db.update(invites).set({ revokedAt: null }).where(eq(invites.id, f.invite.id));
    expect((await applicantEnrollmentReview({ ...f.input, message: "Try again." })).state).toBe("rejected");
    await Promise.resolve(expect(f.complete()).rejects.toThrow("enrollment_rejected"));
  } finally { await f.cleanup(); }
});

test("only an admitted enrollment manager can read or decide requests", async () => {
  const f = await fixture(); try {
    const review = await applicantEnrollmentReview({ ...f.input, message: "Private joining goal." });
    await Promise.resolve(expect(listEnrollmentReviews(f.other.id, { limit: 1 })).rejects.toThrow("forbidden_scope"));
    await Promise.resolve(expect(decideEnrollmentReview(f.other.id, { inviteId: f.invite.id, userId: f.applicant.id, revision: review.revision, decision: "approved" }, issuer)).rejects.toThrow("forbidden_scope"));
    const page = await listEnrollmentReviews(f.manager.id, { limit: 100 });
    expect(page.items.some(item => item.userId === f.applicant.id && item.message === "Private joining goal.")).toBe(true);
    await f.db.update(serverAdmission).set({ admitted: false }).where(eq(serverAdmission.userId, f.manager.id));
    await Promise.resolve(expect(f.decide(review.revision)).rejects.toThrow("forbidden_scope"));
  } finally { await f.cleanup(); }
});

test("ordinary agent and crypto database roles cannot read applicant messages", async () => {
  const rows = await getSharedDirectDb().execute<{ agent: boolean; crypto: boolean; forced: boolean }>(sql`
    SELECT has_table_privilege('nautilo_agent', 'invite_redemptions', 'SELECT') AS agent,
      has_table_privilege('nautilo_crypto', 'invite_redemptions', 'SELECT') AS crypto,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'invite_redemptions'::regclass) AS forced`);
  expect(rows[0]).toEqual({ agent: false, crypto: false, forced: true });
});

test("review search finds names, handles, and literal message text across pages", async () => {
  const f = await fixture(); try {
    const handle = `fixture_${randomUUID().replaceAll("-", "")}`;
    await f.db.update(users).set({ handle }).where(eq(users.id, f.applicant.id));
    await applicantEnrollmentReview({ ...f.input, message: "Robotics 100%_useful" });
    await applicantEnrollmentReview({ ...f.input, subject: f.other.externalId!, message: "Robotics only" });
    for (const search of ["applicant", `@${handle.toUpperCase()}`, "100%_"]) {
      const page = await listEnrollmentReviews(f.manager.id, { limit: 1, search });
      expect(page.items.length).toBe(1);
      if (search !== "applicant") expect(page.items[0]?.userId).toBe(f.applicant.id);
    }
    const first = await listEnrollmentReviews(f.manager.id, { limit: 1, search: "robotics" });
    expect(first.next).not.toBeNull();
    const second = await listEnrollmentReviews(f.manager.id, { limit: 1, search: "robotics", after: first.next! });
    expect(second.items).toHaveLength(1); expect(second.next).toBeNull();
    expect(second.items[0]?.userId).not.toBe(first.items[0]?.userId);
    expect((await listEnrollmentReviews(f.manager.id, { limit: 50, search: "not-in-any-request" })).items).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test("moderation member search is minimal, grant-scoped and escapes wildcard input", async () => {
  const f = await fixture(); try {
    const { searchServerModerationPeople } = await import("../../src/moderation-person");
    await Promise.resolve(expect(searchServerModerationPeople(f.manager.id, { search: "Applicant", limit: 1 })).rejects.toThrow("forbidden_scope"));
    await f.db.insert(capabilities).values({ slug: "view_server_moderation", description: "View moderation", category: "moderation" }).onConflictDoNothing();
    const [cap] = await f.db.select().from(capabilities).where(eq(capabilities.slug, "view_server_moderation"));
    const [membership] = await f.db.select().from(groupMembers).where(eq(groupMembers.userId, f.manager.id));
    const [grant] = await f.db.select().from(groupRoles).where(eq(groupRoles.groupId, membership!.groupId));
    await f.db.insert(roleCapabilities).values({ roleId: grant!.roleId, capabilityId: cap!.id });
    const handle = `search_${randomUUID().replaceAll("-", "")}`;
    await f.db.update(users).set({ handle, name: "Member 100%_literal" }).where(eq(users.id, f.applicant.id));
    const page = await searchServerModerationPeople(f.manager.id, { search: `@${handle.toUpperCase()}`, limit: 1 });
    expect(page.items).toEqual([{ userId: f.applicant.id, displayName: "Member 100%_literal", handle }]);
    expect((await searchServerModerationPeople(f.manager.id, { search: "%_literal", limit: 50 })).items).toEqual(page.items);
    expect((await searchServerModerationPeople(f.manager.id, { search: handle, limit: 50, activeOnly: true })).items).toEqual([]);
    await f.db.update(serverAdmission).set({ admitted: true }).where(eq(serverAdmission.userId, f.applicant.id));
    expect((await searchServerModerationPeople(f.manager.id, { search: handle, limit: 50, activeOnly: true })).items).toEqual(page.items);
    await f.db.update(serverAdmission).set({ admitted: false }).where(eq(serverAdmission.userId, f.applicant.id));
    expect((await searchServerModerationPeople(f.manager.id, { search: handle, limit: 50, activeOnly: true })).items).toEqual([]);
    expect((await searchServerModerationPeople(f.manager.id, { search: handle, limit: 50 })).items).toEqual(page.items);
    await f.db.update(serverAdmission).set({ admitted: false }).where(eq(serverAdmission.userId, f.manager.id));
    await Promise.resolve(expect(searchServerModerationPeople(f.manager.id, { search: handle, limit: 1 })).rejects.toThrow("forbidden_scope"));
  } finally { await f.cleanup(); }
});
