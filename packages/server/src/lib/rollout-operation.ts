import {
  and,
  asc,
  eq,
  getSharedDirectDb,
  inArray,
  memberRolloutItems,
  memberRollouts,
  type DirectDatabase,
} from "@nautilo/db";
import type { RolloutManifestMember } from "./rollout-plan";
import { provisionMember, type ProvisionMemberResult } from "./provision-member";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

export interface RolloutOperationMember extends RolloutManifestMember {
  index: number;
  idempotencyKey: string;
  targetGroupId: string;
}

export interface RolloutCredential {
  sequence: number;
  handle: string;
  temporaryPassword: string;
  pin: string;
  recoveryCodes: string[];
}

export interface RolloutOperationDependencies {
  db: DirectDatabase;
  provision(input: Parameters<typeof provisionMember>[0]): Promise<ProvisionMemberResult>;
}

function deps(input: Partial<RolloutOperationDependencies>): RolloutOperationDependencies {
  return {
    db: input.db ?? getSharedDirectDb(),
    provision: input.provision ?? ((intent) => provisionMember(intent)),
  };
}

export async function createOrLoadRollout(input: {
  serverInstanceId: string;
  fingerprint: string;
  idempotencyKey: string;
  manifest: { schemaVersion: 1; members: RolloutManifestMember[] };
  callerUserId: string;
  operations: RolloutOperationMember[];
}, dependencies: Partial<RolloutOperationDependencies> = {}): Promise<
  | { ok: true; rolloutId: string; created: boolean }
  | { ok: false; status: number; code: string }
> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    return { ok: false, status: 400, code: "invalid_idempotency_key" };
  }
  const { db } = deps(dependencies);
  const inserted = await db.transaction(async (tx) => {
    const [created] = await tx.insert(memberRollouts).values({
      serverInstanceId: input.serverInstanceId,
      fingerprint: input.fingerprint,
      idempotencyKey: input.idempotencyKey,
      manifest: input.manifest,
      createdBy: input.callerUserId,
    }).onConflictDoNothing({
      target: [memberRollouts.serverInstanceId, memberRollouts.idempotencyKey],
    }).returning({ id: memberRollouts.id });
    if (!created) return null;
    await tx.insert(memberRolloutItems).values(input.operations.map((operation) => ({
      rolloutId: created.id,
      sequence: operation.index,
      handle: operation.handle,
      roleSlug: operation.roleSlug,
      targetGroupId: operation.targetGroupId,
    })));
    return created;
  });
  if (!inserted) {
    const [existing] = await db.select().from(memberRollouts).where(and(
      eq(memberRollouts.serverInstanceId, input.serverInstanceId),
      eq(memberRollouts.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!existing) return { ok: false, status: 409, code: "rollout_conflict" };
    if (existing.fingerprint !== input.fingerprint) {
      return { ok: false, status: 409, code: "idempotency_conflict" };
    }
    if (existing.createdBy !== input.callerUserId) {
      return { ok: false, status: 403, code: "rollout_owner_mismatch" };
    }
    return { ok: true, rolloutId: existing.id, created: false };
  }
  return { ok: true, rolloutId: inserted.id, created: true };
}

export async function processRollout(input: {
  rolloutId: string;
  callerUserId: string;
  callerActorId: string | null;
  operations: RolloutOperationMember[];
}, dependencies: Partial<RolloutOperationDependencies> = {}): Promise<RolloutCredential[]> {
  const resolved = deps(dependencies);
  const { db } = resolved;
  const credentials: RolloutCredential[] = [];
  const rows = await db.select().from(memberRolloutItems)
    .where(eq(memberRolloutItems.rolloutId, input.rolloutId))
    .orderBy(asc(memberRolloutItems.sequence));
  for (const row of rows) {
    if (row.state === "external_pending") {
      await db.update(memberRolloutItems).set({
        state: "unknown",
        errorCode: "outcome_unknown",
        updatedAt: new Date(),
      }).where(eq(memberRolloutItems.id, row.id));
      continue;
    }
    if (row.state !== "planned" && row.state !== "failed_before_change") continue;
    const operation = input.operations.find((candidate) => candidate.index === row.sequence);
    if (
      !operation
      || operation.handle !== row.handle
      || operation.roleSlug !== row.roleSlug
      || operation.targetGroupId !== row.targetGroupId
    ) {
      await db.update(memberRolloutItems).set({
        state: "repair_required",
        errorCode: "operation_mismatch",
        updatedAt: new Date(),
      }).where(eq(memberRolloutItems.id, row.id));
      continue;
    }
    const [claimed] = await db.update(memberRolloutItems).set({
      state: "external_pending",
      errorCode: null,
      updatedAt: new Date(),
    }).where(and(
      eq(memberRolloutItems.id, row.id),
      inArray(memberRolloutItems.state, ["planned", "failed_before_change"]),
    )).returning({ id: memberRolloutItems.id });
    if (!claimed) continue;
    const result = await resolved.provision({
      callerUserId: input.callerUserId,
      callerActorId: input.callerActorId,
      idempotencyKey: operation.idempotencyKey,
      handle: operation.handle,
      displayName: operation.displayName,
      ...(operation.email ? { email: operation.email } : {}),
      roleSlug: operation.roleSlug,
      targetGroupId: operation.targetGroupId,
    });
    if (!result.ok) {
      await db.update(memberRolloutItems).set({
        state: result.retrySafe ? "failed_before_change" : "repair_required",
        errorCode: result.code,
        updatedAt: new Date(),
      }).where(eq(memberRolloutItems.id, row.id));
      continue;
    }
    const issued = result.credential.disposition === "issued";
    await db.update(memberRolloutItems).set({
      state: issued ? "nautilo_committed" : "complete",
      receiptId: result.receiptId,
      memberId: result.userId,
      errorCode: null,
      credentialDisposition: result.credential.disposition,
      updatedAt: new Date(),
    }).where(eq(memberRolloutItems.id, row.id));
    if (result.credential.disposition === "issued") {
      credentials.push({
        sequence: operation.index,
        handle: operation.handle,
        temporaryPassword: result.credential.temporaryPassword,
        pin: result.credential.pin,
        recoveryCodes: result.credential.recoveryCodes,
      });
    }
  }
  await refreshRolloutStatus(input.rolloutId, db);
  return credentials;
}

export async function acknowledgeRolloutCredentials(
  rolloutId: string,
  sequences: number[],
  database: DirectDatabase = getSharedDirectDb(),
): Promise<void> {
  if (sequences.length > 0) {
    await database.update(memberRolloutItems).set({
      state: "complete",
      updatedAt: new Date(),
    }).where(and(
      eq(memberRolloutItems.rolloutId, rolloutId),
      inArray(memberRolloutItems.sequence, sequences),
      eq(memberRolloutItems.state, "nautilo_committed"),
    ));
  }
  await refreshRolloutStatus(rolloutId, database);
}

async function refreshRolloutStatus(
  rolloutId: string,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<void> {
  const items = await database.select({ state: memberRolloutItems.state })
    .from(memberRolloutItems)
    .where(eq(memberRolloutItems.rolloutId, rolloutId));
  const status = items.every((item) => item.state === "complete")
    ? "complete"
    : items.some((item) => item.state === "repair_required" || item.state === "unknown")
      ? "repair_required"
      : "partial";
  await database.update(memberRollouts).set({ status, updatedAt: new Date() })
    .where(eq(memberRollouts.id, rolloutId));
}

export async function getRolloutStatus(
  rolloutId: string,
  database: DirectDatabase = getSharedDirectDb(),
) {
  const [rollout] = await database.select().from(memberRollouts)
    .where(eq(memberRollouts.id, rolloutId)).limit(1);
  if (!rollout) return null;
  const items = await database.select().from(memberRolloutItems)
    .where(eq(memberRolloutItems.rolloutId, rolloutId))
    .orderBy(asc(memberRolloutItems.sequence));
  return { rollout, items };
}

export async function getRolloutByIdempotency(
  serverInstanceId: string,
  idempotencyKey: string,
  database: DirectDatabase = getSharedDirectDb(),
) {
  const [rollout] = await database.select().from(memberRollouts).where(and(
    eq(memberRollouts.serverInstanceId, serverInstanceId),
    eq(memberRollouts.idempotencyKey, idempotencyKey),
  )).limit(1);
  return rollout ?? null;
}
