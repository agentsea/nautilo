import { eq } from "drizzle-orm";
import type { Database } from "../config/database";
import {
  serverProviderPolicy,
  type ServerProviderFundingPreference,
  type ServerProviderPolicyRow,
} from "../schema/server-provider-policy";

const SERVER_PROVIDER_POLICY_ID = "server";

export interface ResolvedServerProviderPolicy {
  allowPersonalProviderKeys: boolean;
  fundingPreference: ServerProviderFundingPreference;
}

export interface ServerProviderPolicyUpdate {
  allowPersonalProviderKeys?: boolean;
  fundingPreference?: ServerProviderFundingPreference;
}

export interface ServerProviderPolicyChange {
  previous: ResolvedServerProviderPolicy;
  effective: ResolvedServerProviderPolicy;
}

export type ServerProviderPolicyDb = Pick<Database, "select">;

/** A missing row is an intentional default-off state; a failed read still throws. */
export function resolveServerProviderPolicy(
  row: Pick<ServerProviderPolicyRow, "allowPersonalProviderKeys" | "fundingPreference">
    | null
    | undefined,
): ResolvedServerProviderPolicy {
  return {
    allowPersonalProviderKeys: row?.allowPersonalProviderKeys === true,
    fundingPreference: row?.fundingPreference === "server_first"
      ? "server_first"
      : "personal_first",
  };
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
  db: Pick<Database, "transaction">,
  patch: ServerProviderPolicyUpdate,
): Promise<ServerProviderPolicyChange> {
  if (patch.allowPersonalProviderKeys === undefined && patch.fundingPreference === undefined) {
    throw new Error("Server provider policy update must not be empty");
  }
  return db.transaction(async (tx) => {
    // Ensure there is a row to lock even on the first update. A concurrent
    // first insert waits on the unique key, then reads the committed value.
    await tx.insert(serverProviderPolicy)
      .values({ id: SERVER_PROVIDER_POLICY_ID })
      .onConflictDoNothing({ target: serverProviderPolicy.id });
    const [before] = await tx.select({
      allowPersonalProviderKeys: serverProviderPolicy.allowPersonalProviderKeys,
      fundingPreference: serverProviderPolicy.fundingPreference,
    }).from(serverProviderPolicy)
      .where(eq(serverProviderPolicy.id, SERVER_PROVIDER_POLICY_ID))
      .for("update");
    if (!before) throw new Error("Server provider policy row is unavailable");

    const [after] = await tx.update(serverProviderPolicy)
      .set({
        ...(patch.allowPersonalProviderKeys === undefined
          ? {}
          : { allowPersonalProviderKeys: patch.allowPersonalProviderKeys }),
        ...(patch.fundingPreference === undefined
          ? {}
          : { fundingPreference: patch.fundingPreference }),
        updatedAt: new Date(),
      })
      .where(eq(serverProviderPolicy.id, SERVER_PROVIDER_POLICY_ID))
      .returning();
    if (!after) throw new Error("Server provider policy write returned no row");
    return {
      previous: resolveServerProviderPolicy(before),
      effective: resolveServerProviderPolicy(after),
    };
  });
}
