import { describe, expect, test } from "bun:test";
import {
  COMPACTION_CONTRACT,
  EXTRACTION_CONTRACT,
  runStenographerCompaction,
  runStenographerExtraction,
  type StenographerExtractionSnapshot,
} from "../../src";

const snapshot: StenographerExtractionSnapshot = {
  priorRows: [{
    createdAt: new Date("2026-08-01T11:59:00.000Z"),
    role: "assistant",
    displayLabel: "Agent: Ada",
    text: "Postgres remains the supported database.",
  }],
  rows: [{
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    role: "user",
    displayLabel: "Human: Casey",
    text: "We selected Postgres for transactional consistency.",
    conversationalBoundary: true,
  }],
  latestRollup: "The team is selecting durable infrastructure.",
  visibleEvents: [{
    localReference: "E1",
    kind: "open_question",
    statement: "Which database should the service use?",
    active: true,
  }],
  hasConversationalContent: true,
};

describe("shared Stenographer extraction", () => {
  test("constructs the locked prompt and returns an opaque proposal", async () => {
    const prompts: string[] = [];
    const result = await runStenographerExtraction({
      snapshot,
      invoke: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(JSON.stringify({
          operations: [{
            op: "supersede",
            eventSequence: "E1",
            kind: "decision",
            statement: "The service will use Postgres.",
            sourceMessageIds: ["M1"],
          }],
        }));
      },
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      proposal: {
        operations: [{
          eventReference: "E1",
          sourceReferences: ["M1"],
        }],
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.startsWith(`${EXTRACTION_CONTRACT}\n\n`)).toBe(true);
    expect(prompts[0]).toContain("P1");
    expect(prompts[0]).toContain("M1");
    expect(prompts[0]).toContain("E1 | open_question");
  });

  test("is deterministic for a fixed snapshot and model response", async () => {
    const prompts: string[] = [];
    const response = JSON.stringify({
      operations: [{
        op: "append",
        kind: "decision",
        statement: "The service will use Postgres.",
        sourceMessageIds: ["M1"],
      }],
    });
    const invoke = (prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(response);
    };

    const first = await runStenographerExtraction({ snapshot, invoke });
    const second = await runStenographerExtraction({ snapshot, invoke });

    expect(second).toEqual(first);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
  });

  test("repairs once with the same signal and runtime validation reason", async () => {
    const controller = new AbortController();
    const prompts: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const result = await runStenographerExtraction({
      snapshot,
      signal: controller.signal,
      validateProposal: (proposal) =>
        proposal.operations[0]?.statement.includes("corrected")
          ? { ok: true }
          : { ok: false, reason: "source_cross_room" },
      invoke: (prompt, signal) => {
        prompts.push(prompt);
        signals.push(signal);
        return Promise.resolve(JSON.stringify({
          operations: [{
            op: "append",
            kind: "fact",
            statement: prompts.length === 1 ? "initial" : "corrected",
            sourceMessageIds: ["M1"],
          }],
        }));
      },
    });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(prompts[1]).toContain("invalid (source_cross_room)");
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  test("fails closed after a second invalid response", async () => {
    let calls = 0;
    const result = await runStenographerExtraction({
      snapshot,
      invoke: () => {
        calls += 1;
        return Promise.resolve("not JSON");
      },
    });
    expect(result).toEqual({
      ok: false,
      errorCode: "invalid_output",
      attempts: 2,
    });
    expect(calls).toBe(2);
  });

  test("does not call a provider for a content-empty protected snapshot", async () => {
    let calls = 0;
    const result = await runStenographerExtraction({
      snapshot: { ...snapshot, hasConversationalContent: false },
      invoke: () => {
        calls += 1;
        return Promise.resolve("unexpected");
      },
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      proposal: { operations: [] },
    });
    expect(calls).toBe(0);
  });

  test("propagates provider failures", async () => {
    const failure = new Error("provider unavailable");
    let caught: unknown;
    try {
      await runStenographerExtraction({
        snapshot,
        invoke: () => Promise.reject(failure),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});

describe("shared Stenographer compaction", () => {
  test("uses the locked prompt, repairs once, and propagates cancellation", async () => {
    const controller = new AbortController();
    const prompts: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const result = await runStenographerCompaction({
      prompt: "[Older effective events to absorb, oldest first]\nE1 | fact | x",
      signal: controller.signal,
      invoke: (prompt, signal) => {
        prompts.push(prompt);
        signals.push(signal);
        return Promise.resolve(
          prompts.length === 1 ? "invalid" : '{"content":"Supported state."}',
        );
      },
    });
    expect(result).toEqual({
      ok: true,
      content: "Supported state.",
      attempts: 2,
    });
    expect(prompts[0]!.startsWith(`${COMPACTION_CONTRACT}\n\n`)).toBe(true);
    expect(signals).toEqual([controller.signal, controller.signal]);
  });
});
