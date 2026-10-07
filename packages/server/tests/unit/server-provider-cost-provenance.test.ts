import { describe, expect, test } from "bun:test";
import {
  providerCostIdempotencyKey,
  type InsertProviderCostEventInput,
} from "@nautilo/db";

import { safelyRecordProviderCost } from "../../src/costs/provider-cost-recorder";

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
      provider: "cloudconvert",
      operation: "convert",
      actualCostUsd: "0.021",
      evidenceState: "actual",
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
      provider: "cloudconvert",
      operation: "convert",
      estimatedCostUsd: null,
      actualCostUsd: "0.021",
      evidenceState: "actual",
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
