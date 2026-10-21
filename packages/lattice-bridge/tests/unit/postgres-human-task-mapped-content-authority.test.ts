import { expect, test } from "bun:test";
import { encryptionTransitionPolicy, tasks, taskRuns, type PostgresJsBridgeConnection } from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { ConversationProductCanonicalTransactionRunner } from "../../src/server/message/postgres-conversation-product-store";
import { withCurrentHumanTaskMappedContentAuthority } from "../../src/server/task/postgres-human-task-mapped-content-authority";
import { setup } from "../fixtures/human-task-mapped-content";

const TASK = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000002";
const HUMAN = "30000000-0000-4000-8000-000000000003";
const NS = "40000000-0000-4000-8000-000000000004";

// Exercise the real policy/source gate. Stop at the next prerequisite so this
// test cannot accidentally claim that its metadata rows authorize a repair.
test.each([
  ["dual", "encrypted_only", true],
  ["dual", "shadow_encryption", true],
  ["protected", "encrypted_only", true],
  ["protected", "shadow_encryption", false],
  ["dual", "plaintext_only", false],
  ["ordinary", "encrypted_only", false],
] as const)("Human mapped-head source %s under %s preserves current authority prerequisites", async (representation, mode, eligible) => {
  const checked: unknown[] = [];
  const nextPrerequisite = new Error("canonical Run and grant checks still required");
  const tx = {
    execute: async () => [],
    select: () => ({ from: (table: unknown) => {
      checked.push(table);
      if (table === taskRuns) throw nextPrerequisite;
      const value = table === encryptionTransitionPolicy
        ? { mode, shadowBehavior: "strict", revision: 9 }
        : { id: TASK, ownerId: USER, requestorId: USER, agentId: HUMAN,
          contentNamespaceId: NS, contentRepresentation: representation,
          cryptoMappingState: "verified", fireLockId: null, status: "paused" };
      const chain = { where: () => chain, for: async () => [value],
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([value]).then(resolve) };
      return chain;
    } }),
  };
  const runner = { transaction: async (use: (transaction: typeof tx, executor: unknown) => Promise<unknown>) => use(tx, {}) } as unknown as ConversationProductCanonicalTransactionRunner;
  const result = withCurrentHumanTaskMappedContentAuthority({
    runner, restricted: {} as PostgresJsBridgeConnection, crypto: new LatticeCrypto(),
    serverScope: "https://nautilo.example", sourceRoomId: NS,
    coordinate: { kind: "definition", taskId: TASK, contentRevision: 1 },
    expectedPolicyRevision: 9, now: () => 1000,
    subject: { userId: USER, humanActorId: HUMAN, admission: {
      status: "admitted", deviceId: "device", deviceGeneration: 1,
      serverInstanceId: "server", lineageGeneration: 1, epoch: 1,
      securityRevision: 1, headDigest: new Uint8Array(32), expiresAt: 2000,
    } },
    use: async () => { throw new Error("unverified fixtures must never lend repair custody"); },
  });
  if (eligible) {
    await Promise.resolve(expect(result).rejects.toBe(nextPrerequisite));
    expect(checked).toEqual([encryptionTransitionPolicy, tasks, taskRuns]);
  } else {
    expect(await result).toBeNull();
    expect(checked).not.toContain(taskRuns);
  }
});

test("Human mapped authority keeps stored Task executor proof when the source Room Agent differs", async () => {
  const fixture = await setup("agent");
  try {
    fixture.sourceAgent("different-source-agent");
    let expectedAgentId: string | undefined;
    const result = await withCurrentHumanTaskMappedContentAuthority({
      ...fixture.input,
      use: async (context) => {
        expectedAgentId = context.expectedAgentId;
        return "held";
      },
    });
    expect(result).toBe("held");
    expect(expectedAgentId).toBe(fixture.taskAgentId);
    expect(fixture.events).not.toContain("room_members");
  } finally {
    fixture.cleanup();
  }
});

test.each([
  ["wrong Human", (fixture: Awaited<ReturnType<typeof setup>>) => fixture.wrongSourceHuman()],
  ["extra Agent", (fixture: Awaited<ReturnType<typeof setup>>) => fixture.addSourceAgent()],
] as const)("Human mapped authority rejects a source Room with %s", async (_scenario, change) => {
  const fixture = await setup("agent");
  try {
    change(fixture);
    let used = false;
    const result = await withCurrentHumanTaskMappedContentAuthority({
      ...fixture.input,
      use: async () => {
        used = true;
        return "held";
      },
    });
    expect(result).toBeNull();
    expect(used).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
