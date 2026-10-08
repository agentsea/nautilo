import { describe, expect, test } from "bun:test";
import type { InsertProviderCostEventInput } from "@nautilo/db";

import {
  beginToolProviderCostAttempt,
  createToolProviderCostRecorder,
} from "../../src/usage/provider-cost-recorder";
import type { UsageFundingProvenance } from "../../src/usage/usage-context";
import { runWithUsageContext } from "../../src/usage/usage-context";

const PERSONAL_FUNDING: UsageFundingProvenance = {
  kind: "personal",
  humanUserId: "human-a",
  payerHumanId: "human-a",
  providerRoute: "tavily",
  credentialId: "credential-a",
  credentialRevision: 4,
};

describe("personal service cost attempts", () => {
  test("persists an unknown attempt before dispatch and fails closed when persistence fails", async () => {
    const inserted: InsertProviderCostEventInput[] = [];
    const insertError = new Error("cost ledger unavailable");

    await Promise.resolve(expect(beginToolProviderCostAttempt(undefined, {
      provider: "tavily",
      operation: "search",
      usageFunding: PERSONAL_FUNDING,
    }, {
      insert: async (input) => {
        inserted.push(input);
        throw insertError;
      },
    })).rejects.toBe(insertError));

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      fundingKind: "personal",
      userId: "human-a",
      payerHumanId: "human-a",
      providerRoute: "tavily",
      credentialId: "credential-a",
      credentialRevision: 4,
      provider: "tavily",
      operation: "search",
      evidenceState: "unknown",
      attemptOutcome: "unknown",
    });
    expect(inserted[0]?.estimatedCostUsd).toBeUndefined();
    expect(inserted[0]?.actualCostUsd).toBeUndefined();
  });

  test("settles the pre-dispatch identity without inserting a duplicate or changing provenance", async () => {
    const inserted: InsertProviderCostEventInput[] = [];
    const settled: InsertProviderCostEventInput[] = [];
    const recorder = await beginToolProviderCostAttempt({
      roomId: "room-a",
      agentId: "agent-a",
    }, {
      provider: "tavily",
      operation: "extract",
      usageFunding: PERSONAL_FUNDING,
    }, {
      insert: async (input) => { inserted.push(input); },
      settle: async (input) => { settled.push(input); },
    });

    await recorder({
      provider: "tavily",
      operation: "extract",
      actualCostUsd: "0.0042",
      evidenceState: "actual",
    });

    expect(inserted).toHaveLength(1);
    expect(settled).toHaveLength(1);
    const initial = inserted[0];
    if (!initial) throw new Error("missing pre-dispatch row");
    expect(settled[0]).toEqual({
      ...initial,
      evidenceState: "actual",
      estimatedCostUsd: null,
      actualCostUsd: "0.0042",
      attemptOutcome: "unknown",
      failureCode: null,
      pricingVersion: null,
      measuredUnits: null,
      unitType: null,
    });
    expect(settled[0]).toMatchObject({
      fundingKind: "personal",
      userId: "human-a",
      payerHumanId: "human-a",
      providerRoute: "tavily",
      credentialId: "credential-a",
      credentialRevision: 4,
      roomId: "room-a",
      agentId: "agent-a",
    });
  });

  test("freezes trusted Task and workload attribution before settlement loses ambient context", async () => {
    const inserted: InsertProviderCostEventInput[] = [];
    const settled: InsertProviderCostEventInput[] = [];
    const recorder = await runWithUsageContext({
      callType: "web_search",
      userId: "ambient-human",
      roomId: "ambient-room",
      metadata: {
        agentId: "ambient-agent",
        taskId: "ambient-task",
        taskRunId: "ambient-run",
        jobId: "ambient-job",
      },
    }, () => beginToolProviderCostAttempt({
      userId: "tool-human",
      roomId: "tool-room",
      agentId: "tool-agent",
      currentTaskId: "tool-task",
      currentTaskRunId: "tool-run",
    }, {
      provider: "tavily",
      operation: "search",
      usageFunding: PERSONAL_FUNDING,
    }, {
      insert: async (input) => { inserted.push(input); },
      settle: async (input) => { settled.push(input); },
    }));

    await recorder({
      provider: "tavily",
      operation: "search",
      estimatedCostUsd: "0.004",
      evidenceState: "estimated",
      attemptOutcome: "succeeded",
      pricingVersion: "test-pricing-v1",
      measuredUnits: 0.5,
      unitType: "credit",
    });

    expect(inserted[0]).toMatchObject({
      userId: "tool-human",
      roomId: "tool-room",
      agentId: "tool-agent",
      taskId: "tool-task",
      runId: "tool-run",
      jobId: "ambient-job",
      workload: "web_search",
      attemptOutcome: "unknown",
    });
    expect(settled[0]).toMatchObject({
      taskId: "tool-task",
      runId: "tool-run",
      jobId: "ambient-job",
      workload: "web_search",
      attemptOutcome: "succeeded",
      pricingVersion: "test-pricing-v1",
      measuredUnits: 0.5,
      unitType: "credit",
    });
  });

  test("a generic recorder carries its creation scope into an attempt opened after ALS exits", async () => {
    const inserted: InsertProviderCostEventInput[] = [];
    const settled: InsertProviderCostEventInput[] = [];
    const recorder = runWithUsageContext({
      callType: "subagent",
      userId: "captured-human",
      roomId: "captured-room",
      metadata: { taskId: "captured-task", taskRunId: "captured-run" },
      funding: PERSONAL_FUNDING,
    }, () => createToolProviderCostRecorder(undefined,
      async (input) => { inserted.push(input); },
      async (input) => { settled.push(input); }));

    const attempt = await recorder.beginAttempt?.({ provider: "tavily", operation: "search" });
    if (!attempt) throw new Error("recorder did not expose attempt lifecycle");
    await attempt({
      provider: "tavily",
      operation: "search",
      evidenceState: "unknown",
      attemptOutcome: "cancelled",
      failureCode: "request_cancelled",
    });

    expect(inserted[0]).toMatchObject({
      userId: "captured-human",
      roomId: "captured-room",
      taskId: "captured-task",
      runId: "captured-run",
      workload: "subagent",
      fundingKind: "personal",
      providerRoute: "tavily",
    });
    expect(settled[0]).toMatchObject({
      userId: "captured-human",
      taskId: "captured-task",
      runId: "captured-run",
      attemptOutcome: "cancelled",
      failureCode: "request_cancelled",
    });
  });

  test("keeps an unresolved attempt fee-free and rejects settlement identity changes", async () => {
    const inserted: InsertProviderCostEventInput[] = [];
    const settled: InsertProviderCostEventInput[] = [];
    const recorder = await beginToolProviderCostAttempt(undefined, {
      provider: "tavily",
      operation: "search",
      usageFunding: PERSONAL_FUNDING,
    }, {
      insert: async (input) => { inserted.push(input); },
      settle: async (input) => { settled.push(input); },
    });

    expect(inserted[0]).toMatchObject({ evidenceState: "unknown" });
    expect(inserted[0]?.estimatedCostUsd).toBeUndefined();
    expect(inserted[0]?.actualCostUsd).toBeUndefined();
    await Promise.resolve(expect(recorder({
      provider: "cloudconvert",
      operation: "search",
      evidenceState: "unknown",
    })).rejects.toThrow("Provider cost attempt identity changed"));
    expect(settled).toHaveLength(0);
  });

  test("does not deduplicate identical provider receipts across personal payers", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    const record = async (payerHumanId: string, credentialId: string) => {
      const recorder = createToolProviderCostRecorder({ toolCallId: "tool-call-1" }, async (input) => {
        rows.push(input);
      });
      await recorder({
        usageFunding: {
          kind: "personal",
          humanUserId: payerHumanId,
          payerHumanId,
          providerRoute: "tavily",
          credentialId,
          credentialRevision: 1,
        },
        provider: "tavily",
        operation: "search",
        receiptId: "provider-receipt-1",
        estimatedCostUsd: "0.008",
        evidenceState: "estimated",
      });
    };

    await record("human-a", "credential-a");
    await record("human-b", "credential-b");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.idempotencyKey).not.toBe(rows[1]?.idempotencyKey);
    expect(rows.map((row) => [row.payerHumanId, row.credentialId])).toEqual([
      ["human-a", "credential-a"],
      ["human-b", "credential-b"],
    ]);
  });
});
