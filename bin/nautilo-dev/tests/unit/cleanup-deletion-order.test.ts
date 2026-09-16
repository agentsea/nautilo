/**
 * Stack 198 / D266 — unit tests for the `--apply` deletion-phase ordering
 * helper (`cleanupDeletionOrder` + `assertDeletionOrderInvariant`).
 *
 * Why a pure helper test: `cleanupTestCruft` builds its own
 * `createDirectDb` and runs an inline `db.transaction` — there is no
 * transaction-injection seam, so the live transaction execution cannot
 * be exercised in a no-DB unit test. The ordering invariant that bit
 * production (`profiles_agent_id_agents_id_fk` — `profiles.agent_id →
 * agents.id` is `ON DELETE NO ACTION`, migration 0067_m132) is therefore
 * captured in a pure helper and locked here.
 *
 * Residual coverage limitation: these tests verify the canonical helper,
 * not the live `db.transaction` body. A future edit that reorders the
 * transaction body without updating the helper would NOT be caught by
 * this suite (it would be caught in production by the FK constraint
 * aborting the transaction, which is what happened originally). The
 * `assertDeletionOrderInvariant` call at the top of the transaction
 * guards the helper side of the contract; the transaction body is
 * expected to follow `cleanupDeletionOrder` exactly.
 */
import { describe, expect, test } from "bun:test";
import {
  assertDeletionOrderInvariant,
  cleanupDeletionOrder,
  type CleanupDeletionOrderInput,
} from "../../src/commands/cleanup-test-cruft";

const AGENTS = ["a1", "a2", "a3"];
const SESSIONS = ["s1", "s2"];
const ROOMS = ["r1", "r2"];
const USERS = ["u1", "u2", "u3"];

describe("cleanupDeletionOrder — profiles before agents invariant", () => {
  test("delete-profiles precedes delete-agents when both candidate users and agents exist", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: AGENTS,
      sessionIdList: SESSIONS,
      roomIdList: ROOMS,
      roomNamespaceIds: ROOMS,
      candidateUserIds: USERS,
    });
    const profilesIdx = phases.indexOf("delete-profiles");
    const agentsIdx = phases.indexOf("delete-agents");
    expect(profilesIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(profilesIdx).toBeLessThan(agentsIdx);
  });

  test("delete-profiles appears at most once (no double-delete / double-counting)", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: AGENTS,
      sessionIdList: SESSIONS,
      roomIdList: ROOMS,
      roomNamespaceIds: ROOMS,
      candidateUserIds: USERS,
    });
    const count = phases.filter((p) => p === "delete-profiles").length;
    expect(count).toBe(1);
  });

  test("omits delete-profiles when there are no candidate users (nothing to clear before agents)", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: AGENTS,
      sessionIdList: [],
      roomIdList: [],
      roomNamespaceIds: [],
      candidateUserIds: [],
    });
    expect(phases).not.toContain("delete-profiles");
    expect(phases).toContain("delete-agents");
  });

  test("omits delete-agents when there are no agents (profiles still deleted before users)", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: [],
      sessionIdList: SESSIONS,
      roomIdList: ROOMS,
      roomNamespaceIds: ROOMS,
      candidateUserIds: USERS,
    });
    expect(phases).not.toContain("delete-agents");
    expect(phases).toContain("delete-profiles");
    expect(phases).toContain("delete-users");
    const profilesIdx = phases.indexOf("delete-profiles");
    const usersIdx = phases.indexOf("delete-users");
    expect(profilesIdx).toBeLessThan(usersIdx);
  });

  test("delete-agents precedes delete-users (agents are gone before the owning user row)", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: AGENTS,
      sessionIdList: SESSIONS,
      roomIdList: ROOMS,
      roomNamespaceIds: ROOMS,
      candidateUserIds: USERS,
    });
    const agentsIdx = phases.indexOf("delete-agents");
    const usersIdx = phases.indexOf("delete-users");
    expect(agentsIdx).toBeLessThan(usersIdx);
  });

  test("emits no phases when there is nothing to delete", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: [],
      sessionIdList: [],
      roomIdList: [],
      roomNamespaceIds: [],
      candidateUserIds: [],
    });
    expect(phases).toEqual([]);
  });

  test("full expected phase order for a representative apply run", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: AGENTS,
      sessionIdList: SESSIONS,
      roomIdList: ROOMS,
      roomNamespaceIds: ROOMS,
      candidateUserIds: USERS,
    });
    expect(phases).toEqual([
      "null-session-agent",
      "delete-session-messages",
      "delete-sessions",
      "null-room-refs",
      "delete-memory-namespaces",
      "delete-profiles",
      "delete-agents",
      "delete-approval-challenges",
      "delete-standing-approvals",
      "delete-jobs",
      "delete-users",
    ]);
  });

  test("omits delete-memory-namespaces when rooms exist but no namespace ids are passed", () => {
    const phases = cleanupDeletionOrder({
      agentIdList: AGENTS,
      sessionIdList: [],
      roomIdList: ROOMS,
      roomNamespaceIds: [],
      candidateUserIds: USERS,
    });
    expect(phases).toContain("null-room-refs");
    expect(phases).not.toContain("delete-memory-namespaces");
    // profiles-before-agents still holds.
    expect(phases.indexOf("delete-profiles")).toBeLessThan(
      phases.indexOf("delete-agents"),
    );
  });
});

describe("assertDeletionOrderInvariant", () => {
  test("does not throw for the canonical ordering (profiles before agents, once)", () => {
    expect(() => {
      assertDeletionOrderInvariant({
        agentIdList: AGENTS,
        sessionIdList: SESSIONS,
        roomIdList: ROOMS,
        roomNamespaceIds: ROOMS,
        candidateUserIds: USERS,
      });
    }).not.toThrow();
  });

  test("does not throw when there are no agents (no ordering constraint to violate)", () => {
    expect(() => {
      assertDeletionOrderInvariant({
        agentIdList: [],
        sessionIdList: SESSIONS,
        roomIdList: ROOMS,
        roomNamespaceIds: ROOMS,
        candidateUserIds: USERS,
      });
    }).not.toThrow();
  });

  test("does not throw when there are no candidate users (no profiles phase)", () => {
    expect(() => {
      assertDeletionOrderInvariant({
        agentIdList: AGENTS,
        sessionIdList: [],
        roomIdList: [],
        roomNamespaceIds: [],
        candidateUserIds: [],
      });
    }).not.toThrow();
  });

  test("regression guard: a representative Stack 198 / D266 apply input is accepted", () => {
    // Mirrors the production scenario that aborted: candidate-owned
    // agents + their owning candidate users, with sessions/rooms.
    const input: CleanupDeletionOrderInput = {
      agentIdList: ["agent-owned-by-u1", "agent-owned-by-u2"],
      sessionIdList: ["sess-u1", "sess-u2"],
      roomIdList: ["room-u1"],
      roomNamespaceIds: ["room-u1"],
      candidateUserIds: ["u1", "u2"],
    };
    expect(() => assertDeletionOrderInvariant(input)).not.toThrow();
    const phases = cleanupDeletionOrder(input);
    expect(phases.indexOf("delete-profiles")).toBeLessThan(
      phases.indexOf("delete-agents"),
    );
  });
});
