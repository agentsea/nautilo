import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { PasswordPolicyChecker, passwordPolicyGuard } from "@logto/core-kit";
import {
  getSharedDirectDb,
  actors,
  inviteRedemptions,
  invites,
  rooms,
  users,
  and,
  eq,
  isNotNull,
  type DirectDatabase,
} from "@nautilo/db";
import { getLogtoAdminClient, type LogtoAdminClient } from "@nautilo/trust";
import { redeemInviteAtomically, type RedeemResult } from "./redeem-invite";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

export interface ProvisionMemberIntent {
  callerUserId: string;
  callerActorId: string | null;
  idempotencyKey: string;
  handle: string;
  displayName: string;
  email?: string | undefined;
  roleSlug: string;
  targetGroupId: string;
  permanentCredential?: { password: string; pin: string } | undefined;
}

export type ProvisionMemberResult =
  | {
      ok: true;
      receiptId: string;
      userId: string;
      actorId: string | null;
      landingRoomId: string | null;
      idempotent: boolean;
      credential:
        | {
            disposition: "issued";
            temporaryPassword: string;
            pin: string;
            recoveryCodes: string[];
          }
        | { disposition: "provided"; recoveryCodes: string[] }
        | { disposition: "not_reissued" };
    }
  | { ok: false; status: number; code: string; retrySafe: boolean };

export interface ProvisionMemberDependencies {
  db: DirectDatabase;
  logto: LogtoAdminClient;
  redeem(
    token: string,
    input: {
      handle: string;
      displayName: string;
      password: string;
      pin: string;
      email?: string;
      forcePasswordChange?: boolean;
    },
    deps: { logto: LogtoAdminClient },
  ): Promise<RedeemResult>;
  idempotencySecret: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalIntentFingerprint(input: ProvisionMemberIntent): string {
  return sha256(JSON.stringify({
    handle: input.handle,
    displayName: input.displayName,
    email: input.email ?? null,
    roleSlug: input.roleSlug,
    targetGroupId: input.targetGroupId,
    credentialLifecycle: input.permanentCredential ? "permanent" : "first_use",
  }));
}

async function generatePolicyCompliantPassword(
  logto: LogtoAdminClient,
  input: ProvisionMemberIntent,
): Promise<string | null> {
  try {
    const policy = passwordPolicyGuard.parse(await logto.getPasswordPolicy());
    const checker = new PasswordPolicyChecker(policy);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `N!${randomBytes(32).toString("base64url")}`;
      const issues = await checker.check(candidate, {
        name: input.displayName,
        username: input.handle,
        ...(input.email ? { email: input.email } : {}),
      });
      if (issues.length === 0) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

export async function isPolicyCompliantProvisioningPassword(
  logto: LogtoAdminClient,
  input: Pick<ProvisionMemberIntent, "handle" | "displayName" | "email">,
  password: string,
): Promise<boolean> {
  try {
    const policy = passwordPolicyGuard.parse(await logto.getPasswordPolicy());
    const checker = new PasswordPolicyChecker(policy);
    return (await checker.check(password, {
      name: input.displayName,
      username: input.handle,
      ...(input.email ? { email: input.email } : {}),
    })).length === 0;
  } catch {
    return false;
  }
}

export async function provisionMember(
  input: ProvisionMemberIntent,
  dependencies: Partial<ProvisionMemberDependencies> = {},
): Promise<ProvisionMemberResult> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    return { ok: false, status: 400, code: "invalid_idempotency_key", retrySafe: true };
  }
  const deps: ProvisionMemberDependencies = {
    db: dependencies.db ?? getSharedDirectDb(),
    logto: dependencies.logto ?? getLogtoAdminClient(),
    redeem:
      dependencies.redeem
      ?? ((token, redeemInput, redeemDeps) =>
        redeemInviteAtomically(token, redeemInput, redeemDeps)),
    idempotencySecret:
      dependencies.idempotencySecret
      ?? process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"]
      ?? process.env["LOGTO_M2M_APP_SECRET"]
      ?? "",
  };
  if (deps.idempotencySecret.length < 16) {
    return { ok: false, status: 503, code: "provisioning_unavailable", retrySafe: false };
  }
  const token = `inv_${createHmac("sha256", deps.idempotencySecret)
    .update(`direct-provision-v1\0${input.callerUserId}\0${input.idempotencyKey}`, "utf8")
    .digest("hex")}`;
  const tokenHash = sha256(token);
  const marker = `direct:${canonicalIntentFingerprint(input)}`;

  const [inserted] = await deps.db
    .insert(invites)
    .values({
      tokenHash,
      kind: "server",
      targetGroupId: input.targetGroupId,
      targetRoomId: null,
      maxUses: 1,
      usedCount: 0,
      createdBy: input.callerUserId,
      displayName: marker,
      expiresAt: null,
      revokedAt: null,
    })
    .onConflictDoNothing({ target: invites.tokenHash })
    .returning({ id: invites.id });

  if (!inserted) {
    const [existing] = await deps.db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, tokenHash))
      .limit(1);
    if (
      !existing
      || existing.createdBy !== input.callerUserId
      || existing.targetGroupId !== input.targetGroupId
      || existing.displayName !== marker
    ) {
      return { ok: false, status: 409, code: "idempotency_conflict", retrySafe: false };
    }
    if (existing.usedCount < 1) {
      return { ok: false, status: 409, code: "provision_outcome_unknown", retrySafe: false };
    }
    const [redemption] = await deps.db
      .select({ userId: inviteRedemptions.userId })
      .from(inviteRedemptions)
      .where(
        and(
          eq(inviteRedemptions.inviteId, existing.id),
          isNotNull(inviteRedemptions.completedAt),
        ),
      )
      .limit(1);
    if (!redemption) {
      return { ok: false, status: 409, code: "provision_outcome_unknown", retrySafe: false };
    }
    const [user] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, redemption.userId))
      .limit(1);
    if (!user) {
      return { ok: false, status: 409, code: "provision_repair_required", retrySafe: false };
    }
    const [actor] = await deps.db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.ownerId, user.id), eq(actors.kind, "user")))
      .limit(1);
    const [room] = await deps.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.ownerId, user.id))
      .limit(1);
    if (!actor || !room) {
      return { ok: false, status: 409, code: "provision_repair_required", retrySafe: false };
    }
    return {
      ok: true,
      receiptId: existing.id,
      userId: user.id,
      actorId: actor.id,
      landingRoomId: room.id,
      idempotent: true,
      credential: { disposition: "not_reissued" },
    };
  }

  if (input.permanentCredential && !/^\d{6}$/u.test(input.permanentCredential.pin)) {
    await deps.db.delete(invites).where(eq(invites.id, inserted.id));
    return { ok: false, status: 400, code: "invalid_permanent_credential", retrySafe: true };
  }
  if (
    input.permanentCredential
    && !(await isPolicyCompliantProvisioningPassword(deps.logto, input, input.permanentCredential.password))
  ) {
    await deps.db.delete(invites).where(eq(invites.id, inserted.id));
    return { ok: false, status: 400, code: "invalid_permanent_credential", retrySafe: true };
  }
  const temporaryPassword = input.permanentCredential?.password
    ?? await generatePolicyCompliantPassword(deps.logto, input);
  if (!temporaryPassword) {
    await deps.db.delete(invites).where(eq(invites.id, inserted.id));
    return { ok: false, status: 503, code: "password_policy_unavailable", retrySafe: false };
  }
  const pin = input.permanentCredential?.pin ?? String(randomInt(100_000, 1_000_000));
  const result = await deps.redeem(
    token,
    {
      handle: input.handle,
      displayName: input.displayName,
      password: temporaryPassword,
      pin,
      ...(input.email ? { email: input.email } : {}),
      forcePasswordChange: input.permanentCredential ? false : true,
    },
    { logto: deps.logto },
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.httpStatus,
      code: result.code ?? result.error,
      retrySafe: false,
    };
  }
  return {
    ok: true,
    receiptId: inserted.id,
    userId: result.newUserId,
    actorId: result.newActorId,
    landingRoomId: result.landingRoomId,
    idempotent: false,
    credential: input.permanentCredential
      ? { disposition: "provided", recoveryCodes: result.recoveryCodes }
      : {
          disposition: "issued",
          temporaryPassword,
          pin,
          recoveryCodes: result.recoveryCodes,
        },
  };
}
