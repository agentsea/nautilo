import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt } from "drizzle-orm";
import type { Database } from "../config/database";
import {
  personalProviderCredentials,
  type PersonalProviderCredentialRow,
  type PersonalProviderCredentialValidationStatus,
  type PersonalProviderId,
} from "../schema/personal-provider-credentials";
import { nautiloInstanceIdentity } from "../schema/instance-identity";

export interface PersonalProviderCredentialEnvelope {
  formatVersion: 1;
  keyId: string;
  nonceBase64: string;
  ciphertextBase64: string;
  authTagBase64: string;
}

export interface PersonalProviderCredentialIdentity {
  id: string;
  revision: 1;
}

export interface PersonalProviderCredentialRecord {
  id: string;
  userId: string;
  provider: PersonalProviderId;
  revision: number;
  validationStatus: PersonalProviderCredentialValidationStatus;
  validatedAt: Date | null;
  envelope: PersonalProviderCredentialEnvelope;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersonalProviderCredentialCustodyRow {
  id: string;
  userId: string;
  provider: PersonalProviderId;
  revision: number;
  envelope: PersonalProviderCredentialEnvelope;
}

export interface PersonalProviderCredentialCustodyEvidence {
  recordCount: number;
  keyIds: string[];
}

export interface ClearedPersonalProviderCredentialsForClone {
  deletedCount: number;
}

export type PersonalProviderCredentialReadDb = Pick<
  Database,
  "select" | "selectDistinct"
>;
export type PersonalProviderCredentialWriteDb = Pick<
  Database,
  "delete" | "insert" | "select" | "transaction" | "update"
>;

export type InsertPersonalProviderCredentialResult =
  | { status: "created"; credential: PersonalProviderCredentialRecord }
  | { status: "already_exists" };

export type ReplacePersonalProviderCredentialResult =
  | { status: "replaced"; credential: PersonalProviderCredentialRecord }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision: number };

export type DeletePersonalProviderCredentialResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision: number };

export type SetPersonalProviderCredentialValidationResult =
  | { status: "updated"; credential: PersonalProviderCredentialRecord }
  | { status: "stale" };

export function createPersonalProviderCredentialIdentity(): PersonalProviderCredentialIdentity {
  return { id: randomUUID(), revision: 1 };
}

function projectCredential(
  row: PersonalProviderCredentialRow,
): PersonalProviderCredentialRecord {
  if (row.formatVersion !== 1) {
    throw new Error("Unsupported personal provider credential envelope format");
  }
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    revision: row.revision,
    validationStatus: row.validationStatus,
    validatedAt: row.validatedAt,
    envelope: {
      formatVersion: 1,
      keyId: row.keyId,
      nonceBase64: row.nonceBase64,
      ciphertextBase64: row.ciphertextBase64,
      authTagBase64: row.authTagBase64,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectCustodyRow(
  row: PersonalProviderCredentialRow,
): PersonalProviderCredentialCustodyRow {
  const credential = projectCredential(row);
  return {
    id: credential.id,
    userId: credential.userId,
    provider: credential.provider,
    revision: credential.revision,
    envelope: credential.envelope,
  };
}

export async function insertPersonalProviderCredential(
  db: PersonalProviderCredentialWriteDb,
  input: {
    identity: PersonalProviderCredentialIdentity;
    userId: string;
    provider: PersonalProviderId;
    envelope: PersonalProviderCredentialEnvelope;
  },
): Promise<InsertPersonalProviderCredentialResult> {
  const [row] = await db
    .insert(personalProviderCredentials)
    .values({
      id: input.identity.id,
      userId: input.userId,
      provider: input.provider,
      revision: input.identity.revision,
      validationStatus: "unverified",
      validatedAt: null,
      ...input.envelope,
    })
    .onConflictDoNothing({
      target: [
        personalProviderCredentials.userId,
        personalProviderCredentials.provider,
      ],
    })
    .returning();
  return row
    ? { status: "created", credential: projectCredential(row) }
    : { status: "already_exists" };
}

export async function getPersonalProviderCredential(
  db: PersonalProviderCredentialReadDb,
  userId: string,
  provider: PersonalProviderId,
): Promise<PersonalProviderCredentialRecord | null> {
  const [row] = await db
    .select()
    .from(personalProviderCredentials)
    .where(
      and(
        eq(personalProviderCredentials.userId, userId),
        eq(personalProviderCredentials.provider, provider),
      ),
    )
    .limit(1);
  return row ? projectCredential(row) : null;
}

export async function listPersonalProviderCredentials(
  db: PersonalProviderCredentialReadDb,
  userId: string,
): Promise<PersonalProviderCredentialRecord[]> {
  const rows = await db
    .select()
    .from(personalProviderCredentials)
    .where(eq(personalProviderCredentials.userId, userId))
    .orderBy(asc(personalProviderCredentials.provider));
  return rows.map(projectCredential);
}

export async function replacePersonalProviderCredential(
  db: PersonalProviderCredentialWriteDb,
  input: {
    userId: string;
    provider: PersonalProviderId;
    id: string;
    expectedRevision: number;
    envelope: PersonalProviderCredentialEnvelope;
  },
): Promise<ReplacePersonalProviderCredentialResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(personalProviderCredentials)
      .set({
        revision: input.expectedRevision + 1,
        validationStatus: "unverified",
        validatedAt: null,
        ...input.envelope,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(personalProviderCredentials.userId, input.userId),
          eq(personalProviderCredentials.provider, input.provider),
          eq(personalProviderCredentials.id, input.id),
          eq(personalProviderCredentials.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (row) return { status: "replaced", credential: projectCredential(row) };

    const [current] = await tx
      .select({ revision: personalProviderCredentials.revision })
      .from(personalProviderCredentials)
      .where(
        and(
          eq(personalProviderCredentials.userId, input.userId),
          eq(personalProviderCredentials.provider, input.provider),
          eq(personalProviderCredentials.id, input.id),
        ),
      )
      .limit(1);
    return current
      ? { status: "conflict", currentRevision: current.revision }
      : { status: "not_found" };
  });
}

export async function setPersonalProviderCredentialValidation(
  db: PersonalProviderCredentialWriteDb,
  input: {
    userId: string;
    provider: PersonalProviderId;
    id: string;
    expectedRevision: number;
    status: PersonalProviderCredentialValidationStatus;
    validatedAt: Date | null;
  },
): Promise<SetPersonalProviderCredentialValidationResult> {
  const [row] = await db
    .update(personalProviderCredentials)
    .set({
      validationStatus: input.status,
      validatedAt: input.validatedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(personalProviderCredentials.userId, input.userId),
        eq(personalProviderCredentials.provider, input.provider),
        eq(personalProviderCredentials.id, input.id),
        eq(personalProviderCredentials.revision, input.expectedRevision),
      ),
    )
    .returning();
  return row
    ? { status: "updated", credential: projectCredential(row) }
    : { status: "stale" };
}

export async function deletePersonalProviderCredential(
  db: PersonalProviderCredentialWriteDb,
  input: {
    userId: string;
    provider: PersonalProviderId;
    id: string;
    expectedRevision: number;
  },
): Promise<DeletePersonalProviderCredentialResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(personalProviderCredentials)
      .where(
        and(
          eq(personalProviderCredentials.userId, input.userId),
          eq(personalProviderCredentials.provider, input.provider),
          eq(personalProviderCredentials.id, input.id),
          eq(personalProviderCredentials.revision, input.expectedRevision),
        ),
      )
      .returning({ id: personalProviderCredentials.id });
    if (row) return { status: "deleted" };

    const [current] = await tx
      .select({ revision: personalProviderCredentials.revision })
      .from(personalProviderCredentials)
      .where(
        and(
          eq(personalProviderCredentials.userId, input.userId),
          eq(personalProviderCredentials.provider, input.provider),
          eq(personalProviderCredentials.id, input.id),
        ),
      )
      .limit(1);
    return current
      ? { status: "conflict", currentRevision: current.revision }
      : { status: "not_found" };
  });
}

export async function getPersonalProviderCredentialCustodyEvidence(
  db: PersonalProviderCredentialReadDb,
): Promise<PersonalProviderCredentialCustodyEvidence> {
  const [recordCountRow] = await db
    .select({ value: count() })
    .from(personalProviderCredentials);
  const keyRows = await db
    .selectDistinct({ keyId: personalProviderCredentials.keyId })
    .from(personalProviderCredentials)
    .orderBy(asc(personalProviderCredentials.keyId));
  return {
    recordCount: Number(recordCountRow?.value ?? 0),
    keyIds: keyRows.map((row) => row.keyId),
  };
}

export async function listPersonalProviderCredentialsForCustody(
  db: PersonalProviderCredentialReadDb,
  input: { afterId?: string; limit: number },
): Promise<PersonalProviderCredentialCustodyRow[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError(
      "Personal provider credential custody page limit must be a positive safe integer",
    );
  }
  const rows = await db
    .select()
    .from(personalProviderCredentials)
    .where(
      input.afterId === undefined
        ? undefined
        : gt(personalProviderCredentials.id, input.afterId),
    )
    .orderBy(asc(personalProviderCredentials.id))
    .limit(input.limit);
  return rows.map(projectCustodyRow);
}

/**
 * Clone-only destructive guard. The caller must first rebind the target's
 * durable identity, then supply both values observed from that target.
 */
export async function clearPersonalProviderCredentialsForClone(
  db: Pick<Database, "transaction">,
  input: { instanceId: string; serverInstanceId: string },
): Promise<ClearedPersonalProviderCredentialsForClone> {
  if (input.instanceId.trim() === "" || input.serverInstanceId.trim() === "") {
    throw new Error(
      "Refusing clone credential clearing without both target identity values",
    );
  }
  return db.transaction(async (tx) => {
    const identities = await tx
      .select({
        id: nautiloInstanceIdentity.id,
        instanceId: nautiloInstanceIdentity.instanceId,
        serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
      })
      .from(nautiloInstanceIdentity)
      .for("update");
    const [identity] = identities;
    if (
      identities.length !== 1
      || identity?.id !== "self"
      || identity.instanceId !== input.instanceId
      || identity.serverInstanceId !== input.serverInstanceId
    ) {
      throw new Error(
        "Refusing clone credential clearing because target database identity does not match",
      );
    }
    const deleted = await tx.delete(personalProviderCredentials);
    return { deletedCount: deleted.count };
  });
}
