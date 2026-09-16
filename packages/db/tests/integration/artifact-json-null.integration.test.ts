import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../../src/config/database";
import type { agents as agentsTable } from "../../src/schema/agents";
import type { namespaces as namespacesTable } from "../../src/schema/trust";
import type { artifactState as artifactStateTable } from "../../src/schema/artifact-state";
import type { pendingArtifactEvents as pendingArtifactEventsTable } from "../../src/schema/pending-artifact-events";
import type { setArtifactState as setArtifactStateFn } from "../../src/queries/artifact-state";
import type {
  appendPendingArtifactEvent as appendPendingArtifactEventFn,
  drainPendingArtifactEventsForNamespaces as drainPendingArtifactEventsForNamespacesFn,
} from "../../src/queries/pending-artifact-events";

const NS = "11111111-1111-4111-8111-111111111266";
const AG = "22222222-2222-4222-8222-222222222266";
const ARTIFACT = "artifact-json-null-d266";

let db: Database | undefined;
let sqlTag: typeof import("drizzle-orm").sql;
let agents: typeof agentsTable;
let namespaces: typeof namespacesTable;
let artifactState: typeof artifactStateTable;
let pendingArtifactEvents: typeof pendingArtifactEventsTable;
let setArtifactState: typeof setArtifactStateFn;
let appendPendingArtifactEvent: typeof appendPendingArtifactEventFn;
let drainPendingArtifactEventsForNamespaces: typeof drainPendingArtifactEventsForNamespacesFn;

describe("artifact JSON null persistence", () => {
  beforeAll(async () => {
    if (!process.env["DB_CONNECTION_STRING"]) {
      console.warn("Skipping artifact JSON null integration test: DB_CONNECTION_STRING unset.");
      return;
    }
    const drizzle = await import("drizzle-orm");
    sqlTag = drizzle.sql;
    ({ db } = await import("../../src/config/database"));
    ({ agents } = await import("../../src/schema/agents"));
    ({ namespaces } = await import("../../src/schema/trust"));
    ({ artifactState } = await import("../../src/schema/artifact-state"));
    ({ pendingArtifactEvents } = await import("../../src/schema/pending-artifact-events"));
    ({ setArtifactState } = await import("../../src/queries/artifact-state"));
    ({
      appendPendingArtifactEvent,
      drainPendingArtifactEventsForNamespaces,
    } = await import("../../src/queries/pending-artifact-events"));

    await db.insert(agents).values({ id: AG, handle: "ag-json-null-d266" }).onConflictDoNothing();
    await db
      .insert(namespaces)
      .values({ id: NS, scope: "agent", label: "json-null-d266" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(pendingArtifactEvents).where(sqlTag`${pendingArtifactEvents.artifactId} = ${ARTIFACT}`);
    await db.delete(artifactState).where(sqlTag`${artifactState.artifactId} = ${ARTIFACT}`);
    await db.execute(sqlTag`DELETE FROM namespaces WHERE id = ${NS}`);
    await db.delete(agents).where(sqlTag`${agents.id} = ${AG}`);
  });

  test("setArtifactState stores JS null as JSON null, not SQL NULL", async () => {
    if (!db) return;
    const row = await setArtifactState({
      namespaceId: NS,
      agentId: AG,
      artifactId: ARTIFACT,
      key: "cleared",
      value: null,
    });

    expect(row.value).toBeNull();
  });

  test("appendPendingArtifactEvent stores JS null payload as JSON null", async () => {
    if (!db) return;
    await appendPendingArtifactEvent({
      namespaceId: NS,
      agentId: AG,
      artifactId: ARTIFACT,
      topic: "null_payload",
      payload: null,
    });

    const drained = await drainPendingArtifactEventsForNamespaces({
      readableNamespaceIds: [NS],
      agentId: AG,
      artifactId: ARTIFACT,
    });

    expect(drained).toHaveLength(1);
    expect(drained[0]?.payload).toBeNull();
  });
});
