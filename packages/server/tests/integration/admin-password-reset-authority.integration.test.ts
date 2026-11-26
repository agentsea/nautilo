import { randomUUID } from "node:crypto";
import { expect, spyOn, test } from "bun:test";
import { users, profiles, logtoAccountSecurity, eq } from "@nautilo/db";
import { getLogtoAdminClient } from "@nautilo/trust";
import * as auditLog from "../../src/lib/security-audit-log";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

test("password resets respect the caller's delegation ceiling", async () => {
  const suiteName = `resetceiling${randomUUID().slice(0, 6)}`;
  const fx = await setupOwnerAppFixture({ suiteName });
  const cleanupUserIds: string[] = [];
  const logto = getLogtoAdminClient();
  const issueToken = spyOn(logto, "createOneTimeToken");
  const setPassword = spyOn(logto, "setUserPassword");
  const writeAuditEvent = spyOn(auditLog, "writeSecurityAuditEvent").mockImplementation(() => {});
  const seatUser = async (groupType: "owners" | "admins" | "members") => {
    const user = await seatPeerUser(fx.db, {
      suiteName: `${cleanupUserIds.length}${suiteName}`,
      groupType,
    });
    cleanupUserIds.push(user.userId);
    return user;
  };
  try {
    const ownerBearer = await fx.mintOwnerBearer();
    const admin = await seatUser("admins");
    const ownerWithEmail = await seatUser("owners");
    const ownerWithoutEmail = await seatUser("owners");
    const adminTarget = await seatUser("admins");
    const memberTarget = await seatUser("members");

    await fx.db
      .update(users)
      .set({ email: `${suiteName}-owner@test.local` })
      .where(eq(users.id, ownerWithEmail.userId));
    await fx.db
      .update(users)
      .set({ email: `${suiteName}-member@test.local` })
      .where(eq(users.id, memberTarget.userId));

    for (const ownerId of [ownerWithEmail.userId, ownerWithoutEmail.userId]) {
      const denied = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${ownerId}/reset-password`,
        bearer: admin.bearer,
      });
      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.body)).toEqual({ code: "delegation_ceiling" });
    }
    expect(issueToken).not.toHaveBeenCalled();
    expect(setPassword).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();

    const deniedSecurityRows = await fx.db
      .select({ userId: logtoAccountSecurity.userId })
      .from(logtoAccountSecurity)
      .where(eq(logtoAccountSecurity.userId, ownerWithoutEmail.userId));
    expect(deniedSecurityRows).toHaveLength(0);

    const adminToAdmin = await authedInject(fx.app, {
      method: "POST",
      url: `/api/admin/users/${adminTarget.userId}/reset-password`,
      bearer: admin.bearer,
    });
    expect(adminToAdmin.statusCode).toBe(200);
    expect(JSON.parse(adminToAdmin.body)).toMatchObject({
      ok: true,
      delivery: "temporary_password",
      mustChangePassword: true,
    });

    const adminToMember = await authedInject(fx.app, {
      method: "POST",
      url: `/api/admin/users/${memberTarget.userId}/reset-password`,
      bearer: admin.bearer,
    });
    expect(adminToMember.statusCode).toBe(200);
    expect(JSON.parse(adminToMember.body)).toMatchObject({
      ok: true,
      delivery: "one_time_url",
      token: "stub-ott",
    });

    const ownerToOwner = await authedInject(fx.app, {
      method: "POST",
      url: `/api/admin/users/${ownerWithoutEmail.userId}/reset-password`,
      bearer: ownerBearer,
    });
    expect(ownerToOwner.statusCode).toBe(200);
    expect(JSON.parse(ownerToOwner.body)).toMatchObject({
      ok: true,
      delivery: "temporary_password",
      mustChangePassword: true,
    });

    const [ownerSecurity] = await fx.db
      .select({ required: logtoAccountSecurity.requiresPasswordChange })
      .from(logtoAccountSecurity)
      .where(eq(logtoAccountSecurity.userId, ownerWithoutEmail.userId))
      .limit(1);
    expect(ownerSecurity?.required).toBe(true);
  } finally {
    writeAuditEvent.mockRestore();
    issueToken.mockRestore();
    setPassword.mockRestore();
    for (const userId of cleanupUserIds) {
      await fx.db.delete(profiles).where(eq(profiles.userId, userId));
      await fx.db.delete(users).where(eq(users.id, userId));
    }
    await fx.cleanup();
  }
}, 120000);
