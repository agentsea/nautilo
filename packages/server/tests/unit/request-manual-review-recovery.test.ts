import { describe, expect, test } from "bun:test";
import {
  encryptionTransitionPolicy, memoryReviewModelRecoveries, memoryReviewReceipts, memoryReviewTurns,
  users,
} from "@nautilo/db";
import {
  ManualMemoryReviewRecoveryPausedError,
  ManualMemoryReviewRecoveryPolicyError,
  manualReviewRecoveryBinding,
  requestManualReviewRecovery,
} from "../../src/lib/request-manual-review-recovery";
import { memoryReviewOrdinaryPolicyAvailable } from "@nautilo/runtime";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const OLD = new Date("2026-11-27T11:00:00.000Z");
const MODEL = "openai:gpt-current";
const COMMITMENT = `hmac-sha256:${"a".repeat(43)}`;

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    generationId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    agentId: "44444444-4444-4444-8444-444444444444",
    roomId: "55555555-5555-4555-8555-555555555555",
    ownerId: "66666666-6666-4666-8666-666666666666",
    actorId: "actor", accessScope: "namespace", threadId: "thread",
    checkpointThreadId: "thread", turnId: "turn", sourceIds: [1],
    firstMessageId: 1, hasHuman: 1, state: "completed",
    acceptedModelBinding: {
      version: 1, kind: "service", role: "memoryReview",
      modelId: "openai:gpt-old", inputCommitment: COMMITMENT,
    },
    attemptId: "77777777-7777-4777-8777-777777777777",
    leaseUntil: null, retryAt: null, failurePhase: "model",
    failureCode: "invalid_proposal", completedAt: OLD, lastAttemptAt: OLD,
    receiptId: null, createdAt: OLD, updatedAt: OLD,
    ...overrides,
  } as typeof memoryReviewTurns.$inferSelect;
}

function fakeDb(input: {
  turns: Array<typeof memoryReviewTurns.$inferSelect>;
  receipt?: Partial<typeof memoryReviewReceipts.$inferSelect>;
  recovery?: typeof memoryReviewModelRecoveries.$inferSelect;
  policy?: Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    shadowBehavior: "fallback" | "strict";
    revision: number;
  }>;
}) {
  const inserted: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const updated: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const tx = {
    execute: async () => { calls.push("policy-lock"); return []; },
    select: () => ({
      from: (table: unknown) => {
        const rows = table === encryptionTransitionPolicy
          ? [input.policy ?? { mode: "plaintext_only", shadowBehavior: "fallback", revision: 1 }]
          : table === memoryReviewTurns ? input.turns
          : table === memoryReviewReceipts ? (input.receipt ? [input.receipt] : [])
          : table === memoryReviewModelRecoveries ? (input.recovery ? [input.recovery] : [])
          : table === users ? [{ id: "88888888-8888-4888-8888-888888888888" }]
          : [];
        calls.push(table === encryptionTransitionPolicy ? "policy-read" : "work-read");
        const builder: Record<string, unknown> = {};
        builder["where"] = () => builder;
        builder["orderBy"] = () => builder;
        builder["for"] = () => builder;
        builder["limit"] = async () => rows;
        builder["then"] = (resolve: (value: unknown) => void) => resolve(rows);
        return builder;
      },
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => { inserted.push({ table, value }); },
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => { updated.push({ table, value }); },
      }),
    }),
  };
  return {
    db: { transaction: async <T>(run: (value: typeof tx) => Promise<T>) => run(tx) },
    inserted,
    updated,
    calls,
  };
}

describe("manual Memory-review recovery", () => {
  test("admits ordinary recovery only in Plaintext and Fallback Shadow", () => {
    expect(memoryReviewOrdinaryPolicyAvailable({
      mode: "plaintext_only", shadowBehavior: "fallback", revision: 1,
    })).toBe(true);
    expect(memoryReviewOrdinaryPolicyAvailable({
      mode: "shadow_encryption", shadowBehavior: "fallback", revision: 2,
    })).toBe(true);
    expect(memoryReviewOrdinaryPolicyAvailable({
      mode: "shadow_encryption", shadowBehavior: "strict", revision: 3,
    })).toBe(false);
    expect(memoryReviewOrdinaryPolicyAvailable({
      mode: "encrypted_only", shadowBehavior: "strict", revision: 4,
    })).toBe(false);
  });

  test("takes the policy fence before bulk discovery and leaves intent untouched when Strict blocks ordinary review", async () => {
    const fixture = fakeDb({
      turns: [turn()],
      policy: { mode: "shadow_encryption", shadowBehavior: "strict", revision: 3 },
    });
    const rejection = await requestManualReviewRecovery({
      db: fixture.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: "88888888-8888-4888-8888-888888888888", modelId: MODEL,
      enabledByDefault: true,
      maintenanceAccepting: async () => true,
    }).then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(ManualMemoryReviewRecoveryPolicyError);
    expect(fixture.calls).toEqual(["policy-lock", "policy-read"]);
    expect(fixture.inserted).toHaveLength(0);
    expect(fixture.updated).toHaveLength(0);
  });

  test("checks durable enablement on the fenced transaction before discovering work", async () => {
    const fixture = fakeDb({ turns: [turn()] });
    const rejection = await requestManualReviewRecovery({
      db: fixture.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: "88888888-8888-4888-8888-888888888888", modelId: MODEL,
      enabledByDefault: false,
      maintenanceAccepting: async () => true,
    }).then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(ManualMemoryReviewRecoveryPausedError);
    expect(fixture.calls.slice(0, 3)).toEqual(["policy-lock", "policy-read", "work-read"]);
    expect(fixture.inserted).toHaveLength(0);
    expect(fixture.updated).toHaveLength(0);
  });

  test("preserves service operation identity while rebinding the current model and never converts personal funding", () => {
    const service = turn().acceptedModelBinding;
    if (service === null) throw new Error("expected service fixture");
    expect(manualReviewRecoveryBinding(service, MODEL)).toEqual({
      ...service,
      modelId: MODEL,
    });
    expect(manualReviewRecoveryBinding({ kind: "service", modelId: "legacy" }, MODEL))
      .toEqual({ kind: "service", modelId: MODEL });
    expect(manualReviewRecoveryBinding(null, MODEL)).toBeNull();
    expect(manualReviewRecoveryBinding({
      version: 1, kind: "human", role: "memoryReview", modelId: "personal",
      inputCommitment: COMMITMENT, humanUserId: "human", preferenceRevision: 1,
      funding: { kind: "personal", providerRoute: "openai",
        credentialId: "99999999-9999-4999-8999-999999999999", credentialRevision: 1 },
    }, MODEL)).toBeNull();
  });

  test("queues one explicit fresh attempt for a safely failed service review", async () => {
    const fixture = fakeDb({ turns: [turn()], receipt: {
      id: turn().attemptId!, workId: turn().generationId,
      outcome: "failed", code: "invalid_proposal", createdAt: OLD,
    } });
    expect(await requestManualReviewRecovery({
      db: fixture.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: "88888888-8888-4888-8888-888888888888", modelId: MODEL,
      enabledByDefault: true,
      maintenanceAccepting: async () => true,
    })).toEqual({ queued: 1, held: 0 });
    expect(fixture.inserted).toHaveLength(1);
    expect(fixture.inserted[0]?.table).toBe(memoryReviewModelRecoveries);
    expect(fixture.inserted[0]?.value).toMatchObject({
      workId: turn().generationId,
      blockedAttemptId: turn().attemptId,
      turnIds: [turn().id],
    });
    expect(fixture.updated.find(value => value.table === memoryReviewTurns)?.value)
      .toMatchObject({ acceptedModelBinding: { kind: "service", role: "memoryReview", modelId: MODEL } });
  });

  test("authorizes a fresh current-model attempt after a direct legacy service outcome is unknown", async () => {
    const blocked = turn({
      acceptedModelBinding: { kind: "service", modelId: "direct:legacy" },
      failureCode: "provider_outcome_unknown",
    });
    const fixture = fakeDb({ turns: [blocked], receipt: {
      id: blocked.attemptId!, workId: blocked.generationId,
      outcome: "failed", code: "provider_outcome_unknown", createdAt: OLD,
    } });
    expect(await requestManualReviewRecovery({
      db: fixture.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: blocked.ownerId, modelId: MODEL,
      enabledByDefault: true,
      maintenanceAccepting: async () => true,
    })).toEqual({ queued: 1, held: 0 });
    expect(fixture.updated.find(value => value.table === memoryReviewTurns)?.value)
      .toMatchObject({ acceptedModelBinding: { kind: "service", modelId: MODEL } });
  });

  test("holds publication uncertainty, personal work, and failures newer than the observation", async () => {
    const cases = [
      turn({ failurePhase: "publication", failureCode: "publication_uncertain" }),
      turn({ acceptedModelBinding: null }),
      turn({ acceptedModelBinding: {
        version: 1, kind: "human", role: "memoryReview", modelId: "personal",
        inputCommitment: COMMITMENT, humanUserId: "human", preferenceRevision: 1,
        funding: { kind: "personal", providerRoute: "openai" },
      } }),
      turn({ updatedAt: new Date(NOW.getTime() + 1) }),
    ];
    for (const held of cases) {
      const fixture = fakeDb({ turns: [held] });
      expect(await requestManualReviewRecovery({
        db: fixture.db as never, now: NOW, observedThrough: NOW,
        authorizedBy: "88888888-8888-4888-8888-888888888888", modelId: MODEL,
        enabledByDefault: true,
        maintenanceAccepting: async () => true,
      })).toEqual({ queued: 0, held: 1 });
      expect(fixture.inserted).toHaveLength(0);
      expect(fixture.updated).toHaveLength(0);
    }
  });

  test("deduplicates a pending click and permits a later intent only for the terminal recovery attempt", async () => {
    const current = turn();
    const pending = {
      workId: current.generationId, headTurnId: current.id,
      authorizedBy: current.ownerId, authorizedAt: OLD,
      blockedAttemptId: current.attemptId!, turnIds: [current.id],
      spentAt: null, recoveryAttemptId: null,
    } satisfies typeof memoryReviewModelRecoveries.$inferSelect;
    const duplicate = fakeDb({ turns: [current], recovery: pending });
    expect(await requestManualReviewRecovery({
      db: duplicate.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: current.ownerId, modelId: "openai:gpt-old",
      enabledByDefault: true,
      maintenanceAccepting: async () => true,
    })).toEqual({ queued: 0, held: 0 });
    expect(duplicate.inserted).toHaveLength(0);
    expect(duplicate.updated).toHaveLength(0);

    const changedInput = fakeDb({
      turns: [{ ...current, updatedAt: NOW }],
      recovery: pending,
    });
    expect(await requestManualReviewRecovery({
      db: changedInput.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: current.ownerId, modelId: "openai:gpt-old",
      enabledByDefault: true,
      maintenanceAccepting: async () => true,
    })).toEqual({ queued: 1, held: 0 });
    expect(changedInput.updated.find(value => value.table === memoryReviewModelRecoveries)?.value)
      .toMatchObject({ authorizedAt: NOW, blockedAttemptId: current.attemptId });

    const priorAttempt = "99999999-9999-4999-8999-999999999999";
    const terminal = fakeDb({ turns: [current], recovery: {
      ...pending,
      blockedAttemptId: priorAttempt,
      recoveryAttemptId: current.attemptId,
      spentAt: OLD,
    } });
    expect(await requestManualReviewRecovery({
      db: terminal.db as never, now: NOW, observedThrough: NOW,
      authorizedBy: current.ownerId, modelId: MODEL,
      enabledByDefault: true,
      maintenanceAccepting: async () => true,
    })).toEqual({ queued: 1, held: 0 });
    expect(terminal.updated.find(value => value.table === memoryReviewModelRecoveries)?.value)
      .toMatchObject({ blockedAttemptId: current.attemptId, recoveryAttemptId: null, spentAt: null });
  });
});
