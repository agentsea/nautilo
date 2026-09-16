import { describe, expect, test } from "bun:test";
import {
  ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1,
  sql,
  type DirectDatabase,
} from "@nautilo/db";

import { readPostgresStenographerProtectionStatus } from "../../src/server/journal/postgres-stenographer-protection-status.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const NOW = new Date("2026-08-12T10:00:00.000Z");
const SINCE = new Date("2026-08-11T10:00:00.000Z");

function productDatabase(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
): DirectDatabase {
  const policy = {
    id: "server",
    mode,
    shadowBehavior: "fallback",
    revision: 7,
    shadowEncryptionStartedAt: mode === "plaintext_only" ? null : SINCE,
    observationBoundsRevision:
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.revision,
    observationBucketWidthMs:
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.bucketWidthMs,
    observationRetentionMs:
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.retentionMs,
    observationStorageLimitRows:
      ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.storageLimitRows,
    observationLatencyUpperBoundsMs: [
      ...ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1.latencyUpperBoundsMs,
    ],
    observationBoundsConfiguredAt: SINCE,
    createdAt: SINCE,
    updatedAt: NOW,
  };
  const results: unknown[][] = [
    [policy],
    [mode === "plaintext_only"
      ? {
          extraction: "0",
          compaction: "0",
          extractionOldest: null,
          compactionOldest: null,
        }
      : {
          extraction: "2",
          compaction: "3",
          extractionOldest: "2026-08-12 07:00:00+00",
          compactionOldest: "2026-08-12 08:00:00+00",
        }],
    [{ count: "4", oldestAt: "2026-08-12 06:00:00+00" }],
    [{ count: "5", oldestAt: "2026-08-12 05:00:00+00" }],
    [
      { reason: "device", count: "6" },
      { reason: "authority", count: "7" },
    ],
    [
      { reason: "device", count: "8" },
      { reason: "authority", count: "9" },
    ],
  ];

  const select = () => {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit", "innerJoin", "groupBy"]) {
      builder[method] = () => builder;
    }
    builder["getSQL"] = () => sql``;
    builder["then"] = (
      resolve: (value: unknown[]) => unknown,
      reject: (error: unknown) => unknown,
    ) => Promise.resolve(results.shift() ?? []).then(resolve, reject);
    return builder;
  };
  return { select } as unknown as DirectDatabase;
}

async function cryptoConnection(): Promise<Readonly<{
  connection: CryptoPostgresConnection;
  queries: {
    statement: string;
    parameters: readonly DatabaseScalar[];
  }[];
}>> {
  const queries: {
    statement: string;
    parameters: readonly DatabaseScalar[];
  }[] = [];
  const connection: CryptoPostgresConnection = {
    query: async <Row extends DatabaseRow = DatabaseRow>(
      statement: string,
      parameters: readonly DatabaseScalar[] = [],
    ): Promise<readonly Row[]> => {
      queries.push({ statement, parameters: [...parameters] });
      if (statement.includes("current_user::text")) {
        return [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }] as unknown as readonly Row[];
      }
      const rows = statement.includes("finished_at")
        ? [
            { state: "completed", work_kind: "stenographer.extraction", count: "4" },
            { state: "completed", work_kind: "stenographer.compaction", count: "5" },
            { state: "completed", work_kind: "stenographer.output_repair", count: "6" },
            { state: "completed", work_kind: "stenographer.publication_reconcile", count: "99" },
            { state: "cancelled", work_kind: "stenographer.output_repair", count: "2" },
            { state: "terminal_failure", work_kind: "stenographer.rebuild", count: "3" },
          ]
        : parameters.includes(false)
          ? []
          : [
              { state: "awaiting_device", work_kind: "stenographer.extraction", count: "2", oldest_at: "2026-08-12 04:00:00+00" },
              { state: "awaiting_recipient", work_kind: "stenographer.compaction", count: "1", oldest_at: "2026-08-12 03:00:00+00" },
              { state: "running", work_kind: "stenographer.output_repair", count: "3", oldest_at: "2026-08-12 09:00:00+00" },
              { state: "publication_reconciliation", work_kind: "stenographer.extraction", count: "1", oldest_at: "2026-08-12 09:00:00+00" },
            ];
      return rows as unknown as readonly Row[];
    },
    transaction: async <Result>(
      callback: (transaction: CryptoPostgresConnection) => Promise<Result>,
    ) => callback(connection),
  };
  return { connection, queries };
}

function expectBoundEquality(
  query: Readonly<{
    statement: string;
    parameters: readonly DatabaseScalar[];
  }>,
  column: string,
  value: DatabaseScalar,
): void {
  const match = query.statement.match(
    new RegExp(`"${column}" = \\$([1-9][0-9]*)`, "u"),
  );
  expect(match).not.toBeNull();
  expect(query.parameters[Number(match?.[1]) - 1]).toBe(value);
}

describe("readPostgresStenographerProtectionStatus", () => {
  test("aggregates only content-free queue, completion, wait, and fallback facts", async () => {
    const crypto = await cryptoConnection();
    const handle = await verifyCryptoPostgresHandle(crypto.connection);

    const status = await readPostgresStenographerProtectionStatus({
      product: productDatabase("shadow_encryption"),
      crypto: handle,
      now: NOW,
      since: SINCE,
      until: NOW,
    });

    expect(status).toEqual({
      dtoVersion: 1,
      generatedAt: NOW.toISOString(),
      window: { since: SINCE.toISOString(), until: NOW.toISOString() },
      queue: {
        current: {
          awaitingRecipient: "1",
          waitingForDevice: "2",
          grantReady: "0",
          claimed: "0",
          running: "3",
          publicationReconciliation: "1",
          oldestWaitingAt: "2026-08-12T03:00:00.000Z",
        },
        last24h: {
          protectedCompleted: "9",
          outputRepairCompleted: "6",
          cancelled: "2",
          terminalFailures: "3",
        },
      },
      authorityWait: {
        extractionRooms: "2",
        compactionRooms: "3",
        oldestAt: "2026-08-12T07:00:00.000Z",
      },
      plaintextFallback: {
        missingProtection: {
          extractionBatches: "4",
          compactionRollups: "5",
          oldestAt: "2026-08-12T05:00:00.000Z",
        },
        last24h: {
          extraction: { device: "6", authority: "7" },
          compaction: { device: "8", authority: "9" },
        },
      },
    });
    expect(JSON.stringify(status)).not.toMatch(/roomId|namespaceId|requestId|content/iu);
    const authorizationQueries = crypto.queries.filter(({ statement }) =>
      statement.includes("background_crypto_authorization_requests")
    );
    expect(authorizationQueries).toHaveLength(2);
    const activeQuery = authorizationQueries.find(({ statement }) =>
      !statement.includes("finished_at")
    );
    const historyQuery = authorizationQueries.find(({ statement }) =>
      statement.includes("finished_at")
    );
    expect(activeQuery).toBeDefined();
    expect(historyQuery).toBeDefined();
    for (const query of [activeQuery, historyQuery]) {
      if (query === undefined) continue;
      expectBoundEquality(query, "format_version", 2);
      expectBoundEquality(query, "credential_subject_kind", "processor");
    }
    expect(activeQuery?.statement).toContain("expected_policy_revision");
  });

  test("suppresses current queue and authority waits in Plain mode", async () => {
    const crypto = await cryptoConnection();
    const handle = await verifyCryptoPostgresHandle(crypto.connection);

    const status = await readPostgresStenographerProtectionStatus({
      product: productDatabase("plaintext_only"),
      crypto: handle,
      now: NOW,
      since: SINCE,
      until: NOW,
    });

    expect(status.queue.current).toMatchObject({
      awaitingRecipient: "0",
      waitingForDevice: "0",
      grantReady: "0",
      claimed: "0",
      running: "0",
      publicationReconciliation: "0",
    });
    expect(status.authorityWait).toEqual({
      extractionRooms: "0",
      compactionRooms: "0",
      oldestAt: null,
    });
  });
});
