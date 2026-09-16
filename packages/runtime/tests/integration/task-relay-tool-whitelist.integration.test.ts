/**
 * M150 regression — a Task whose `tools_mode = whitelist` includes a
 * RELAY-executor tool (`run_shell`) must VALIDATE at dispatch time.
 *
 * The reported live-instance failure was:
 *
 *   [task-observer] dispatch failed for task=…: dispatchTaskRun: tool
 *   whitelist rejected for task …: Tool(s) unavailable in this context: run_shell
 *
 * Root cause: `resolveToolWhitelist` ran `validateSubagentToolWhitelist`
 * WITHOUT a relay-capability context, so `ToolCatalog.getFiltered` excluded
 * every `executor: "relay"` tool (`run_shell`, fs writes) as "requires relay
 * but no relay connected" — even when the owner had a relay actually connected.
 * The whitelist was therefore rejected at dispatch and the task errored before
 * it ever ran.
 *
 * Fix (M150): whitelist validation is AUTHORIZATION-only at dispatch
 * (`skipRelayLiveCheck: true`). Relay PRESENCE is gated at run start by the
 * task executor threading live `relayCapabilities` into the run's catalog
 * (D1/R2). So `run_shell` validates at dispatch (the owner is authorized) and
 * is either available (relay live) or silently absent / cloud-only (relay
 * down) at run start — never a dispatch error.
 *
 * Why integration (not unit): this exercises the REAL `PersonalPolicyResolver`
 * + the owner's REAL capability union (owners-group) → the real
 * `envelope.toolPolicy`. The pre-existing unit suites inject a permissive STUB
 * resolver / empty `toolPolicy`, which is exactly why they did not catch this.
 * We call `resolveToolWhitelist` directly (NOT `dispatchTaskRun`) so we do not
 * insert a `pending` task row that the running instance's GLOBAL TaskObserver
 * would claim and execute — no rooms/runs/jobs are created.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  groups,
  groupMembers,
  actors,
  eq,
  and,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import {
  PersonalPolicyResolver,
  initPolicyResolver,
  getPolicyResolver,
  findActorByOwnerId,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import { resolveToolWhitelist } from "../../src/tasks/dispatch-task-run";
import {
  setupTestDb,
  getDirectDb,
  closeDirectDb,
  cleanupTestUserWithDestructivePermission,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";

let db: DirectDatabase;
let userId: string;
let agentId: string;
let ownerGroupId: string | null = null;
let envelope: MemoryAccessEnvelope;

/** Minimal `Task` row carrying only the fields `resolveToolWhitelist` reads. */
function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "m150-task-1",
    depth: 0,
    toolsMode: "auto",
    toolsWhitelist: [],
    ...overrides,
  } as Task;
}

beforeAll(async () => {
  await setupTestDb();
  const env = await setupAgentTestEnv("m150-relay-whitelist");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();

  // Seed the owner's own user actor + canonical owners-Group membership so
  // `getUserCapabilities` resolves the FULL owner capability union (incl.
  // `use_high_impact_tools`), so `run_shell` is NOT marked `forbidden` in the
  // resolved `toolPolicy`. Mirrors task-dispatch-capabilities.integration.test.
  await db.insert(actors).values({
    ownerId: userId,
    kind: "user",
    displayName: "m150-owner",
    trustState: "verified",
  });
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("canonical owners group missing on instance");
  ownerGroupId = ownersGroup.id;
  const [ownerActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.ownerId, userId))
    .limit(1);
  await db
    .insert(groupMembers)
    .values({ groupId: ownersGroup.id, userId, grantedBy: ownerActor!.id })
    .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

  // Use the REAL resolver (not the integration stub) — that is the whole point.
  initPolicyResolver(new PersonalPolicyResolver(userId));

  // Build the run's memory envelope EXACTLY as `dispatchTaskRun` does: the
  // resolver keys capabilities off the requestor's USER ACTOR id (not users.id).
  const requestorActor = await findActorByOwnerId(userId);
  const resolver = getPolicyResolver();
  if (!resolver) throw new Error("policy resolver not initialized");
  envelope = await resolver.buildEnvelope(
    requestorActor?.id ?? userId,
    `task:${makeTask({}).id}`,
    agentId,
    "",
  );
});

afterAll(async () => {
  if (ownerGroupId) {
    await db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, ownerGroupId), eq(groupMembers.userId, userId)));
  }
  await cleanupTestUserWithDestructivePermission(userId);
  await closeAgentDb();
  await closeDirectDb();
});

describe("M150 — relay-tool whitelist validates at dispatch (real resolver)", () => {
  test("a `run_shell` whitelist is ACCEPTED (the live-instance regression)", () => {
    const out = resolveToolWhitelist(
      makeTask({ toolsMode: "whitelist", toolsWhitelist: ["run_shell"] }),
      envelope,
    );
    expect(out).toEqual(["run_shell"]);
  });

  test("a mixed cloud + relay whitelist is accepted", () => {
    const out = resolveToolWhitelist(
      makeTask({ toolsMode: "whitelist", toolsWhitelist: ["search_memory", "run_shell"] }),
      envelope,
    );
    expect(out).toEqual(["search_memory", "run_shell"]);
  });

  test("a cloud-only whitelist still works (no regression)", () => {
    const out = resolveToolWhitelist(
      makeTask({ toolsMode: "whitelist", toolsWhitelist: ["search_memory"] }),
      envelope,
    );
    expect(out).toEqual(["search_memory"]);
  });

  test("an unknown tool is STILL rejected (authorization-only ≠ anything-goes)", () => {
    expect(() =>
      resolveToolWhitelist(
        makeTask({ toolsMode: "whitelist", toolsWhitelist: ["definitely_not_a_tool"] }),
        envelope,
      ),
    ).toThrow(/whitelist rejected/i);
  });

  test("auto mode selects progressive exposure (undefined)", () => {
    expect(resolveToolWhitelist(makeTask({ toolsMode: "auto" }), envelope)).toBeUndefined();
  });
});
