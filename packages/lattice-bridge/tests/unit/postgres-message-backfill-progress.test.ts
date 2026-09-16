import { describe, expect, test } from "bun:test";

import { readMessageBackfillProgressAggregate } from
  "../../src/server/message/postgres-message-backfill-progress.ts";
import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresExecutor,
  ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const HUMAN = "11111111-1111-4111-8111-111111111111";

class RecordingExecutor implements ConversationProductPostgresExecutor {
  readonly calls: Array<Readonly<{
    statement: string;
    parameters: readonly ConversationProductPostgresScalar[];
  }>> = [];

  constructor(
    private readonly rows: readonly ConversationProductDatabaseRow[],
  ) {}

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    return Promise.resolve(this.rows as readonly Row[]);
  }
}

function aggregateRow(
  overrides: ConversationProductDatabaseRow = {},
): ConversationProductDatabaseRow {
  return {
    eligible: 0n,
    pending: 0n,
    already_authenticated: 0n,
    independently_parity_verified: 0n,
    claimed_repairing: 0n,
    repaired_and_verified: 0n,
    unsupported: 0n,
    failed: 0n,
    ...overrides,
  };
}

describe("Postgres Message backfill progress", () => {
  test("reduces the canonical readable corpus to one content-free aggregate", async () => {
    const executor = new RecordingExecutor([aggregateRow({
      eligible: 31n,
      pending: 19n,
      already_authenticated: 4n,
      independently_parity_verified: 8n,
      claimed_repairing: 1n,
      repaired_and_verified: 6n,
      unsupported: 2n,
      failed: 7n,
    })]);

    const result = await readMessageBackfillProgressAggregate(executor, {
      subjectHumanId: HUMAN,
      policyRevision: 23,
    });
    expect(result).toEqual({
      eligible: 31,
      pending: 19,
      alreadyAuthenticated: 4,
      independentlyParityVerified: 8,
      claimedRepairing: 1,
      repairedAndVerified: 6,
      unsupported: 2,
      failed: 7,
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0]!;
    const statement = call.statement.replaceAll(/\s+/gu, " ").toLowerCase();
    expect(statement).toStartWith("select count(*) filter");
    expect(statement).toContain("from (select");
    expect(statement).toContain("message_backfill_source_membership");
    expect(statement).toContain("message_backfill_authority_membership");
    expect(statement).toContain("session_message_crypto_revisions");
    expect(statement).toContain("message_backfill_ordinary_restoration");
    expect(statement).toContain("left join \"message_backfill_failures\"");
    expect(statement).not.toContain("order by");
    expect(statement).not.toContain(" limit ");
    expect(statement).not.toContain("\"session_messages\".\"tool_calls\"");
    expect(statement).not.toContain("\"session_messages\".\"metadata\"");
    expect(call.parameters).toContain(HUMAN);
    expect(call.parameters).toContain(23);
  });

  test("mirrors classifier evidence, restoration and failure coordinates", async () => {
    const executor = new RecordingExecutor([aggregateRow()]);
    await readMessageBackfillProgressAggregate(executor, {
      subjectHumanId: HUMAN,
      policyRevision: 41,
      claimed: {
        action: "restore",
        messageId: 12,
        sessionId: "22222222-2222-4222-8222-222222222222",
        revision: 3,
        sourceRoomId: "33333333-3333-4333-8333-333333333333",
        namespaceId: "44444444-4444-4444-8444-444444444444",
        role: "tool",
        cryptoObjectId: "message:v2:object-12",
        sourceRevision: 9,
      },
    });

    const statement = executor.calls[0]!.statement
      .replaceAll(/\s+/gu, " ").toLowerCase();
    for (const parity of [
      "server_verified",
      "client_verified",
      "server_authenticated",
      "client_authenticated",
    ]) expect(statement).toContain(parity);
    expect(statement).toContain("ordinary_restoration_accepted");
    expect(statement).toContain("completion");
    expect(statement).toContain("disposition");
    expect(statement).toContain("repair_identity_present");
    expect(statement).toContain("edit_revision");
    expect(statement).toContain("namespace_access_revision");
    expect(statement).toContain("crypto_object_id");
    expect(statement).toContain("message_source_revision");
    expect(statement).toContain("source_revision");
    expect(statement).toContain("reason");
    expect(statement).toContain("unsupported");
    expect(statement).toContain("supported_topology");
    expect(statement).toContain("claimed_repairing");
    expect(statement).toContain("\"message_backfill_progress_candidate\".\"session_id\"");
    expect(executor.calls[0]!.parameters).toContain(12);
    expect(executor.calls[0]!.parameters).toContain("tool");
    expect(executor.calls[0]!.parameters).toContain(9);
  });

  test.each([
    ["encrypt", "user", null, "accepted"],
    ["verify", "assistant", null, "accepted"],
    ["restore", "system", null, "accepted"],
    ["encrypt", "tool", 91, "matched"],
    ["verify", "tool", 92, "matched"],
    ["restore", "tool", 93, "matched"],
    ["restore", "tool", null, "rejected"],
    ["restore", "user", 94, "rejected"],
  ] as const)(
    "types claimed %s/%s source revision without nullable SQL parameters",
    async (action, role, sourceRevision, expected) => {
      const executor = new RecordingExecutor([aggregateRow({
        claimed_repairing: expected === "rejected" ? 0n : 1n,
      })]);
      const result = await readMessageBackfillProgressAggregate(executor, {
        subjectHumanId: HUMAN,
        policyRevision: 51,
        claimed: {
          action,
          messageId: 52,
          sessionId: "22222222-2222-4222-8222-222222222222",
          revision: 3,
          sourceRoomId: "33333333-3333-4333-8333-333333333333",
          namespaceId: "44444444-4444-4444-8444-444444444444",
          role,
          cryptoObjectId: "message:v2:object-52",
          sourceRevision,
        },
      });

      expect(result.claimedRepairing).toBe(expected === "rejected" ? 0 : 1);
      const call = executor.calls[0]!;
      const statement = call.statement.replaceAll(/\s+/gu, " ").toLowerCase();
      expect(statement).not.toMatch(/\$\d+ is (?:not )?null/u);
      expect(call.parameters).not.toContain(null);
      const alias = statement.indexOf('as "claimed_repairing"');
      const start = statement.lastIndexOf("count(*) filter", alias);
      const claimed = statement.slice(start, alias);
      if (expected === "matched") {
        expect(claimed).toContain(
          '"message_backfill_progress_candidate"."message_source_revision" =',
        );
        expect(call.parameters).toContain(sourceRevision);
      } else {
        expect(claimed).toContain(
          expected === "accepted" ? "and true" : "and false",
        );
      }
      if (action === "encrypt") {
        expect(claimed).toContain(
          'and ( "message_backfill_progress_candidate"."crypto_object_id" is null',
        );
      } else {
        expect(claimed).toContain(
          'and "message_backfill_progress_candidate"."crypto_object_id" is not distinct from',
        );
      }
    },
  );

  test("requires recognized parity before a restoration receipt completes work", async () => {
    const executor = new RecordingExecutor([aggregateRow()]);
    await readMessageBackfillProgressAggregate(executor, {
      subjectHumanId: HUMAN,
      policyRevision: 1,
    });

    const statement = executor.calls[0]!.statement
      .replaceAll(/\s+/gu, " ").toLowerCase();
    const recognizedParityGuard = [
      '"message_backfill_progress_candidate"."parity_status" in (',
      "'server_verified', 'client_verified',",
      "'server_authenticated', 'client_authenticated'",
      ")",
    ].join(" ");
    const restorationReceipt = [
      '"message_backfill_progress_candidate"."ordinary_restoration_accepted"',
      "= true",
    ].join(" ");
    expect(statement).toContain(
      `where not ( "message_backfill_progress_candidate".`
      + '"supported_topology" = true',
    );
    expect(statement).toContain(recognizedParityGuard);
    expect(statement.indexOf(recognizedParityGuard)).toBeLessThan(
      statement.indexOf(restorationReceipt),
    );
    expect(statement).toContain(
      recognizedParityGuard.replace('"parity_status" in (',
        '"parity_status" not in ('),
    );
  });

  test("rejects invalid authority and policy coordinates before querying", async () => {
    const executor = new RecordingExecutor([]);
    expect(readMessageBackfillProgressAggregate(executor, {
      subjectHumanId: "not-a-human-id",
      policyRevision: 1,
    })).rejects.toThrow("subject Human ID");
    expect(readMessageBackfillProgressAggregate(executor, {
      subjectHumanId: HUMAN,
      policyRevision: 0,
    })).rejects.toThrow("policy revision");
    expect(executor.calls).toHaveLength(0);
  });

  test("recognizes an encrypt claim before its new object pointer is installed", async () => {
    const executor = new RecordingExecutor([aggregateRow()]);
    await readMessageBackfillProgressAggregate(executor, {
      subjectHumanId: HUMAN,
      policyRevision: 1,
      claimed: {
        action: "encrypt",
        messageId: 12,
        sessionId: "22222222-2222-4222-8222-222222222222",
        revision: 0,
        sourceRoomId: "33333333-3333-4333-8333-333333333333",
        namespaceId: "44444444-4444-4444-8444-444444444444",
        role: "system",
        cryptoObjectId: "message:v2:new-object",
        sourceRevision: null,
      },
    });
    const statement = executor.calls[0]!.statement
      .replaceAll(/\s+/gu, " ").toLowerCase();
    expect(statement).toContain(
      '"message_backfill_progress_candidate"."crypto_object_id" is null',
    );
    expect(executor.calls[0]!.parameters).toContain("message:v2:new-object");
  });

  test("rejects malformed or unsafe aggregate output", async () => {
    expect(readMessageBackfillProgressAggregate(
      new RecordingExecutor([aggregateRow({pending: -1n})]),
      {subjectHumanId: HUMAN, policyRevision: 1},
    )).rejects.toThrow("pending");
    expect(readMessageBackfillProgressAggregate(
      new RecordingExecutor([]),
      {subjectHumanId: HUMAN, policyRevision: 1},
    )).rejects.toThrow("must return one row");
  });
});
