import { describe, expect, test } from "bun:test";

import {
  ClassifiedDataOperationError,
  StrictShadowEnforcementError,
  type ForegroundRecordHistoryResult,
} from "@nautilo/lattice-bridge";
import type { LiveShadowAgentTurnSession } from
  "@nautilo/lattice-bridge/server";

import {
  createLiveShadowForegroundTurnCandidate as createForegroundCandidate,
  createLiveShadowDataOperationPolicyBinding,
  enforceLiveShadowForegroundHistoryBoundary,
  getCurrentLiveShadowTurnContext,
  protectLiveShadowForegroundHistory,
  protectLiveShadowForegroundJournal,
  protectLiveShadowForegroundMemories,
  protectLiveShadowForegroundRecordContext,
  protectLiveShadowForegroundRecordRecall,
  runWithLiveShadowTurnSession,
} from "../../src/conversation/live-shadow-turn-context";
import { createPersistingProcessor } from
  "../../src/executors/persisting-processor";
import { Job } from "../../src/job";

function capability(operationId: string) {
  return Object.freeze({
    kind: "foreground_session" as const,
    sessionReference: `foreground-session:${operationId}`,
    authorizationDigest: new Uint8Array(32).fill(0xa1),
    scope: Object.freeze({
      subjectHumanId: "human-a",
      issuingDeviceId: "device-a",
      recipientAgentId: "agent-a",
      sessionId: "session-a",
      roomId: "room-a",
      policyRevision: 1,
      hostAuthorizationRevision: 1,
      agentAuthorizationRevision: 1,
      namespaceIds: Object.freeze(["namespace-a"]),
      grantDomainIds: Object.freeze(["domain-a"]),
      domainAuthoritySetDigest: new Uint8Array(32).fill(0xa2),
    }),
  });
}

function createLiveShadowForegroundTurnCandidate(
  input: Omit<Parameters<typeof createForegroundCandidate>[0], "dataOperationPolicy">,
) {
  const policy = input.enforcementPolicy ?? {
    mode: "shadow_encryption" as const,
    shadowBehavior: "fallback" as const,
    revision: 0,
  };
  return createForegroundCandidate({
    ...input,
    dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
      () => Promise.resolve(policy),
    ),
  });
}

describe("V2 live Shadow turn execution context", () => {
  test("revalidates Runtime operations against the current policy revision", async () => {
    let revision = 11;
    const binding = createLiveShadowDataOperationPolicyBinding(async () => ({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision,
    }));

    const resolved = await binding.resolve();
    expect(resolved.revalidationToken).toBe(11);
    revision = 12;
    try {
      await binding.revalidate(resolved.revalidationToken);
      throw new Error("expected stale policy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ClassifiedDataOperationError);
      expect((error as ClassifiedDataOperationError).failureClass).toBe("stale");
    }
  });

  test("rejects changed admission policy before History, Journal, or Memory loaders", async () => {
    for (const family of ["history", "journal", "memory"] as const) {
      let protectedCalls = 0;
      let ordinaryCalls = 0;
      const session = {
        protectForegroundHistory: () => { protectedCalls += 1; throw new Error("unused"); },
        protectForegroundJournal: () => { protectedCalls += 1; throw new Error("unused"); },
        protectForegroundMemories: () => { protectedCalls += 1; throw new Error("unused"); },
      } as unknown as LiveShadowAgentTurnSession;
      const operationId = `stale-${family}`;
      const candidate = createForegroundCandidate({
        operationId,
        capability: capability(operationId),
        enforcementPolicy: {
          mode: "shadow_encryption",
          shadowBehavior: "fallback",
          revision: 30,
        },
        dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
          () => Promise.resolve({
            mode: "encrypted_only",
            shadowBehavior: "strict",
            revision: 31,
          }),
        ),
        runAgentTurn: async (input) => ({
          status: "executed" as const,
          value: await input.work(session),
        }),
      });
      candidate.onMainTurn(operationId);
      if (candidate.runMainTurn === undefined) throw new Error("runner missing");
      const work = family === "history"
        ? () => protectLiveShadowForegroundHistory([{
            messageId: 1,
            ts: new Date(0),
            role: "user" as const,
            authorDisplayName: "Human",
            handle: "human",
            authorActorId: "actor-human",
            snippet: "ordinary",
          }])
        : family === "journal"
        ? () => protectLiveShadowForegroundJournal(() => {
            ordinaryCalls += 1;
            return Promise.resolve({ rollup: null, events: [] });
          })
        : () => protectLiveShadowForegroundMemories(() => {
            ordinaryCalls += 1;
            return Promise.resolve([]);
          });
      const result = await candidate.runMainTurn(operationId, async () => { await work(); })
        .then(() => null, (error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("admission policy changed");
      expect(protectedCalls).toBe(0);
      expect(ordinaryCalls).toBe(0);
    }
  });
  test("Full Runtime grants without an Agent session retain protected Job publication", async () => {
    const roomId = "20000000-0000-4000-8000-000000000318";
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "runtime-execution-full-318",
      enforcementPolicy: { mode: "encrypted_only", shadowBehavior: "fallback", revision: 40 },
      capability: {
        kind: "foreground_session",
        sessionReference: "runtime-grant-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: "human", issuingDeviceId: "device",
          recipientKind: "nautilo_foreground_runtime",
          browserSessionId: "browser-session-is-not-a-product-session",
          topLevelRoomId: roomId, policyRevision: 40, hostAuthorizationRevision: 1,
          namespaceIds: ["namespace"], grantDomainIds: ["domain"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      },
    });
    expect(candidate.durableJobInputDisposition).toBe("full");
    expect(candidate.durableJobInputReference).toEqual({
      kind: "full_encryption_foreground_operation_v1",
      operationId: "runtime-execution-full-318", policyRevision: 40, roomId,
    });
    const writes: unknown[] = [];
    if (!candidate.durableJobInputReference || !candidate.durableJobInputDisposition) {
      throw new Error("Full Runtime candidate must retain its protected publication reference");
    }
    const job = new Job({
      ownerId: "human", requestorId: "human", laneKey: `room:${roomId}`,
      type: "foreground", input: { message: "PRIVATE_INPUT_SENTINEL" },
      durableInputDisposition: candidate.durableJobInputDisposition,
      durableInputReference: candidate.durableJobInputReference,
      persist: async (payload) => {
        // Same rejection that killed the real daemon before this fix.
        if (payload.publicationPolicy?.representation !== "protected_only") {
          throw new Error("ordinary_forbidden");
        }
        writes.push(payload);
        return "job-full-runtime";
      },
      updateStatus: async () => {},
      executor: async function* () { yield { type: "job.status", jobId: "job-full-runtime", status: "completed", laneKey: `room:${roomId}` }; },
    });
    await job.persist();
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("PRIVATE_INPUT_SENTINEL");
    expect(JSON.stringify(writes)).not.toContain("browser-session-is-not-a-product-session");
    candidate.onIneligible();
  });

  test("releases optional Journal and Memory context on cancellation", async () => {
    const created = capability("operation-context-cancelled");
    const controller = new AbortController();
    const stalled = () => new Promise<never>(() => {});
    const session = {
      authorizationDeadlineAt: Date.now() + 60_000,
      protectForegroundJournal: stalled,
      protectForegroundMemories: stalled,
    } as unknown as LiveShadowAgentTurnSession;
    const run = <Value>(work: () => Promise<Value>) =>
      runWithLiveShadowTurnSession({
        operationId: "operation-context-cancelled",
        capability: created,
        session,
        enforcementPolicy: {
          mode: "shadow_encryption",
          shadowBehavior: "strict",
          revision: 14,
        },
        dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
          () => Promise.resolve({ mode: "shadow_encryption", shadowBehavior: "strict", revision: 14 }),
        ),
        work,
      });
    const pending = [
      run(() => protectLiveShadowForegroundJournal(
        () => Promise.resolve({ rollup: null, events: [] }),
        controller.signal,
      )),
      run(() => protectLiveShadowForegroundMemories(
        () => Promise.resolve([{
          id: "memory-a",
          type: "fact",
          content: "ordinary memory",
          importance: 0.5,
          tier: 1,
          createdAt: new Date(0),
        }]),
        controller.signal,
      )),
    ];
    controller.abort(new Error("foreground context cancelled"));
    const settled = await Promise.allSettled(pending);
    expect(settled.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const result of settled) {
      if (result.status === "rejected") {
        expect(result.reason).toEqual(
          new Error("foreground context cancelled"),
        );
      }
    }
  });

  test("History cancellation waits for owned repair cleanup and never exposes a late successful result", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let cleaned = false;
    let settled = false;
    const session = {
      protectForegroundHistory: async (request: { signal?: AbortSignal }) => {
        expect(request.signal).toBe(controller.signal);
        entered();
        try {
          await cleanup;
          return { status: "verified", messages: [] };
        } finally { cleaned = true; }
      },
    } as unknown as LiveShadowAgentTurnSession;
    const pending = runWithLiveShadowTurnSession({
      operationId: "operation-history-cancelled",
      capability: capability("operation-history-cancelled"), session,
      enforcementPolicy: { mode: "shadow_encryption", shadowBehavior: "strict", revision: 14 },
      dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
        () => Promise.resolve({ mode: "shadow_encryption", shadowBehavior: "strict", revision: 14 }),
      ),
      work: () => protectLiveShadowForegroundHistory([{
        messageId: 41, ts: new Date(0), role: "user", authorDisplayName: "Human",
        handle: "human", authorActorId: "actor-human", snippet: "ordinary content",
      }], controller.signal),
    }).then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    await started;
    const cancellation = new Error("History cancelled");
    controller.abort(cancellation);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleaned).toBe(false);
    release();
    expect(await pending).toBe(cancellation);
    expect(cleaned).toBe(true);
  });

  test("replaces selected transcript bytes only after protected verification", async () => {
    const created = capability("operation-history-repair");
    const observations: unknown[] = [];
    const session = {
      protectForegroundHistory: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        messages: Object.freeze([Object.freeze({
          messageId: 41,
          payload: { role: "user" as const, content: "protected content" },
          provenance: "repaired" as const,
        })]),
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-repair",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 14,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session, "opened protected content"),
      }),
    });
    candidate.onMainTurn("operation-history-repair");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    const hit = {
      messageId: 41,
      ts: new Date(0),
      role: "user" as const,
      authorDisplayName: "Human",
      handle: "human",
      authorActorId: "actor-human",
      snippet: "ordinary content",
    };
    const hits = [hit];
    expect(await candidate.runMainTurn(
      "operation-history-repair",
      () => protectLiveShadowForegroundHistory(hits),
    )).toEqual([{ ...hit, snippet: "protected content" }]);
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_history",
      state: "verified",
      reason: "none",
      retryable: false,
      provenance: "repaired",
      selectedCount: 1,
      repairedCount: 1,
    }]);
  });

  test("never substitutes ordinary history after protected failure in Strict", async () => {
    const created = capability("operation-history-integrity");
    const session = {
      protectForegroundHistory: () => Promise.resolve(Object.freeze({
        status: "failed" as const,
        reason: "message_parity_mismatch",
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-integrity",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 15,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session, "opened protected content"),
      }),
    });
    candidate.onMainTurn("operation-history-integrity");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-history-integrity",
      () => protectLiveShadowForegroundHistory([{
        messageId: 41,
        ts: new Date(0),
        role: "user",
        authorDisplayName: "Human",
        handle: "human",
        authorActorId: "actor-human",
        snippet: "must not escape",
      }]),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
  });

  test("withholds bodyless history when fallback execution has no repair authority", async () => {
    const created = capability("operation-history-authority-unavailable");
    const observations: unknown[] = [];
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-authority-unavailable",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 16,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(null as never, "ordinary current turn"),
      }),
    });
    candidate.onMainTurn("operation-history-authority-unavailable");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(candidate.runMainTurn(
      "operation-history-authority-unavailable",
      () => protectLiveShadowForegroundHistory([{
        messageId: 41,
        ts: new Date(0),
        role: "user",
        authorDisplayName: "Human",
        handle: "human",
        authorActorId: "actor-human",
        // Models the structural row produced for a Full-origin Message after
        // switching to Shadow; no ordinary body exists to fall back to.
        snippet: null as unknown as string,
      }]),
    )).rejects.toMatchObject({
      decision: {
        boundaryId: "conversation.read.foreground_history",
        state: "waiting_for_authority",
        reason: "domain_authority_converging",
        retryable: true,
      },
    });
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_history",
      state: "waiting_for_authority",
      reason: "domain_authority_converging",
      retryable: true,
      selectedCount: 1,
    }]);
  });

  test("treats an incomplete verified history as Fallback integrity failure", async () => {
    const created = capability("operation-history-incomplete");
    const observations: unknown[] = [];
    const session = {
      protectForegroundHistory: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        messages: Object.freeze([]),
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-incomplete",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 15,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session, "opened protected content"),
      }),
    });
    candidate.onMainTurn("operation-history-incomplete");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    const ordinary = [{
      messageId: 41,
      ts: new Date(0),
      role: "user" as const,
      authorDisplayName: "Human",
      handle: "human",
      authorActorId: "actor-human",
      snippet: "ordinary fallback",
    }];
    expect(candidate.runMainTurn(
      "operation-history-incomplete",
      () => protectLiveShadowForegroundHistory(ordinary),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_history",
      state: "failed",
      reason: "integrity_failure",
      retryable: false,
      selectedCount: 1,
    }]);
  });

  test("does not return bodyless rows after protected repair fails in Fallback", async () => {
    const created = capability("operation-history-bodyless-failed");
    const session = {
      protectForegroundHistory: () => Promise.resolve(Object.freeze({
        status: "failed" as const,
        reason: "message_product_revision_changed",
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-bodyless-failed",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 17,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session, "opened current turn"),
      }),
    });
    candidate.onMainTurn("operation-history-bodyless-failed");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(candidate.runMainTurn(
      "operation-history-bodyless-failed",
      () => protectLiveShadowForegroundHistory([{
        messageId: 41,
        ts: new Date(0),
        role: "user",
        authorDisplayName: "Human",
        handle: "human",
        authorActorId: "actor-human",
        snippet: null as unknown as string,
      }]),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
  });

  test("uses verified protected Journal without loading the ordinary fallback", async () => {
    const created = capability("operation-journal-repair");
    let ordinaryReads = 0;
    const session = {
      protectForegroundJournal: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        journal: Object.freeze({
          rollup: null,
          events: Object.freeze([Object.freeze({
            id: "event-protected",
            roomId: "room-a",
            sequence: 1,
            kind: "fact" as const,
            statement: "protected Journal fact",
            status: "active" as const,
          })]),
        }),
        provenance: "repaired" as const,
        repairedCount: 1,
        includesReflectionRecord: true,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-journal-repair",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 16,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-journal-repair");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "operation-journal-repair",
      () => protectLiveShadowForegroundJournal(async () => {
        ordinaryReads += 1;
        return { rollup: null, events: [] };
      }),
    )).toEqual({
      rollup: null,
      events: [{
        id: "event-protected",
        roomId: "room-a",
        sequence: 1,
        kind: "fact",
        statement: "protected Journal fact",
        status: "active",
      }],
    });
    expect(ordinaryReads).toBe(0);
  });

  test("never loads ordinary Journal after protected failure in Strict", async () => {
    const created = capability("operation-journal-failure");
    let ordinaryReads = 0;
    const observations: unknown[] = [];
    const session = {
      protectForegroundJournal: () => Promise.resolve(Object.freeze({
        status: "failed" as const,
        reason: "journal_parity_mismatch",
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-journal-failure",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 17,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-journal-failure");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-journal-failure",
      () => protectLiveShadowForegroundJournal(async () => {
        ordinaryReads += 1;
        return { rollup: null, events: [] };
      }),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(ordinaryReads).toBe(0);
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_journal",
      state: "failed",
      reason: "integrity_failure",
      retryable: false,
      selectedCount: 0,
    }]);
  });

  test("loads ordinary Journal only after a key wait in Fallback", async () => {
    const created = capability("operation-journal-fallback");
    let ordinaryReads = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-journal-fallback",
      capability: created,
      enforcementPolicy: { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 17 },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work({
          protectForegroundJournal: () => Promise.resolve({
            status: "waiting_for_authority" as const,
            reason: "domain_authority_converging" as const,
          }),
        } as unknown as LiveShadowAgentTurnSession),
      }),
    });
    candidate.onMainTurn("operation-journal-fallback");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "operation-journal-fallback",
      () => protectLiveShadowForegroundJournal(async () => {
        ordinaryReads += 1;
        return { rollup: null, events: [] };
      }),
    )).toEqual({ rollup: null, events: [] });
    expect(ordinaryReads).toBe(1);
  });

  test("classifies an absent protected Journal sibling as unavailable in Full", async () => {
    const created = capability("operation-journal-missing-protected");
    const observations: unknown[] = [];
    const session = {
      protectForegroundJournal: () => Promise.resolve(Object.freeze({
        status: "failed" as const,
        reason: "protected_representation_missing",
        selectedCount: 2,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-journal-missing-protected",
      capability: created,
      enforcementPolicy: {
        mode: "encrypted_only",
        shadowBehavior: "fallback",
        revision: 17,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-journal-missing-protected");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    const run = candidate.runMainTurn(
      "operation-journal-missing-protected",
      () => protectLiveShadowForegroundJournal(async () => ({
        rollup: null,
        events: [],
      })),
    );
    let rejection: unknown;
    try {
      await Promise.resolve(run);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      decision: {
        state: "unsupported",
        reason: "missing_protected_sibling",
      },
    });
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_journal",
      state: "unsupported",
      reason: "missing_protected_sibling",
      retryable: false,
      selectedCount: 2,
    }]);
  });

  test("surfaces unsupported legacy Journal context distinctly in Strict", async () => {
    const created = capability("operation-journal-unsupported");
    const observations: unknown[] = [];
    const session = {
      protectForegroundJournal: () => Promise.resolve(Object.freeze({
        status: "unsupported" as const,
        reason: "legacy_journal_protected_representation_unavailable",
        selectedCount: 1,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-journal-unsupported",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 17,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-journal-unsupported");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-journal-unsupported",
      () => protectLiveShadowForegroundJournal(async () => ({
        rollup: null,
        events: [],
      })),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_journal",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      selectedCount: 1,
    }]);
  });

  test("replaces selected Record statements only after verification", async () => {
    const created = capability("operation-record-repair");
    const observations: unknown[] = [];
    const session = {
      protectForegroundRecords: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        records: Object.freeze([Object.freeze({
          recordRef: "record-a",
          statement: "protected statement",
          lifecycle: "current" as const,
          structuralHeight: 0,
        })]),
        provenance: "repaired" as const,
        repairedCount: 1,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-record-repair",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 18,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-record-repair");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "operation-record-repair",
      () => protectLiveShadowForegroundRecordContext({
        representation: "ordinary",
        select: () => Promise.resolve({
          status: "available",
          representation: "ordinary",
          queryEmbeddingStatus: "available",
          candidateCount: 1,
          records: [{
            recordRef: "record-a",
            statement: "ordinary statement",
            lifecycle: "current",
            structuralHeight: 0,
          }],
        }),
        selectStructural: () => Promise.resolve({
          status: "available", representation: "protected",
          queryEmbeddingStatus: "available", candidateCount: 1,
          records: [{ representation: "structural", recordRef: "record-a", structuralHeight: 0 }],
        }),
      }).select({ query: "query", limit: 5 }),
    )).toMatchObject({
      status: "available",
      representation: "protected",
      records: [{ statement: "protected statement" }],
    });
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_records",
      state: "verified",
      reason: "none",
      retryable: false,
      provenance: "repaired",
      selectedCount: 1,
      repairedCount: 1,
    }]);
  });

  test("never returns selected ordinary Record statements after Strict failure", async () => {
    const created = capability("operation-record-failure");
    let ordinarySelections = 0;
    const session = {
      protectForegroundRecords: () => Promise.resolve(Object.freeze({
        status: "failed" as const,
        reason: "record_parity_mismatch",
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-record-failure",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 19,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-record-failure");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-record-failure",
      () => protectLiveShadowForegroundRecordContext({
        representation: "ordinary",
        select: () => {
          ordinarySelections += 1;
          return Promise.resolve({
            status: "available",
            representation: "ordinary",
            queryEmbeddingStatus: "not_attempted",
            candidateCount: 1,
            records: [{
              recordRef: "record-a",
              statement: "must not reach the prompt",
              lifecycle: "current",
              structuralHeight: 0,
            }],
          });
        },
        selectStructural: () => Promise.resolve({
          status: "available", representation: "protected",
          queryEmbeddingStatus: "available", candidateCount: 1,
          records: [{ representation: "structural", recordRef: "record-a", structuralHeight: 0 }],
        }),
      }).select({ query: "query", limit: 5 }),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(ordinarySelections).toBe(0);
  });

  test.each((["verified", "waiting_for_authority"] as const)
    .flatMap((status) => [false, true].map((delayedObservation) => ({ status, delayedObservation }))))(
    "keeps terminal Record deadline after late repair outcome %j", async ({ status, delayedObservation }) => {
      const controller = new AbortController();
      const observations: unknown[] = [];
      let finishObservation!: () => void;
      const observation = new Promise<void>((resolve) => { finishObservation = resolve; });
      let finishRepair!: (value: ForegroundRecordHistoryResult) => void;
      let enteredRepair!: () => void;
      const entered = new Promise<void>((resolve) => { enteredRepair = resolve; });
      const session = {
        protectForegroundRecords: () => {
          enteredRepair();
          return new Promise<ForegroundRecordHistoryResult>((resolve) => { finishRepair = resolve; });
        },
      } as unknown as LiveShadowAgentTurnSession;
      const result = runWithLiveShadowTurnSession({
        operationId: "record-deadline-late", capability: capability("record-deadline-late"), session,
        enforcementPolicy: { mode: "shadow_encryption", shadowBehavior: "strict", revision: 20 },
        dataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
          () => Promise.resolve({ mode: "shadow_encryption", shadowBehavior: "strict", revision: 20 }),
        ),
        observeBoundary: (value) => { observations.push(value); return delayedObservation ? observation : Promise.resolve(); },
        work: () => protectLiveShadowForegroundRecordContext({
          representation: "ordinary",
          select: () => Promise.resolve({ status: "available", representation: "ordinary",
            queryEmbeddingStatus: "available", candidateCount: 1,
            records: [{ recordRef: "record-a", statement: "ordinary", lifecycle: "current", structuralHeight: 0 }] }),
          selectStructural: () => Promise.resolve({ status: "available", representation: "protected",
            queryEmbeddingStatus: "available", candidateCount: 1,
            records: [{ representation: "structural", recordRef: "record-a", structuralHeight: 0 }] }),
        }).select({ query: "query", limit: 5, signal: controller.signal }),
      });
      let settled = false;
      const rejected = result.then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
      await entered;
      controller.abort("foreground_record_context_deadline");
      finishRepair(status === "verified" ? { status, provenance: "existing", repairedCount: 0,
        verification: "authenticated", ordinaryRestoredCount: 0,
        records: [{ recordRef: "record-a", statement: "protected", lifecycle: "current", structuralHeight: 0 }] }
        : { status, reason: "cancelled" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (delayedObservation) expect(settled).toBe(false);
      finishObservation();
      expect(await rejected).toMatchObject({ decision: {
        state: "failed", reason: "deadline_expired", retryable: false,
      } });
      expect(observations).toEqual([{
        boundaryId: "conversation.read.foreground_records", state: "failed",
        reason: "deadline_expired", retryable: false, selectedCount: 0,
      }]);
    });

  test("strict Record selection fails closed at its soft deadline", async () => {
    const created = capability("operation-record-deadline-strict");
    const controller = new AbortController();
    controller.abort("foreground_record_context_deadline");
    const session = {
      protectForegroundRecords: () => new Promise<never>(() => {}),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-record-deadline-strict",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 20,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-record-deadline-strict");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-record-deadline-strict",
      () => protectLiveShadowForegroundRecordContext({
        representation: "ordinary",
        select: () => new Promise<never>(() => {}),
      }).select({
        query: "query",
        limit: 5,
        signal: controller.signal,
      }),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
  });

  test("Fallback Record selection remains bounded at its soft deadline", async () => {
    const created = capability("operation-record-deadline-fallback");
    const controller = new AbortController();
    controller.abort("foreground_record_context_deadline");
    const session = {
      protectForegroundRecords: () => new Promise<never>(() => {}),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-record-deadline-fallback",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 21,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-record-deadline-fallback");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "operation-record-deadline-fallback",
      () => protectLiveShadowForegroundRecordContext({
        representation: "ordinary",
        select: () => new Promise<never>(() => {}),
      }).select({
        query: "query",
        limit: 5,
        signal: controller.signal,
      }),
    )).toEqual({
      status: "unavailable",
      representation: "protected",
      queryEmbeddingStatus: "unavailable",
      reason: "deadline_expired",
    });
  });

  test("returns only reopened Memory content after verification", async () => {
    const created = capability("operation-memory-repair");
    const selected = {
      id: "10000000-0000-4000-8000-000000000031",
      type: "preference",
      content: "ordinary content",
      importance: 0.8,
      tier: 1,
      createdAt: new Date(0),
    };
    const session = {
      protectForegroundMemories: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        memories: Object.freeze([Object.freeze({
          ...selected,
          content: "protected content",
        })]),
        provenance: "repaired" as const,
        repairedCount: 1,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-memory-repair",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 20,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-memory-repair");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "operation-memory-repair",
      () => protectLiveShadowForegroundMemories(() =>
        Promise.resolve([selected])
      ),
    )).toEqual([{ ...selected, content: "protected content" }]);
  });

  test("does not select ordinary Memories when Strict has no repair port", async () => {
    const created = capability("operation-memory-unsupported");
    let ordinarySelections = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-memory-unsupported",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 21,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work({} as LiveShadowAgentTurnSession),
      }),
    });
    candidate.onMainTurn("operation-memory-unsupported");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-memory-unsupported",
      () => protectLiveShadowForegroundMemories(() => {
        ordinarySelections += 1;
        return Promise.resolve([]);
      }),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(ordinarySelections).toBe(0);
  });

  test("rejects incomplete verified Memory context in Strict", async () => {
    const created = capability("operation-memory-incomplete");
    const selected = {
      id: "10000000-0000-4000-8000-000000000035",
      type: "fact",
      content: "must not be silently omitted",
      importance: 0.8,
      tier: 1,
      createdAt: new Date(0),
    };
    const session = {
      protectForegroundMemories: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        memories: Object.freeze([]),
        provenance: "existing" as const,
        repairedCount: 0,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-memory-incomplete",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 21,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-memory-incomplete");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(
      "operation-memory-incomplete",
      () => protectLiveShadowForegroundMemories(() =>
        Promise.resolve([selected])
      ),
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
  });

  test("Fallback lazily loads ordinary bodies for the exact structural Memory selection", async () => {
    const created = capability("operation-memory-fallback-exact");
    const structural = {
      representation: "structural" as const,
      id: "10000000-0000-4000-8000-000000000036",
      contentRevision: 1,
      type: null,
      importance: 0.8,
      tier: 1 as const,
      createdAt: new Date(0),
    };
    const ordinary = { ...structural, representation: undefined, type: "fact", content: "ordinary exact body" };
    const session = {
      protectForegroundMemories: () => Promise.resolve(Object.freeze({
        status: "waiting_for_authority" as const,
        reason: "domain_authority_converging" as const,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-memory-fallback-exact",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 22,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-memory-fallback-exact");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    let exactSelection: readonly unknown[] | undefined;
    expect(await candidate.runMainTurn(
      "operation-memory-fallback-exact",
      () => protectLiveShadowForegroundMemories(
        () => Promise.resolve([structural]),
        undefined,
        (selected) => {
          exactSelection = selected;
          return Promise.resolve([ordinary]);
        },
      ),
    )).toEqual([ordinary]);
    expect(exactSelection).toEqual([structural]);
  });

  test("protects recall_records search and blocks heterogeneous expansion in Strict", async () => {
    const created = capability("operation-record-recall");
    let expansions = 0;
    const session = {
      protectForegroundRecords: () => Promise.resolve(Object.freeze({
        status: "verified" as const,
        records: Object.freeze([Object.freeze({
          recordRef: "record-a",
          statement: "protected recalled statement",
          lifecycle: "current" as const,
          structuralHeight: 1,
        })]),
        provenance: "existing" as const,
        repairedCount: 0,
      })),
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-record-recall",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 23,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-record-recall");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    await candidate.runMainTurn("operation-record-recall", async () => {
      const port = protectLiveShadowForegroundRecordRecall({
        searchStructural: () => Promise.resolve({
          status: "ok",
          continuation: "opaque-protected-next",
          records: [{
            representation: "structural",
            recordRef: "record-a",
            structuralHeight: 1,
          }],
        }),
        search: () => Promise.resolve({
          status: "ok",
          records: [{
            recordRef: "record-a",
            statement: "ordinary recalled statement",
            structuralHeight: 1,
            freshness: "current",
          }],
        }),
        expand: () => {
          expansions += 1;
          return Promise.resolve({
            status: "unavailable",
            reason: "temporarily_unavailable",
          });
        },
      });
      expect(await port.search({ query: "decision", limit: 5 })).toMatchObject({
        status: "ok",
        continuation: "opaque-protected-next",
        records: [{ statement: "protected recalled statement" }],
      });
      expect(port.expand({ recordRef: "record-a" }))
        .rejects.toBeInstanceOf(StrictShadowEnforcementError);
    });
    expect(expansions).toBe(0);
  });

  test("does not load ordinary Record recall when protected context has no session", async () => {
    const operationId = "operation-record-recall-no-session";
    let ordinaryReads = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId,
      capability: capability(operationId),
      enforcementPolicy: {
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: 26,
      },
      runAgentTurn: async (input) => ({
        status: "executed" as const,
        value: await input.work(null as unknown as LiveShadowAgentTurnSession),
      }),
    });
    candidate.onMainTurn(operationId);
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn(operationId, () =>
      protectLiveShadowForegroundRecordRecall({
        search: () => {
          ordinaryReads += 1;
          return Promise.resolve({ status: "ok", records: [] });
        },
        expand: () => Promise.resolve({
          status: "unavailable",
          reason: "temporarily_unavailable",
        }),
      }).search({ query: "decision", limit: 5 })
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(ordinaryReads).toBe(0);
  });

  test("keeps strict recall_records pending until authority converges", async () => {
    const created = capability("operation-record-recall-wait");
    let attempts = 0;
    const session = {
      protectForegroundRecords: () => {
        attempts += 1;
        return Promise.resolve(attempts === 1
          ? Object.freeze({
              status: "waiting_for_authority" as const,
              reason: "domain_authority_converging",
            })
          : Object.freeze({
              status: "verified" as const,
              records: Object.freeze([Object.freeze({
                recordRef: "record-a",
                statement: "protected after convergence",
                lifecycle: "current" as const,
                structuralHeight: 1,
              })]),
              provenance: "existing" as const,
              repairedCount: 0,
            }));
      },
    } as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-record-recall-wait",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 25,
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-record-recall-wait");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    const result = await candidate.runMainTurn(
      "operation-record-recall-wait",
      () => protectLiveShadowForegroundRecordRecall({
        searchStructural: () => Promise.resolve({
          status: "ok",
          records: [{
            representation: "structural",
            recordRef: "record-a",
            structuralHeight: 1,
          }],
        }),
        search: () => Promise.resolve({
          status: "ok",
          records: [{
            recordRef: "record-a",
            statement: "ordinary statement",
            structuralHeight: 1,
            freshness: "current",
          }],
        }),
        expand: () => Promise.resolve({
          status: "unavailable",
          reason: "temporarily_unavailable",
        }),
      }).search({ query: "decision", limit: 5 }),
    );
    expect(result).toMatchObject({
      status: "ok",
      records: [{ statement: "protected after convergence" }],
    });
    expect(attempts).toBe(2);
  });

  test("records ordinary foreground history in Fallback Shadow and permits it once", async () => {
    const created = capability("operation-history-fallback");
    const observations: unknown[] = [];
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-fallback",
      capability: created,
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(null as never, "opened protected content"),
      }),
    });
    candidate.onMainTurn("operation-history-fallback");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(await candidate.runMainTurn(
      "operation-history-fallback",
      async () => {
        await enforceLiveShadowForegroundHistoryBoundary({
          roomId: "room-history-fallback",
          protectedTurnAvailable: false,
        });
        return "ordinary history allowed";
      },
    )).toBe("ordinary history allowed");
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_history",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      selectedCount: 0,
    }]);
  });

  test("rejects ordinary foreground history before model work in Strict Shadow", async () => {
    const created = capability("operation-history-strict");
    const observations: unknown[] = [];
    let modelRuns = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-strict",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 12,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(null as never, "opened protected content"),
      }),
    });
    candidate.onMainTurn("operation-history-strict");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(candidate.runMainTurn(
      "operation-history-strict",
      async () => {
        await enforceLiveShadowForegroundHistoryBoundary({
          roomId: "room-history-strict",
          protectedTurnAvailable: false,
        });
        modelRuns += 1;
        return "must not run";
      },
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(modelRuns).toBe(0);
    expect(observations).toEqual([{
      boundaryId: "conversation.read.foreground_history",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      selectedCount: 0,
    }]);
  });

  test("does not classify already-authorized protected foreground history as unsupported", async () => {
    const created = capability("operation-history-protected");
    const observations: unknown[] = [];
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-history-protected",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 13,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(null as never, "opened protected content"),
      }),
    });
    candidate.onMainTurn("operation-history-protected");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(await candidate.runMainTurn(
      "operation-history-protected",
      async () => {
        await enforceLiveShadowForegroundHistoryBoundary({
          roomId: "room-history-protected",
          protectedTurnAvailable: true,
        });
        return "protected history allowed";
      },
    )).toBe("protected history allowed");
    expect(observations).toEqual([]);
  });

  test("exposes the opaque capability only inside its exact armed turn", async () => {
    const created = capability("operation-a");
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-a",
      capability: created,
    });

    candidate.onMainTurn("operation-a");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    const outcome = await candidate.runMainTurn("operation-a", async () => {
      expect(getCurrentLiveShadowTurnContext()).toMatchObject({
        operationId: "operation-a",
        capability: created,
        session: null,
        enforcementPolicy: {
          mode: "shadow_encryption",
          shadowBehavior: "fallback",
          revision: 0,
        },
      });
      await Promise.resolve();
      expect(getCurrentLiveShadowTurnContext()?.capability).toBe(created);
      return "done";
    });
    expect(outcome).toBe("done");

    expect(getCurrentLiveShadowTurnContext()).toBeUndefined();
    expect(created.authorizationDigest).toEqual(new Uint8Array(32));
    expect(created.scope.domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });

  test("keeps shared-Agent execution authority distinct from Human turn causality", async () => {
    const created = capability("agent-execution-a");
    let protectedOperationId = "";
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "agent-execution-a",
      turnId: "human-turn-a",
      capability: created,
      runAgentTurn: async (input) => {
        protectedOperationId = input.operationId;
        return Object.freeze({
          status: "executed" as const,
          value: await input.work(null as never, "opened protected content"),
        });
      },
    });

    candidate.onMainTurn("human-turn-a");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "human-turn-a",
      async () => "done",
    )).toBe("done");
    expect(protectedOperationId).toBe("agent-execution-a");
  });

  test("destroys custody when scheduling rejects the turn", async () => {
    const created = capability("operation-b");
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-b",
      capability: created,
    });

    candidate.onIneligible();
    expect(created.authorizationDigest).toEqual(new Uint8Array(32));
    expect(created.scope.domainAuthoritySetDigest).toEqual(new Uint8Array(32));
    expect(() => candidate.onMainTurn("operation-b")).toThrow();
  });



  test("lends one foreground-session reference to the Agent runner and wipes it", async () => {
    const authorizationDigest = new Uint8Array(32).fill(0xa1);
    const domainAuthoritySetDigest = new Uint8Array(32).fill(0xa2);
    const created = Object.freeze({
      kind: "foreground_session" as const,
      sessionReference: "foreground-session:m294",
      authorizationDigest,
      scope: Object.freeze({
        subjectHumanId: "human-m294",
        issuingDeviceId: "device-m294",
        recipientAgentId: "agent-m294",
        sessionId: "session-m294",
        roomId: "room-m294",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        agentAuthorizationRevision: 1,
        namespaceIds: Object.freeze(["namespace-m294"]),
        grantDomainIds: Object.freeze(["grant-domain-m294"]),
        domainAuthoritySetDigest,
      }),
    });
    let runs = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-m294",
      capability: created,
      runAgentTurn: async (input) => {
        runs++;
        expect(input.capability).toBe(created);
        return Object.freeze({
          status: "executed" as const,
          value: await input.work(null as never, "opened protected content"),
        });
      },
    });
    candidate.onMainTurn("operation-m294");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(await candidate.runMainTurn(
      "operation-m294",
      async (inputOverride) => {
        expect(inputOverride).toEqual({ message: "opened protected content" });
        return "done";
      },
    )).toBe("done");
    expect(runs).toBe(1);
    expect(authorizationDigest).toEqual(new Uint8Array(32));
    expect(domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });

  test("does not invoke an ordinary Agent turn after protected input fails in Strict Shadow", async () => {
    const created = capability("operation-strict");
    let ordinaryRuns = 0;
    const observations: unknown[] = [];
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-strict",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 7,
      },
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async () => Object.freeze({
        status: "ordinary_fallback" as const,
        reason: "protected input unavailable",
      }),
    });
    candidate.onMainTurn("operation-strict");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    expect(candidate.runMainTurn("operation-strict", async () => {
      ordinaryRuns++;
      return "must not run";
    })).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(ordinaryRuns).toBe(0);
    expect(observations).toEqual([{
      state: "failed",
      reason: "publication_failure",
    }]);
    expect(created.authorizationDigest).toEqual(new Uint8Array(32));
    expect(created.scope.domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });

  test("does not execute a foreground Job twice when authorization ends after work starts", async () => {
    const created = capability("operation-started-once");
    const authorization = new AbortController();
    const observations: unknown[] = [];
    let workRuns = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-started-once",
      capability: created,
      observeBoundary: async (observation) => {
        observations.push(observation);
      },
      runAgentTurn: async (input) => {
        void input.work(
          null as never,
          "opened protected content",
          authorization.signal,
        );
        return Object.freeze({
          status: "ordinary_fallback" as const,
          reason: "session expired after dispatch",
        });
      },
    });
    candidate.onMainTurn("operation-started-once");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(await candidate.runMainTurn(
      "operation-started-once",
      async (inputOverride, authorizationSignal) => {
        workRuns += 1;
        expect(inputOverride).toEqual({ message: "opened protected content" });
        expect(authorizationSignal).toBe(authorization.signal);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "completed original work";
      },
    )).toBe("completed original work");
    expect(workRuns).toBe(1);
    expect(observations).toEqual([{
      state: "failed",
      reason: "publication_failure",
    }]);
  });

  test("rejects an already-started late result when protected authorization ends in Strict", async () => {
    const created = capability("operation-started-strict");
    let workRuns = 0;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-started-strict",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 19,
      },
      runAgentTurn: async (input) => {
        void input.work(null as never, "opened protected content");
        return Object.freeze({
          status: "ordinary_fallback" as const,
          reason: "session expired after dispatch",
        });
      },
    });
    candidate.onMainTurn("operation-started-strict");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    expect(candidate.runMainTurn(
      "operation-started-strict",
      async () => {
        workRuns += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "late result must not escape";
      },
    )).rejects.toBeInstanceOf(StrictShadowEnforcementError);
    expect(workRuns).toBe(1);
    expect(created.authorizationDigest).toEqual(new Uint8Array(32));
    expect(created.scope.domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });

  test("observes a detached callback rejection when policy observation invalidates its candidate", async () => {
    const created = capability("operation-started-policy-change");
    let rejectWork: ((error: Error) => void) | undefined;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-started-policy-change",
      capability: created,
      enforcementPolicy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 20,
      },
      observeBoundary: async () => {
        throw new Error("policy revision changed");
      },
      runAgentTurn: async (input) => {
        void input.work(null as never, "opened protected content");
        return Object.freeze({
          status: "ordinary_fallback" as const,
          reason: "session expired after dispatch",
        });
      },
    });
    candidate.onMainTurn("operation-started-policy-change");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");

    const rejected = candidate.runMainTurn(
      "operation-started-policy-change",
      () => new Promise<never>((_resolve, reject) => {
        rejectWork = reject;
      }),
    );
    expect(rejected).rejects.toThrow("policy revision changed");
    rejectWork?.(new Error("detached callback cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created.authorizationDigest).toEqual(new Uint8Array(32));
    expect(created.scope.domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });

  test("lends an independent root-session operation to a foreground fork", async () => {
    const authorizationDigest = new Uint8Array(32).fill(0xb1);
    const domainAuthoritySetDigest = new Uint8Array(32).fill(0xb2);
    const created = Object.freeze({
      kind: "foreground_session" as const,
      sessionReference: "foreground-session:m298-fork",
      authorizationDigest,
      scope: Object.freeze({
        subjectHumanId: "human-m298",
        issuingDeviceId: "device-m298",
        recipientKind: "nautilo_foreground_runtime" as const,
        browserSessionId: "browser-m298",
        topLevelRoomId: "room-m298",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        namespaceIds: Object.freeze(["namespace-m298"]),
        grantDomainIds: Object.freeze(["grant-domain-m298"]),
        domainAuthoritySetDigest,
      }),
    });
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-m298-fork",
      capability: created,
      runAgentTurn: async (input) => {
        expect(input.entrypointId).toBe("foreground.fork");
        return Object.freeze({
          status: "executed" as const,
          value: await input.work(null as never, "opened fork content"),
        });
      },
    });
    candidate.onForkTurn?.("operation-m298-fork");
    if (candidate.runForkTurn === undefined) throw new Error("fork runner missing");
    expect(await candidate.runForkTurn(
      "operation-m298-fork",
      async (inputOverride) => {
        expect(inputOverride).toEqual({ message: "opened fork content" });
        return getCurrentLiveShadowTurnContext()?.operationId;
      },
    )).toBe("operation-m298-fork");
    expect(authorizationDigest).toEqual(new Uint8Array(32));
    expect(domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });

  test("exposes the resumed turn's protected tool boundary to its graph", async () => {
    const authorizationDigest = new Uint8Array(32).fill(0xc1);
    const domainAuthoritySetDigest = new Uint8Array(32).fill(0xc2);
    const created = Object.freeze({
      kind: "foreground_session" as const,
      sessionReference: "foreground-session:m298-resume",
      authorizationDigest,
      scope: Object.freeze({
        subjectHumanId: "human-m298",
        issuingDeviceId: "device-m298",
        recipientKind: "nautilo_foreground_runtime" as const,
        browserSessionId: "browser-m298",
        topLevelRoomId: "room-m298",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        namespaceIds: Object.freeze(["namespace-m298"]),
        grantDomainIds: Object.freeze(["grant-domain-m298"]),
        domainAuthoritySetDigest,
      }),
    });
    const session = Object.freeze({
      reserveAssistantStream: () => Promise.reject(new Error("unused")),
      sealAssistantStreamChunk: () => { throw new Error("unused"); },
      publishMessage: () => Promise.reject(new Error("unused")),
      fail: () => undefined,
      destroy: () => undefined,
    }) as unknown as LiveShadowAgentTurnSession;
    const candidate = createLiveShadowForegroundTurnCandidate({
      operationId: "operation-m298-resume",
      capability: created,
      runAgentTurn: async (input) => Object.freeze({
        status: "executed" as const,
        value: await input.work(session),
      }),
    });
    candidate.onMainTurn("operation-m298-resume");
    if (candidate.runMainTurn === undefined) throw new Error("runner missing");
    await candidate.runMainTurn("operation-m298-resume", async () => {
      const processor = createPersistingProcessor({
        threadId: "thread-m298-resume",
        ownerId: "owner-m298",
        agentId: "agent-m298",
        laneKey: "lane-m298-resume",
        eventBus: { emit: () => undefined },
      });
      expect(processor.liveShadowToolBoundaryForState()).toBeDefined();
    });
    expect(authorizationDigest).toEqual(new Uint8Array(32));
    expect(domainAuthoritySetDigest).toEqual(new Uint8Array(32));
  });
});
