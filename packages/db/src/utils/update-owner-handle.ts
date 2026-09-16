import { eq, and, isNull, sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { users } from "../schema/users";
import { channelIdentities } from "../schema/trust";
import {
  composeFederatedId,
  getServerHostname,
  validateHandle,
} from "@nautilo/config";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";

export type UpdateOwnerHandleResult =
  | { ok: true; handle: string; federatedId: string }
  | { ok: false; reason: string };

/**
 * M042C — atomically rename the owner's handle and rewire the
 * corresponding `channel_identities` rows so no `@old@server` string
 * lingers after the rename. Pre-validation is minimal here (format
 * only); call sites should have already normalized + validated via
 * `normalizeHandle` + `validateHandle`.
 *
 * Rebinding matches only rows whose `external_id` equals the OLD
 * federated id. Rows with channel-native external ids (e.g. a paired
 * Telegram user id) are left untouched.
 */
export async function updateOwnerHandle(
  ownerId: string,
  newHandle: string,
): Promise<UpdateOwnerHandleResult> {
  const validation = validateHandle(newHandle);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const directConnection = resolveDirectDatabaseConnectionString();
  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);
  const server = getServerHostname();
  const newFederatedId = composeFederatedId(newHandle, server);

  try {
    // 1. Read the old handle.
    const [current] = await db
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    const oldHandle = current?.handle ?? null;

    // 2. Short-circuit: same handle.
    if (oldHandle === newHandle) {
      return { ok: true, handle: newHandle, federatedId: newFederatedId };
    }

    // 3. Uniqueness: refuse if another user row already owns the handle.
    //    Single-owner OSS trivially satisfies this; Iteration 2 multi-user
    //    will rely on it.
    //
    //    M047: scope to local users only (`users.server IS NULL`). A
    //    foreign-origin stub `@<newHandle>@remote.com` is a genuinely
    //    different identity under REL-HUM-SRV and must not block the
    //    local owner from picking the same local-part handle.
    const [clash] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.handle, newHandle), isNull(users.server)))
      .limit(1);
    if (clash && clash.id !== ownerId) {
      return { ok: false, reason: "handle already in use" };
    }

    // 4. Write the new handle.
    await db
      .update(users)
      .set({ handle: newHandle, updatedAt: new Date() })
      .where(eq(users.id, ownerId));

    // 5. M043: channel_identities FKs directly to users.id, so the
    //    rebind scope is just the owner's user row. No actor lookup
    //    needed.
    if (oldHandle) {
      const oldFederatedId = composeFederatedId(oldHandle, server);
      // Match only rows whose external_id WAS the old federated id.
      // Paired channels with native external ids (Telegram user id,
      // etc.) are left untouched — they aren't addressed by the
      // federated form.
      await db
        .update(channelIdentities)
        .set({
          externalId: newFederatedId,
          verifiedAt: dsql`COALESCE(${channelIdentities.verifiedAt}, NOW())`,
        })
        .where(
          and(
            eq(channelIdentities.userId, ownerId),
            eq(channelIdentities.externalId, oldFederatedId),
          ),
        );
    }

    return { ok: true, handle: newHandle, federatedId: newFederatedId };
  } finally {
    await sql.end();
  }
}
