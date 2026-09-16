import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import {
  connectedAppOauthAttempts,
  connectedAppProviderConfigs,
  connectedAppProfiles,
  type ConnectedAppOauthAttemptRow,
  type ConnectedAppProfileRow,
  type ConnectedAppProviderConfigRow,
} from "../schema/connected-apps";

export type ConnectedAppScope = {
  userId: string;
  namespaceId: string;
};

export async function getConnectedAppProfile(
  db: DirectDatabase,
  scope: ConnectedAppScope,
  providerId: string,
  driverKind: string,
): Promise<ConnectedAppProfileRow | null> {
  const [row] = await db
    .select()
    .from(connectedAppProfiles)
    .where(and(
      eq(connectedAppProfiles.userId, scope.userId),
      eq(connectedAppProfiles.namespaceId, scope.namespaceId),
      eq(connectedAppProfiles.providerId, providerId),
      eq(connectedAppProfiles.driverKind, driverKind),
    ))
    .limit(1);
  return row ?? null;
}

export async function upsertConnectedAppProfile(
  db: DirectDatabase,
  input: Omit<typeof connectedAppProfiles.$inferInsert, "id" | "createdAt" | "updatedAt" | "revision">,
): Promise<ConnectedAppProfileRow> {
  const [row] = await db
    .insert(connectedAppProfiles)
    .values(input)
    .onConflictDoUpdate({
      target: [
        connectedAppProfiles.userId,
        connectedAppProfiles.namespaceId,
        connectedAppProfiles.providerId,
        connectedAppProfiles.driverKind,
      ],
      set: {
        status: input.status,
        connectedAccountId: input.connectedAccountId,
        providerConfigId: input.providerConfigId,
        connectionName: input.connectionName,
        providerUserId: input.providerUserId,
        providerWorkspaceIdentity: input.providerWorkspaceIdentity,
        providerUserKind: input.providerUserKind,
        accountUsername: input.accountUsername,
        accountDisplayName: input.accountDisplayName,
        accountEmail: input.accountEmail,
        accountAvatarUrl: input.accountAvatarUrl,
        accountWorkspaceName: input.accountWorkspaceName,
        driverCredentialRefId: input.driverCredentialRefId,
        driverCredentialNamespaceId: input.driverCredentialNamespaceId,
        driverCredentialAgentId: input.driverCredentialAgentId,
        driverCredentialRecordId: input.driverCredentialRecordId,
        lastErrorCode: input.lastErrorCode,
        connectedAt: input.connectedAt,
        lastVerifiedAt: input.lastVerifiedAt,
        revision: sql`${connectedAppProfiles.revision} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("CONNECTED_APP_PROFILE_UPSERT_FAILED");
  return row;
}

export async function deleteConnectedAppProfile(
  db: DirectDatabase,
  scope: ConnectedAppScope,
  providerId: string,
  driverKind: string,
): Promise<void> {
  await db.delete(connectedAppProfiles).where(and(
    eq(connectedAppProfiles.userId, scope.userId),
    eq(connectedAppProfiles.namespaceId, scope.namespaceId),
    eq(connectedAppProfiles.providerId, providerId),
    eq(connectedAppProfiles.driverKind, driverKind),
  ));
}

export async function getConnectedAppProviderConfig(
  db: DirectDatabase,
  providerId: string,
  driverKind: string,
): Promise<ConnectedAppProviderConfigRow | null> {
  const [row] = await db.select().from(connectedAppProviderConfigs).where(and(
    eq(connectedAppProviderConfigs.providerId, providerId),
    eq(connectedAppProviderConfigs.driverKind, driverKind),
  )).limit(1);
  return row ?? null;
}

export async function upsertConnectedAppProviderConfig(
  db: DirectDatabase,
  input: Omit<typeof connectedAppProviderConfigs.$inferInsert, "id" | "createdAt" | "updatedAt" | "revision">,
): Promise<ConnectedAppProviderConfigRow> {
  const [row] = await db.insert(connectedAppProviderConfigs).values(input).onConflictDoUpdate({
    target: [connectedAppProviderConfigs.providerId, connectedAppProviderConfigs.driverKind],
    set: {
      status: input.status,
      clientId: input.clientId,
      adminCredentialRefId: input.adminCredentialRefId,
      adminCredentialNamespaceId: input.adminCredentialNamespaceId,
      adminCredentialAgentId: input.adminCredentialAgentId,
      lastErrorCode: input.lastErrorCode,
      lastVerifiedAt: input.lastVerifiedAt,
      revision: sql`${connectedAppProviderConfigs.revision} + 1`,
      updatedAt: new Date(),
    },
  }).returning();
  if (!row) throw new Error("CONNECTED_APP_PROVIDER_CONFIG_UPSERT_FAILED");
  return row;
}

/** A hosted credential belongs to the Human, so state changes apply to every Room projection. */
export async function markConnectedAppUserProfilesState(
  db: DirectDatabase,
  userId: string,
  providerId: string,
  driverKind: string,
  status: "connected" | "reconnect_required" | "error",
  lastErrorCode: string | null,
): Promise<void> {
  await db
    .update(connectedAppProfiles)
    .set({
      status,
      lastErrorCode,
      revision: sql`${connectedAppProfiles.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(connectedAppProfiles.userId, userId),
      eq(connectedAppProfiles.providerId, providerId),
      eq(connectedAppProfiles.driverKind, driverKind),
    ));
}

export async function findActiveConnectedAppOauthAttempt(
  db: DirectDatabase,
  scope: ConnectedAppScope,
  providerId: string,
  driverKind: string,
  now = new Date(),
): Promise<ConnectedAppOauthAttemptRow | null> {
  const [row] = await db
    .select()
    .from(connectedAppOauthAttempts)
    .where(and(
      eq(connectedAppOauthAttempts.userId, scope.userId),
      eq(connectedAppOauthAttempts.namespaceId, scope.namespaceId),
      eq(connectedAppOauthAttempts.providerId, providerId),
      eq(connectedAppOauthAttempts.driverKind, driverKind),
      eq(connectedAppOauthAttempts.status, "connecting"),
      gt(connectedAppOauthAttempts.expiresAt, now),
    ))
    .orderBy(desc(connectedAppOauthAttempts.createdAt))
    .limit(1);
  return row ?? null;
}

export async function expireStaleConnectedAppOauthAttempts(
  db: DirectDatabase,
  scope: ConnectedAppScope,
  providerId: string,
  driverKind: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(connectedAppOauthAttempts)
    .set({ status: "expired", completedAt: now, updatedAt: now })
    .where(and(
      eq(connectedAppOauthAttempts.userId, scope.userId),
      eq(connectedAppOauthAttempts.namespaceId, scope.namespaceId),
      eq(connectedAppOauthAttempts.providerId, providerId),
      eq(connectedAppOauthAttempts.driverKind, driverKind),
      eq(connectedAppOauthAttempts.status, "connecting"),
      lte(connectedAppOauthAttempts.expiresAt, now),
    ));
}

export async function insertConnectedAppOauthAttempt(
  db: DirectDatabase,
  input: Omit<typeof connectedAppOauthAttempts.$inferInsert, "id" | "createdAt" | "updatedAt" | "completedAt">,
): Promise<ConnectedAppOauthAttemptRow> {
  const [row] = await db.insert(connectedAppOauthAttempts).values(input).returning();
  if (!row) throw new Error("CONNECTED_APP_OAUTH_ATTEMPT_INSERT_FAILED");
  return row;
}

export async function getConnectedAppOauthAttempt(
  db: DirectDatabase,
  scope: ConnectedAppScope,
  attemptId: string,
): Promise<ConnectedAppOauthAttemptRow | null> {
  const [row] = await db
    .select()
    .from(connectedAppOauthAttempts)
    .where(and(
      eq(connectedAppOauthAttempts.id, attemptId),
      eq(connectedAppOauthAttempts.userId, scope.userId),
      eq(connectedAppOauthAttempts.namespaceId, scope.namespaceId),
    ))
    .limit(1);
  return row ?? null;
}

export async function finishConnectedAppOauthAttempt(
  db: DirectDatabase,
  scope: ConnectedAppScope,
  attemptId: string,
  status: "connected" | "failed" | "expired",
  errorCode: string | null,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(connectedAppOauthAttempts)
    .set({ status, errorCode, completedAt: now, updatedAt: now })
    .where(and(
      eq(connectedAppOauthAttempts.id, attemptId),
      eq(connectedAppOauthAttempts.userId, scope.userId),
      eq(connectedAppOauthAttempts.namespaceId, scope.namespaceId),
      eq(connectedAppOauthAttempts.status, "connecting"),
    ))
    .returning({ id: connectedAppOauthAttempts.id });
  return rows.length === 1;
}
