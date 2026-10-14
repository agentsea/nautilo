import { and, asc, eq, gt } from "drizzle-orm";
import type { Database } from "../config/database";
import { chatgptRegistrations, type ChatGPTRegistrationRecord } from "../schema/chatgpt-registrations";
import { nautiloInstanceIdentity } from "../schema/instance-identity";
import { users } from "../schema/users";

export async function listChatGPTRegistrations(db: Database, userId: string): Promise<ChatGPTRegistrationRecord[]> {
  return db.select().from(chatgptRegistrations).where(eq(chatgptRegistrations.userId, userId))
    .orderBy(asc(chatgptRegistrations.createdAt), asc(chatgptRegistrations.id));
}

export async function getChatGPTRegistration(db: Database, userId: string, id: string): Promise<ChatGPTRegistrationRecord | null> {
  const [row] = await db.select().from(chatgptRegistrations)
    .where(and(eq(chatgptRegistrations.userId, userId), eq(chatgptRegistrations.id, id))).limit(1);
  return row ?? null;
}

export async function getSelectedChatGPTRegistration(db: Database, userId: string): Promise<ChatGPTRegistrationRecord | null> {
  const [row] = await db.select().from(chatgptRegistrations)
    .where(and(eq(chatgptRegistrations.userId, userId), eq(chatgptRegistrations.selected, true))).limit(1);
  return row ?? null;
}

/** The singleton is the durable identity, never a deployment label or hostname. */
export async function getChatGPTRuntimeIdentity(db: Database): Promise<string> {
  const [row] = await db.select({ id: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
  if (!row) throw new Error("Server identity unavailable");
  return row.id;
}

export async function insertChatGPTRegistration(db: Database, record: typeof chatgptRegistrations.$inferInsert): Promise<boolean> {
  const rows = await db.insert(chatgptRegistrations).values(record).onConflictDoNothing().returning({ id: chatgptRegistrations.id });
  return rows.length === 1;
}

type RegistrationMutation = Pick<ChatGPTRegistrationRecord, "state" | "envelope" | "identityEnvelope" | "authorityRevision" | "tokenGeneration">;

/**
 * Hold the row lock through token rotation, not just through the final write.
 * This serializes refresh/revoke across workers using the same registration.
 * Callback errors roll back; callbacks must not perform inference/tool effects.
 */
export async function withLockedChatGPTRegistration<T>(db: Database, userId: string, id: string,
  action: (row: ChatGPTRegistrationRecord) => Promise<{ result: T; mutation?: RegistrationMutation }>): Promise<T> {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(chatgptRegistrations)
      .where(and(eq(chatgptRegistrations.userId, userId), eq(chatgptRegistrations.id, id)))
      .limit(1).for("update");
    if (!row) throw new Error("ChatGPT registration unavailable");
    const { result, mutation } = await action(row);
    if (mutation) {
      await tx.update(chatgptRegistrations).set({ ...mutation, updatedAt: new Date() })
        .where(and(eq(chatgptRegistrations.userId, userId), eq(chatgptRegistrations.id, id)));
    }
    return result;
  });
}

/** Explicit source selection; disconnect deliberately keeps selection pinned. */
export async function selectChatGPTRegistration(db: Database, userId: string, id: string | null): Promise<boolean> {
  return db.transaction(async tx => {
    // Lock the parent to serialize concurrent selection even for an empty list.
    const [human] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!human) return false;
    if (id !== null) {
      const [selected] = await tx.select({ id: chatgptRegistrations.id }).from(chatgptRegistrations)
        .where(and(eq(chatgptRegistrations.userId, userId), eq(chatgptRegistrations.id, id), eq(chatgptRegistrations.state, "connected")))
        .limit(1).for("update");
      if (!selected) return false;
    }
    await tx.update(chatgptRegistrations).set({ selected: false }).where(eq(chatgptRegistrations.userId, userId));
    if (id !== null) await tx.update(chatgptRegistrations).set({ selected: true })
      .where(and(eq(chatgptRegistrations.userId, userId), eq(chatgptRegistrations.id, id)));
    return true;
  });
}

/** Complete keyset traversal used by custody diagnostics; no registration cap. */
export async function listChatGPTRegistrationsForCustody(db: Database, input: { afterId?: string; limit: number }): Promise<ChatGPTRegistrationRecord[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Invalid custody page size");
  return db.select().from(chatgptRegistrations)
    .where(input.afterId === undefined ? undefined : gt(chatgptRegistrations.id, input.afterId))
    .orderBy(asc(chatgptRegistrations.id)).limit(input.limit);
}
