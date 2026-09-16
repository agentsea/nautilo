/**
 * D121-P3 — `artifact_state` query helpers.
 *
 * Reads apply the M082 subset rule by accepting the resolved
 * `readableNamespaceIds` set from `MemoryAccessEnvelope` (just like
 * memory + artifact queries). Writes are upserts on the composite
 * primary key.
 *
 * Cross-namespace state visibility precedence: when the same
 * `(agent_id, artifact_id, key)` exists in multiple readable
 * namespaces (rare today — cross-namespace state sharing isn't a
 * v1 surface) we return the freshest row by `updated_at` desc,
 * mirroring the way memory queries break ties when the same fact
 * is observable from multiple superset namespaces (M082). The
 * `setArtifactState` path writes to a SPECIFIC namespace, so the
 * tie only appears if a future `share_artifact_state` migration
 * runs; the precedence locks the expected behavior now.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type Database } from "../config/database";
import {
  artifactState,
  type ArtifactStateRow,
} from "../schema/artifact-state";

type Db = Database;

/**
 * Resolve the freshest visible value for `(agentId, artifactId, key)`
 * across the caller's readable namespaces. Returns `null` when no
 * row matches — that's a state, not an error.
 *
 * `readableNamespaceIds` MUST be the envelope-resolved set; the
 * helper does not enforce M082 itself.
 */
export async function getArtifactStateForNamespaces(
  params: {
    readableNamespaceIds: string[];
    agentId: string;
    artifactId: string;
    key: string;
  },
  conn: Db = db,
): Promise<ArtifactStateRow | null> {
  if (params.readableNamespaceIds.length === 0) return null;
  const [row] = await conn
    .select()
    .from(artifactState)
    .where(
      and(
        eq(artifactState.agentId, params.agentId),
        eq(artifactState.artifactId, params.artifactId),
        eq(artifactState.key, params.key),
        inArray(artifactState.namespaceId, params.readableNamespaceIds),
      ),
    )
    .orderBy(desc(artifactState.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Upsert state into a specific namespace. The PK is `(namespace_id,
 * agent_id, artifact_id, key)` so two namespaces holding the same
 * key are tracked independently — write isolation by namespace is
 * the load-bearing property.
 *
 * `value` is JSON-serializable; the column is `jsonb` so the driver
 * round-trips any structurally-valid JSON. `updatedAt` is set to
 * `now()` on every upsert via the column default + an explicit
 * `updatedAt: sql\`now()\`` in the SET clause.
 */
export async function setArtifactState(
  params: {
    namespaceId: string;
    agentId: string;
    artifactId: string;
    key: string;
    value: unknown;
  },
  conn: Db = db,
): Promise<ArtifactStateRow> {
  // Drizzle/Postgres bind JS `null` as SQL NULL. This column stores JSON
  // and is NOT NULL, so persist JS null as JSON null (`'null'::jsonb`).
  const jsonbValue = params.value === null ? sql`'null'::jsonb` : params.value;
  const [upserted] = await conn
    .insert(artifactState)
    .values({
      namespaceId: params.namespaceId,
      agentId: params.agentId,
      artifactId: params.artifactId,
      key: params.key,
      value: jsonbValue,
    })
    .onConflictDoUpdate({
      target: [
        artifactState.namespaceId,
        artifactState.agentId,
        artifactState.artifactId,
        artifactState.key,
      ],
      set: {
        value: jsonbValue,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!upserted) throw new Error("setArtifactState returned no row");
  return upserted;
}

/**
 * List every key the caller can read for `(agentId, artifactId)`
 * across readable namespaces. Returns the freshest row per key
 * (same precedence as the single-key getter).
 *
 * Convenience for diagnostic tooling + future "dump artifact state"
 * UI. Not on the v1 server-route surface.
 */
export async function listArtifactStateKeysForNamespaces(
  params: {
    readableNamespaceIds: string[];
    agentId: string;
    artifactId: string;
  },
  conn: Db = db,
): Promise<ArtifactStateRow[]> {
  if (params.readableNamespaceIds.length === 0) return [];
  const rows = await conn
    .select()
    .from(artifactState)
    .where(
      and(
        eq(artifactState.agentId, params.agentId),
        eq(artifactState.artifactId, params.artifactId),
        inArray(artifactState.namespaceId, params.readableNamespaceIds),
      ),
    )
    .orderBy(desc(artifactState.updatedAt));
  // Dedupe by key, keeping the freshest (rows already sorted desc).
  const seen = new Set<string>();
  const out: ArtifactStateRow[] = [];
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

/**
 * Test-only — wipe state rows for a specific artifact. Production
 * code uses the upsert path. Used to clean isolation tests.
 */
export async function _deleteArtifactStateForArtifact(
  params: { agentId: string; artifactId: string },
  conn: Db = db,
): Promise<void> {
  await conn
    .delete(artifactState)
    .where(
      and(
        eq(artifactState.agentId, params.agentId),
        eq(artifactState.artifactId, params.artifactId),
      ),
    );
}
