import { describe, expect, test } from "bun:test";
import {
  providerCostIdempotencyKey,
  type InsertProviderCostEventInput,
} from "@nautilo/db";

import {
  safelyRecordProviderCost,
  beginServerProviderCostAttempt,
  claimServerProviderCostAttempt,
  settleServerProviderCostAttempt,
} from "../../src/costs/provider-cost-recorder";

describe("server provider cost provenance", () => {
  test("preserves the admitted personal payer, credential revision, and provider route", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    await safelyRecordProviderCost({
      identity: "provider-operation-1",
      usageFunding: {
        kind: "personal",
        humanUserId: "human-a",
        payerHumanId: "human-a",
        providerRoute: "cloudconvert",
        credentialId: "credential-a",
        credentialRevision: 9,
      },
      userId: "human-a",
      roomId: "room-a",
      agentId: "agent-a",
      taskId: null,
      runId: null,
      jobId: null,
      workload: null,
      provider: "cloudconvert",
      operation: "convert",
      actualCostUsd: "0.021",
      evidenceState: "actual",
      attemptOutcome: null,
      failureCode: null,
      pricingVersion: null,
      measuredUnits: null,
      unitType: null,
    }, async (input) => { rows.push(input); });

    expect(rows).toEqual([{
      fundingKind: "personal",
      payerHumanId: "human-a",
      providerRoute: "cloudconvert",
      credentialId: "credential-a",
      credentialRevision: 9,
      userId: "human-a",
      roomId: "room-a",
      agentId: "agent-a",
      taskId: null,
      runId: null,
      jobId: null,
      workload: null,
      provider: "cloudconvert",
      operation: "convert",
      estimatedCostUsd: null,
      actualCostUsd: "0.021",
      evidenceState: "actual",
      attemptOutcome: null,
      failureCode: null,
      pricingVersion: null,
      measuredUnits: null,
      unitType: null,
      idempotencyKey: providerCostIdempotencyKey(
        "personal:human-a:credential-a:9:provider-operation-1",
      ),
    }]);
  });

  test("the same provider identity cannot deduplicate costs belonging to different Humans", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    const record = (payerHumanId: string, credentialId: string) => safelyRecordProviderCost({
      identity: "shared-provider-receipt",
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
      estimatedCostUsd: "0.008",
      evidenceState: "estimated",
    }, async (input) => { rows.push(input); });

    await record("human-a", "credential-a");
    await record("human-b", "credential-b");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.idempotencyKey).not.toBe(rows[1]?.idempotencyKey);
    expect(rows.map((row) => row.payerHumanId)).toEqual(["human-a", "human-b"]);
  });

  test("forwards trusted execution and lifecycle fields without deriving them from provider data", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    await safelyRecordProviderCost({
      identity: "tavily-request-1",
      userId: "human-a",
      roomId: "room-a",
      agentId: "agent-a",
      taskId: "task-a",
      runId: "run-a",
      jobId: "job-a",
      workload: "web_search",
      provider: "tavily",
      operation: "search",
      estimatedCostUsd: "0.004",
      evidenceState: "estimated",
      attemptOutcome: "succeeded",
      pricingVersion: "pricing-v1",
      measuredUnits: 0.5,
      unitType: "credit",
    }, async (input) => { rows.push(input); });

    expect(rows[0]).toMatchObject({
      userId: "human-a",
      roomId: "room-a",
      agentId: "agent-a",
      taskId: "task-a",
      runId: "run-a",
      jobId: "job-a",
      workload: "web_search",
      attemptOutcome: "succeeded",
      pricingVersion: "pricing-v1",
      measuredUnits: 0.5,
      unitType: "credit",
    });
  });

  test("unknown evidence carries no invented fee", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    await safelyRecordProviderCost({
      identity: "interrupted-provider-operation",
      usageFunding: {
        kind: "service",
        humanUserId: "human-a",
        providerRoute: "oomol",
      },
      provider: "oomol",
      operation: "hosted_browser",
      evidenceState: "unknown",
    }, async (input) => { rows.push(input); });

    expect(rows[0]).toMatchObject({
      fundingKind: "service",
      providerRoute: "oomol",
      estimatedCostUsd: null,
      actualCostUsd: null,
      evidenceState: "unknown",
    });
    expect(rows[0]?.payerHumanId).toBeUndefined();
    expect(rows[0]?.credentialId).toBeUndefined();
    expect(rows[0]?.credentialRevision).toBeUndefined();
  });

  test("metering insertion failures remain non-fatal to a completed provider operation", async () => {
    await Promise.resolve(expect(safelyRecordProviderCost({
      identity: "completed-provider-operation",
      provider: "tavily",
      operation: "search",
      estimatedCostUsd: "0.008",
      evidenceState: "estimated",
    }, async () => {
      throw new Error("cost ledger unavailable");
    })).resolves.toBeUndefined());
  });
});


describe("durable server service attempts", () => {
  const admission = {
    identity: "conversion:local-operation:submit",
    userId: "human-a", roomId: "room-a", taskId: "task-a", runId: "run-a", jobId: "job-a",
    provider: "cloudconvert", operation: "convert",
    usageFunding: { kind: "personal" as const, humanUserId: "human-a", payerHumanId: "human-a",
      providerRoute: "cloudconvert", credentialId: "credential-a", credentialRevision: 2 },
  };

  test("reconstructed settlement addresses the original unknown row and preserves measured credits without dollars", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    const save = async (row: InsertProviderCostEventInput) => { rows.push(row); };
    await beginServerProviderCostAttempt(admission, save);
    await settleServerProviderCostAttempt({ ...structuredClone(admission), evidenceState: "unknown",
      attemptOutcome: "succeeded", measuredUnits: 3, unitType: "credits", receiptId: "private-provider-job-id" }, save);
    expect(rows[0]).toMatchObject({ evidenceState: "unknown", attemptOutcome: "unknown", payerHumanId: "human-a" });
    expect(rows[1]).toMatchObject({ evidenceState: "unknown", attemptOutcome: "succeeded", measuredUnits: 3,
      actualCostUsd: null, estimatedCostUsd: null, taskId: "task-a", runId: "run-a", jobId: "job-a" });
    expect(rows[1]?.idempotencyKey).toBe(rows[0]?.idempotencyKey);
    expect(rows[1]?.requestReference).toMatch(/^req_[a-f0-9]{12}$/);
    expect(JSON.stringify(rows)).not.toContain("private-provider-job-id");
  });

  test("returns the durable inserted-versus-existing claim outcome without changing begin semantics", async () => {
    const rows: InsertProviderCostEventInput[] = [];
    const outcomes = ["inserted", "existing"] as const;
    let call = 0;
    const claim = async (row: InsertProviderCostEventInput) => {
      rows.push(row);
      return outcomes[call++] ?? "existing";
    };

    expect(await claimServerProviderCostAttempt(admission, claim)).toBe("inserted");
    expect(await claimServerProviderCostAttempt(admission, claim)).toBe("existing");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ evidenceState: "unknown", attemptOutcome: "unknown" });
    expect(rows[1]?.idempotencyKey).toBe(rows[0]?.idempotencyKey);
  });

  test("admission failure prevents dispatch and settlement failure remains available for owner retry", async () => {
    const unavailable = async () => { throw new Error("ledger unavailable"); };
    await Promise.resolve(expect(beginServerProviderCostAttempt(admission, unavailable)).rejects.toThrow("ledger unavailable"));
    await Promise.resolve(expect(settleServerProviderCostAttempt({ ...admission, evidenceState: "unknown", attemptOutcome: "cancelled" }, unavailable)).rejects.toThrow("ledger unavailable"));
  });
});
