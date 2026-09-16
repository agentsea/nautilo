import { describe, expect, test } from "bun:test";

import {
  MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE,
  readMessageBackfillCandidates,
} from "../../src/server/message/postgres-message-backfill-discovery.ts";
import { PROTECTED_TOP_LEVEL_ROOM_KINDS } from
  "../../src/message/protected-room-topology.ts";
import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresExecutor,
  ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SOURCE_ROOM = "33333333-3333-4333-8333-333333333333";
const AUTHORITY_ROOM = "44444444-4444-4444-8444-444444444444";
const NAMESPACE = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";

class RecordingExecutor implements ConversationProductPostgresExecutor {
  readonly calls: Array<Readonly<{
    statement: string;
    parameters: readonly ConversationProductPostgresScalar[];
  }>> = [];

  constructor(
    private readonly rows: readonly ConversationProductDatabaseRow[] = [],
  ) {}

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    return Promise.resolve(this.rows as readonly Row[]);
  }
}

function structuralRow(
  overrides: ConversationProductDatabaseRow = {},
): ConversationProductDatabaseRow {
  return {
    message_id: 12,
    session_id: SESSION,
    edit_revision: 3,
    role: "user",
    ordinary_present: true,
    crypto_object_id: "message:v2:object-12",
    session_room_id: SOURCE_ROOM,
    subthread_room_id: SOURCE_ROOM,
    source_room_id: SOURCE_ROOM,
    authority_room_id: AUTHORITY_ROOM,
    namespace_id: NAMESPACE,
    namespace_access_revision: 7,
    message_source_revision: 9,
    session_owner_user_id: OWNER,
    session_agent_id: AGENT,
    created_at: new Date("2026-09-08T08:00:00.000Z"),
    human_turn_id: "turn-id-12",
    fingerprint: "human-turn-12",
    supported_topology: false,
    target_key_class: "ai",
    lifecycle_session_id: SESSION,
    lifecycle_message_id: 12,
    lifecycle_revision: 3,
    lifecycle_crypto_object_id: "message:v2:object-12",
    key_class: "human",
    completion: "complete",
    disposition: "mapped",
    parity_status: "client_authenticated",
    repair_identity_present: true,
    ordinary_restoration_accepted: true,
    ...overrides,
  };
}

describe("Postgres Message backfill discovery", () => {
  test("compiles one bounded structural and authority-scoped keyset query", async () => {
    const executor = new RecordingExecutor();
    await readMessageBackfillCandidates(executor, {
      subjectHumanId: HUMAN,
      afterMessageId: 8,
      throughMessageId: 80,
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0]!;
    const statement = call.statement.replaceAll(/\s+/gu, " ").toLowerCase();
    expect(statement).toContain("from \"session_messages\"");
    expect(statement).toContain(
      "when \"session_messages\".\"content\" is not null then true",
    );
    expect(statement).not.toContain("\"session_messages\".\"tool_calls\"");
    expect(statement).not.toContain("\"session_messages\".\"tool_name\"");
    expect(statement).not.toContain("\"session_messages\".\"metadata\"");
    expect(statement).not.toContain(" as \"content\"");
    expect(statement).toContain(
      "\"session_message_crypto_revisions\".\"edit_revision\" = \"session_messages\".\"edit_revision\"",
    );
    expect(statement).toContain(
      "\"message_backfill_ordinary_restoration\".\"crypto_object_id\" = \"session_messages\".\"crypto_object_id\"",
    );
    expect(statement).toContain(
      "\"message_backfill_ordinary_restoration\".\"expected_key_class\" = \"session_message_crypto_revisions\".\"key_class\"",
    );
    expect(statement).toContain("message_backfill_source_membership");
    expect(statement).toContain("message_backfill_authority_membership");
    expect(statement).toContain("message_backfill_agent_membership");
    expect(statement).toContain(
      '"message_backfill_source_room"."id" = coalesce("session_messages"."subthread_room_id", "sessions"."room_id")',
    );
    expect(statement).toContain(
      '"sessions"."room_id" = "message_backfill_source_room"."id"',
    );
    expect(statement).toContain(
      '"sessions"."room_id" = "message_backfill_authority_room"."id"',
    );
    expect(statement).toContain("\"session_messages\".\"id\" >");
    expect(statement).toContain("\"session_messages\".\"id\" <=");
    expect(statement).toContain("order by \"session_messages\".\"id\" asc");
    expect(statement).toContain("limit");
    expect(call.parameters).toContain(8);
    expect(call.parameters).toContain(80);
    expect(call.parameters).toContain(HUMAN);
    expect(call.parameters).toContain(MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE);
    for (const role of ["user", "assistant", "tool", "system"]) {
      expect(call.parameters).toContain(role);
    }
    // Source selection, top-level authority selection and the support
    // projection must all derive from the one protected-topology contract.
    for (const kind of PROTECTED_TOP_LEVEL_ROOM_KINDS) {
      expect(call.parameters.filter((parameter) => parameter === kind))
        .toHaveLength(3);
    }
  });

  test("maps a public candidate as protected repair work", async () => {
    const executor = new RecordingExecutor([structuralRow({
      supported_topology: true,
      crypto_object_id: null,
      lifecycle_session_id: null,
      lifecycle_message_id: null,
      lifecycle_revision: null,
      lifecycle_crypto_object_id: null,
      key_class: null,
      completion: null,
      disposition: null,
      parity_status: null,
      repair_identity_present: false,
      ordinary_restoration_accepted: false,
    })]);
    const [candidate] = await readMessageBackfillCandidates(executor, {
      subjectHumanId: HUMAN,
      afterMessageId: 11,
      throughMessageId: 12,
    });

    expect(candidate).toMatchObject({
      supportedTopology: true,
      ordinaryPresent: true,
      cryptoObjectId: null,
    });
  });

  test("maps structural metadata, retained class and exact repair evidence", async () => {
    const executor = new RecordingExecutor([structuralRow()]);
    const rows = await readMessageBackfillCandidates(executor, {
      subjectHumanId: HUMAN,
      afterMessageId: 11,
      throughMessageId: 12,
    });

    expect(rows).toEqual([{
      messageId: 12,
      sessionId: SESSION,
      revision: 3,
      role: "user",
      ordinaryPresent: true,
      cryptoObjectId: "message:v2:object-12",
      sessionRoomId: SOURCE_ROOM,
      subthreadRoomId: SOURCE_ROOM,
      sourceRoomId: SOURCE_ROOM,
      authorityRoomId: AUTHORITY_ROOM,
      namespaceId: NAMESPACE,
      namespaceAccessRevision: 7,
      messageSourceRevision: 9,
      sessionOwnerUserId: OWNER,
      sessionAgentId: AGENT,
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      humanTurnId: "turn-id-12",
      logicalMessageKey: "turn:human-turn-12",
      supportedTopology: false,
      targetKeyClass: "ai",
      lifecycle: {
        sessionId: SESSION,
        messageId: 12,
        revision: 3,
        cryptoObjectId: "message:v2:object-12",
        keyClass: "human",
        completion: "complete",
        disposition: "mapped",
        parityStatus: "client_authenticated",
        repairIdentityPresent: true,
      },
      ordinaryRestorationAccepted: true,
    }]);
    expect(Object.keys(rows[0]!)).not.toContain("content");
    expect(Object.keys(rows[0]!)).not.toContain("toolCalls");
    expect(rows[0]!.targetKeyClass).toBe("ai");
    expect(rows[0]!.lifecycle?.keyClass).toBe("human");
  });

  test("keeps missing lifecycle structural and derives non-Human logical keys", async () => {
    const executor = new RecordingExecutor([structuralRow({
      message_id: 13,
      role: "system",
      crypto_object_id: null,
      subthread_room_id: null,
      human_turn_id: null,
      fingerprint: "ignored-for-system",
      target_key_class: "human",
      lifecycle_session_id: null,
      lifecycle_message_id: null,
      lifecycle_revision: null,
      lifecycle_crypto_object_id: null,
      key_class: null,
      completion: null,
      disposition: null,
      parity_status: null,
      repair_identity_present: false,
      ordinary_restoration_accepted: false,
    })]);
    const rows = await readMessageBackfillCandidates(executor, {
      subjectHumanId: HUMAN,
      afterMessageId: 12,
    });

    expect(rows[0]?.logicalMessageKey).toBe("row:13");
    expect(rows[0]?.lifecycle).toBeNull();
    expect(rows[0]?.targetKeyClass).toBe("human");
  });

  test("returns no query when an exact keyset range is already exhausted", async () => {
    const executor = new RecordingExecutor();
    expect(await readMessageBackfillCandidates(executor, {
      subjectHumanId: HUMAN,
      afterMessageId: 42,
      throughMessageId: 42,
    })).toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });
});
