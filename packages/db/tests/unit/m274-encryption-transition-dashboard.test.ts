import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  assembleEncryptionTransitionDashboard,
  readHumanPeerLiveShadowDashboard,
  readLiveShadowTurnDashboard,
  readSharedAgentLiveShadowDashboard,
  readDomainKeyCatchUpDashboard,
  readEncryptionTransitionObservationPressure,
} from
  "../../src/utils/encryption-transition-dashboard";

describe("M274 encryption transition dashboard projection", () => {
  test("counts authorization once at its execution or Conductor invocation owner", async () => {
    const dialect = new PgDialect();
    const statements: string[] = [];
    const executionWhere: Array<{ sql: string; params: unknown[] }> = [];
    const zeroRow = new Proxy<Record<string, string>>({}, {
      get: () => "0",
    });
    const db = {
      select: (selection: Record<string, unknown>) => {
        const tracksRevision = "authorization_established" in selection
          || "stream_started" in selection;
        const builder = {
          from: () => builder,
          leftJoin: () => builder,
          where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
            if (tracksRevision) executionWhere.push(dialect.sqlToQuery(condition));
            return builder;
          },
          groupBy: () => Promise.resolve([
              {
                disposition: "establish",
                state: "completed",
                terminalReason: "conductor_verified_floor_manager_silent",
                total: 1,
              },
              {
                disposition: "reuse",
                state: "completed",
                terminalReason: "conductor_verified_floor_manager_silent",
                total: 1,
              },
            ]),
          then: (resolve: (value: readonly unknown[]) => unknown) =>
            Promise.resolve([zeroRow]).then(resolve),
        };
        return builder;
      },
      execute: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const statement = dialect.sqlToQuery(query).sql;
        statements.push(statement);
        if (statement.includes("group by invocation.terminal_reason")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([zeroRow]);
      },
    } as unknown as Parameters<typeof readSharedAgentLiveShadowDashboard>[0];

    const result = await readSharedAgentLiveShadowDashboard(db, {
      revision: 40,
      shadowEncryptionStartedAt: new Date("2026-09-06T00:00:00.000Z"),
    });

    expect(result.authorizationEstablished).toBe(1n);
    expect(result.authorizationReused).toBe(1n);
    const source = readFileSync(new URL(
      "../../src/utils/encryption-transition-dashboard.ts",
      import.meta.url,
    ), "utf8");
    expect(source).toContain("conversationSharedAgentShadowExecutions.invocationId} is null");
    expect(executionWhere).toHaveLength(2);
    for (const where of executionWhere) {
      expect(where.sql).toContain('"conversation_shared_agent_shadow_executions"."policy_revision" = $2');
      expect(where.params).toEqual(["2026-09-06T00:00:00.000Z", 40]);
    }
  });

  test("keeps M275 history reads out of the write-attempt denominator", () => {
    const projected = assembleEncryptionTransitionDashboard({
      attemptRows: [{
        family: "message",
        operation: "create",
        outcome: "verified",
        reason: "none",
        count: 2n,
      }, {
        family: "message",
        operation: "read",
        outcome: "verified",
        reason: "none",
        count: 3n,
      }, {
        family: "message",
        operation: "read",
        outcome: "failed",
        reason: "parity_mismatch",
        count: 1n,
      }],
      coverageRows: [
        { family: "message", verified: 0n, total: 0n },
        { family: "memory", verified: 0n, total: 0n },
        { family: "artifact", verified: 0n, total: 0n },
        { family: "record", verified: 0n, total: 0n },
      ],
    });
    expect(projected[0]).toMatchObject({
      family: "message",
      eligibleAttempts: 2n,
      verifiedAttempts: 2n,
      outcomes: [{ operation: "create", count: 2n }],
      historyReadOutcomes: [
        { operation: "read", outcome: "verified", count: 3n },
        { operation: "read", outcome: "failed", count: 1n },
      ],
    });
  });

  test("keeps expired response-loss reconciliation in the attempt denominator", () => {
    const projected = assembleEncryptionTransitionDashboard({
      attemptRows: [{ family: "memory", operation: "update",
        outcome: "reconciling", reason: "response_lost", count: 1n }],
      coverageRows: [
        { family: "message", verified: 0n, total: 0n },
        { family: "memory", verified: 0n, total: 1n },
        { family: "artifact", verified: 0n, total: 0n },
        { family: "record", verified: 0n, total: 0n },
      ],
    });
    expect(projected.find((row) => row.family === "memory")).toMatchObject({
      eligibleAttempts: 1n,
      verifiedAttempts: 0n,
      outcomes: [{ operation: "update", outcome: "reconciling",
        reason: "response_lost", count: 1n }],
    });
  });

  test("keeps attempt success and stored coverage as distinct denominators", () => {
    expect(assembleEncryptionTransitionDashboard({
      attemptRows: [
        {
          family: "message",
          operation: "create",
          outcome: "verified",
          reason: "none",
          count: 8n,
        },
        {
          family: "message",
          operation: "unsupported",
          outcome: "unavailable",
          reason: "unsupported_operation",
          count: 2n,
        },
      ],
      coverageRows: [
        { family: "message", verified: 40n, total: 100n },
        { family: "memory", verified: 5n, total: 10n },
        { family: "artifact", verified: 0n, total: 0n },
        { family: "record", verified: 2n, total: 4n },
      ],
    })).toEqual([
      {
        family: "message",
        eligibleAttempts: 10n,
        verifiedAttempts: 8n,
      coveredObjects: 40n,
      totalObjects: 100n,
      touchedCoveredObjects: 0n,
      touchedObjects: 0n,
      pendingLifecycleOperations: 0n,
      oldestPendingAt: null,
        outcomes: [
          {
            operation: "create",
            outcome: "verified",
            reason: "none",
            count: 8n,
          },
          {
            operation: "unsupported",
            outcome: "unavailable",
            reason: "unsupported_operation",
            count: 2n,
          },
        ],
        historyReadOutcomes: [],
      },
      {
        family: "memory",
        eligibleAttempts: 0n,
        verifiedAttempts: 0n,
      coveredObjects: 5n,
      totalObjects: 10n,
      touchedCoveredObjects: 0n,
      touchedObjects: 0n,
      pendingLifecycleOperations: 0n,
      oldestPendingAt: null,
        outcomes: [],
        historyReadOutcomes: [],
      },
      {
        family: "artifact",
        eligibleAttempts: 0n,
        verifiedAttempts: 0n,
      coveredObjects: 0n,
      totalObjects: 0n,
      touchedCoveredObjects: 0n,
      touchedObjects: 0n,
      pendingLifecycleOperations: 0n,
      oldestPendingAt: null,
        outcomes: [],
        historyReadOutcomes: [],
      },
      {
        family: "record",
        eligibleAttempts: 0n,
        verifiedAttempts: 0n,
        coveredObjects: 2n,
        totalObjects: 4n,
        touchedCoveredObjects: 0n,
        touchedObjects: 0n,
        pendingLifecycleOperations: 0n,
        oldestPendingAt: null,
        outcomes: [],
        historyReadOutcomes: [],
      },
      {
        family: "overall",
        eligibleAttempts: 10n,
        verifiedAttempts: 8n,
      coveredObjects: 47n,
      totalObjects: 114n,
      touchedCoveredObjects: 0n,
      touchedObjects: 0n,
      pendingLifecycleOperations: 0n,
      oldestPendingAt: null,
        outcomes: [],
        historyReadOutcomes: [],
      },
    ]);
  });

  test("counts only exact current verified mappings while retaining all live denominators", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-dashboard.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("from(sessionMessages)");
    expect(source).toContain("from(memories)");
    expect(source).toContain("from(artifacts).where(isNull(artifacts.deletedAt))");
    expect(source).toContain("${memories.cryptoMappingState} = 'verified'");
    expect(source).toContain("${artifacts.cryptoMappingState} = 'verified'");
    expect(source).toContain("revision.disposition = 'mapped'");
    expect(source).toContain("blob.state = 'published'");
    expect(source).toContain("blob.ciphertext_sha256 = ${artifacts.ciphertextSha256}");
  });

  test("keeps ordinary fallback, protected failure, and tool-result receipts distinct", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-dashboard.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("conversationSharedAgentShadowOperations.state} = 'fallback'");
    expect(source).toContain("conversationSharedAgentShadowOperations.state} = 'failed'");
    expect(source).not.toContain("conversationSharedAgentShadowOperations.state} in ('fallback', 'failed')");
    expect(source).toContain("sessionMessageCryptoRevisions.authorRole} = 'tool'");
    expect(source).toContain("tool_results_published:");
    const sharedOutput = source.slice(
      source.indexOf("const output = await db.select"),
      source.indexOf("if (\n    rows.length", source.indexOf("const output = await db.select")),
    );
    expect(sharedOutput).not.toContain("tool_calls is not null");
  });

  test("keeps Artifact blob publication proof out of the Memory aggregate", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-dashboard.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const memoryStart = source.indexOf("${memories.cryptoObjectId} is not null");
    const artifactStart = source.indexOf("${artifacts.cryptoObjectId} is not null");
    const artifactEnd = source.indexOf(".from(artifacts)", artifactStart);
    expect(memoryStart).toBeGreaterThan(-1);
    expect(artifactStart).toBeGreaterThan(memoryStart);
    expect(artifactEnd).toBeGreaterThan(artifactStart);
    expect(source.slice(memoryStart, artifactStart)).not.toContain(
      "artifactCryptoBlobs",
    );
    const artifactProjection = source.slice(artifactStart, artifactEnd);
    expect(artifactProjection).toContain("artifactCryptoBlobs");
    expect(artifactProjection).toContain("blob.state = 'published'");
    expect(artifactProjection).toContain(
      "blob.ciphertext_sha256 = ${artifacts.ciphertextSha256}",
    );
  });

  test("selects cumulative attempts by exact Shadow policy revision", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-dashboard.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain(
      "encryptionTransitionOutcomeTotals.policyRevision",
    );
    expect(source).toContain("shadowEpoch.revision");
    expect(source).not.toContain(
      "encryptionTransitionObservationBuckets.bucketStartedAt,\n        shadowEncryptionStartedAt",
    );
  });

  test("surfaces exact retained latency rows and hard capacity without a magic warning", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ count: "42" }],
        }),
      }),
    } as unknown as Parameters<
      typeof readEncryptionTransitionObservationPressure
    >[0];
    expect(await readEncryptionTransitionObservationPressure(
      db,
      { revision: 3, shadowEncryptionStartedAt: new Date() },
      { storageLimitRows: 10_000, retentionMs: 2_592_000_000 },
    )).toEqual({
      retainedRows: 42n,
      capacityRows: 10_000n,
      pendingAdmissions: 42n,
      admissionCapacity: 10_000n,
      maximumRetentionMs: 2_592_000_000,
    });
  });

  test("uses one live turn denominator and keeps tool stages applicability-bound", async () => {
    const summary = {
      eligible: "3",
      complete: "1",
      pending: "1",
      oldest: new Date("2026-08-20T12:00:00.000Z"),
      browserPrepare: "3",
      humanVerified: "2",
      agentInput: "2",
      streamVerified: "1",
      toolCallEligible: "1",
      toolCallVerified: "1",
      toolResultEligible: "1",
      toolResultVerified: "0",
      transcriptVerified: "1",
    };
    const db = {
      execute: () => Promise.resolve([{
        human_eligible: "2",
        human_verified: "2",
        agent_eligible: "1",
        agent_verified: "1",
        call_eligible: "3",
        call_verified: "3",
        result_eligible: "3",
        result_verified: "3",
      }]),
      select: (selection: Record<string, unknown>) => {
        const builder = {
          leftJoin: () => builder,
          where: () => {
            if ("eligible" in selection) return Promise.resolve([summary]);
            return {
              groupBy: () => Promise.resolve([{
                stage: "tool_result",
                reason: "parity_mismatch",
                count: "1",
              }]),
            };
          },
        };
        return { from: () => builder };
      },
    } as unknown as Parameters<typeof readLiveShadowTurnDashboard>[0];
    const result = await readLiveShadowTurnDashboard(db, {
      revision: 7,
      shadowEncryptionStartedAt: new Date("2026-08-20T11:00:00.000Z"),
    });
    expect(result).toMatchObject({
      eligibleTurns: 3n,
      completeRoundTrips: 1n,
      pendingTurns: 1n,
      fallbacks: [{
        stage: "tool_result",
        reason: "parity_mismatch",
        count: 1n,
      }],
      entities: [
        { entity: "human_message", verified: 2n, eligible: 2n },
        { entity: "final_agent_message", verified: 1n, eligible: 1n },
        { entity: "tool_call", verified: 3n, eligible: 3n },
        { entity: "tool_result", verified: 3n, eligible: 3n },
      ],
    });
    expect(result.stages.find((stage) =>
      stage.stage === "browser_terminal_acknowledgement"
    )).toEqual({
      stage: "browser_terminal_acknowledgement",
      verified: 1n,
      eligible: 3n,
    });
    expect(result.stages.find((stage) =>
      stage.stage === "tool_result_boundary"
    )).toEqual({
      stage: "tool_result_boundary",
      verified: 0n,
      eligible: 1n,
    });
  });

  test("reports content-free V2 Domain-key catch-up and authority states", async () => {
    const db = {
      execute: () => Promise.resolve([{
        requested: "9",
        waiting: "2",
        delivered: "5",
        acknowledged: "4",
        stale: "1",
        expired: "1",
        unrecoverable: "0",
        human_domain_heads: "3",
        ai_domain_heads: "3",
        human_namespace_bundles: "7",
        ai_namespace_bundles: "6",
        human_namespace_bundle_advances: "2",
        ai_namespace_bundle_advances: "1",
      }]),
    } as unknown as Parameters<typeof readDomainKeyCatchUpDashboard>[0];
    expect(await readDomainKeyCatchUpDashboard(db)).toEqual({
      requested: 9n,
      waiting: 2n,
      delivered: 5n,
      acknowledged: 4n,
      stale: 1n,
      expired: 1n,
      unrecoverable: 0n,
      humanDomainHeads: 3n,
      aiDomainHeads: 3n,
      humanNamespaceBundles: 7n,
      aiNamespaceBundles: 6n,
      humanNamespaceBundleAdvances: 2n,
      aiNamespaceBundleAdvances: 1n,
    });
  });

  test("uses the typed Human-peer aggregate query", async () => {
    const epochStartedAt = new Date("2026-08-20T11:00:00.000Z");
    const row = {
      eligible_writes: "0", published_writes: "0", pending_writes: "0",
      fallback_writes: "0", failed_writes: "0", recipient_read_attempts: "0",
      recipient_read_verified: "0", recipient_read_fallback: "0",
    };
    const db = {
      select: () => {
        const builder = {
          from: () => builder,
          leftJoin: () => builder,
          where: () => Promise.resolve([row]),
        };
        return builder;
      },
    } as unknown as Parameters<typeof readHumanPeerLiveShadowDashboard>[0];

    expect(await readHumanPeerLiveShadowDashboard(db, {
      revision: 7,
      shadowEncryptionStartedAt: epochStartedAt,
    })).toEqual({
      eligibleWrites: 0n,
      publishedWrites: 0n,
      pendingWrites: 0n,
      fallbackWrites: 0n,
      failedWrites: 0n,
      recipientReadAttempts: 0n,
      recipientReadVerified: 0n,
      recipientReadFallback: 0n,
    });
  });
});
