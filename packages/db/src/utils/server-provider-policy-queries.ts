import { eq } from "drizzle-orm";
import type { Database } from "../config/database";
import {
  serverProviderPolicy,
  type ServerProviderPolicyRow,
} from "../schema/server-provider-policy";

const SERVER_PROVIDER_POLICY_ID = "server";

export interface ResolvedServerProviderPolicy {
  allowPersonalProviderKeys: boolean;
}

export type ServerProviderPolicyDb = Pick<Database, "insert" | "select">;

/** A missing row is an intentional default-off state; a failed read still throws. */
export function resolveServerProviderPolicy(
  row: Pick<ServerProviderPolicyRow, "allowPersonalProviderKeys"> | null | undefined,
): ResolvedServerProviderPolicy {
  return { allowPersonalProviderKeys: row?.allowPersonalProviderKeys === true };
}

/** Read for each personal-key admission so an off change needs no restart. */
export async function getServerProviderPolicy(
  db: ServerProviderPolicyDb,
): Promise<ResolvedServerProviderPolicy> {
  const [row] = await db
    .select()
    .from(serverProviderPolicy)
    .where(eq(serverProviderPolicy.id, SERVER_PROVIDER_POLICY_ID));
  return resolveServerProviderPolicy(row ?? null);
}

export async function upsertServerProviderPolicy(
  db: ServerProviderPolicyDb,
  patch: ResolvedServerProviderPolicy,
): Promise<ResolvedServerProviderPolicy> {
  const [row] = await db
    .insert(serverProviderPolicy)
    .values({
      id: SERVER_PROVIDER_POLICY_ID,
      allowPersonalProviderKeys: patch.allowPersonalProviderKeys,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: serverProviderPolicy.id,
      set: {
        allowPersonalProviderKeys: patch.allowPersonalProviderKeys,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Server provider policy write returned no row");
  return resolveServerProviderPolicy(row);
}
