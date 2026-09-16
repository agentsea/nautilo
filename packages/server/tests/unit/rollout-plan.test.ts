import { describe, expect, test } from "bun:test";
import { buildRolloutPlan } from "../../src/lib/rollout-plan";

const base = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  policyRevision: "roles-v1",
  callerRank: 1,
  existingHandleKeys: new Set<string>(),
  identityCollision: async () => false,
};

describe("rollout plan", () => {
  test("normalizes a secret-free manifest into deterministic operations", async () => {
    const manifest = {
      schemaVersion: 1,
      members: [
        { handle: " Alice_1 ", displayName: " Alice ", email: "ALICE@example.com", roleSlug: "member" },
        { handle: "bob_2", displayName: "Bob", roleSlug: "guest" },
      ],
    };
    const first = await buildRolloutPlan({ ...base, manifest });
    const second = await buildRolloutPlan({ ...base, manifest });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected plan");
    expect(first.operations).toHaveLength(2);
    expect(first.operations[0]).toMatchObject({
      handle: "alice_1",
      displayName: "Alice",
      email: "alice@example.com",
      roleSlug: "member",
      index: 0,
    });
    expect(first.operations[0]?.idempotencyKey).toContain(first.fingerprint);
  });

  test("rejects secret fields at any depth before collision I/O", async () => {
    let calls = 0;
    const result = await buildRolloutPlan({
      ...base,
      manifest: {
        schemaVersion: 1,
        members: [{ handle: "alice_1", displayName: "Alice", roleSlug: "member", metadata: { password: "no" } }],
      },
      identityCollision: async () => { calls += 1; return false; },
    });
    expect(result).toMatchObject({ ok: false, code: "secret_field_forbidden" });
    expect(calls).toBe(0);
  });

  test("rejects Unicode-normalized duplicates and delegation escalation", async () => {
    const duplicate = await buildRolloutPlan({
      ...base,
      manifest: {
        schemaVersion: 1,
        members: [
          { handle: "alice_1", displayName: "A", roleSlug: "member" },
          { handle: "ALICE_1", displayName: "B", roleSlug: "guest" },
        ],
      },
    });
    expect(duplicate).toMatchObject({ ok: false, code: "duplicate_handle", index: 1 });

    const escalation = await buildRolloutPlan({
      ...base,
      callerRank: 3,
      manifest: {
        schemaVersion: 1,
        members: [{ handle: "alice_2", displayName: "A", roleSlug: "admin" }],
      },
    });
    expect(escalation).toMatchObject({ ok: false, code: "delegation_ceiling", index: 0 });
  });

  test("binds the fingerprint to server and policy identity and reports collisions", async () => {
    const manifest = {
      schemaVersion: 1,
      members: [{ handle: "alice_3", displayName: "A", roleSlug: "member" }],
    };
    const one = await buildRolloutPlan({ ...base, manifest });
    const two = await buildRolloutPlan({ ...base, manifest, serverInstanceId: "22222222-2222-4222-8222-222222222222" });
    expect(one.ok && two.ok && one.fingerprint).not.toBe(two.ok && two.fingerprint);
    const changedPolicy = await buildRolloutPlan({ ...base, manifest, policyRevision: "roles-v2" });
    expect(one.ok && changedPolicy.ok && one.fingerprint).not.toBe(changedPolicy.ok && changedPolicy.fingerprint);

    const collision = await buildRolloutPlan({
      ...base,
      manifest,
      identityCollision: async () => true,
    });
    expect(collision).toMatchObject({ ok: false, code: "identity_collision", index: 0 });
  });
});
