import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  appendCanonicalTranscriptRowsInTx,
  appendCanonicalTranscriptRowsToExistingSessionInTx,
  deleteMessageHardInTx,
  editCanonicalTranscriptMessageInTx,
  type CanonicalTranscriptAppendRow,
  type CanonicalTranscriptTx,
} from "../../src/canonical-transcript-mutations";
import { MessageDeleteError } from "../../src/membership";
import { persistNotificationClassification, type NotificationClassificationTx } from "../../src/notification-classification";

type Operation = "select" | "insert" | "update" | "delete" | "execute";

interface Step {
  operation: Operation;
  result: unknown;
}

class ScriptedTransaction {
  readonly events: string[] = [];
  readonly insertedValues: unknown[] = [];
  readonly updatedValues: unknown[] = [];
  readonly selectedFieldKeys: string[][] = [];
  readonly policyEvents: string[] = [];
  policyMode = "shadow_encryption";

  constructor(private readonly steps: Step[]) {}

  private take(operation: Operation): unknown {
    const step = this.steps.shift();
    expect(step?.operation).toBe(operation);
    this.events.push(operation);
    return step?.result;
  }

  private chain(result: unknown): unknown {
    const { events, insertedValues, updatedValues } = this;
    const chain = {
      from(): unknown {
        return chain;
      },
      innerJoin(): unknown {
        return chain;
      },
      leftJoin(): unknown {
        return chain;
      },
      where(): unknown {
        return chain;
      },
      for(lock: string): unknown {
        events.push(`for:${lock}`);
        return chain;
      },
      values(value: unknown): unknown {
        insertedValues.push(value);
        return chain;
      },
      set(value: unknown): unknown {
        updatedValues.push(value);
        return chain;
      },
      onConflictDoNothing(): unknown {
        return chain;
      },
      onConflictDoUpdate(): unknown {
        return chain;
      },
      limit(): Promise<unknown> {
        return Promise.resolve(result);
      },
      returning(): Promise<unknown> {
        return Promise.resolve(result);
      },
      then(
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ): Promise<unknown> {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  execute(query: Parameters<PgDialect["sqlToQuery"]>[0]): Promise<unknown> {
    const sql = new PgDialect().sqlToQuery(query).sql;
    if (sql.includes("nautilo:encryption-transition-policy:v1")) {
      this.policyEvents.push("shared-policy-lock");
      return Promise.resolve([]);
    }
    return Promise.resolve(this.take("execute"));
  }

  select(fields?: Record<string, unknown>): unknown {
    if (fields && Object.keys(fields).sort().join(",") === "mode,revision") {
      this.policyEvents.push("policy-read");
      return this.chain([{ mode: this.policyMode, revision: 1 }]);
    }
    this.selectedFieldKeys.push(Object.keys(fields ?? {}));
    return this.chain(this.take("select"));
  }

  insert(): unknown {
    return this.chain(this.take("insert"));
  }

  update(): unknown {
    return this.chain(this.take("update"));
  }

  delete(): unknown {
    return this.chain(this.take("delete"));
  }

  assertExhausted(): void {
    expect(this.steps).toEqual([]);
  }
}

describe("internal website supervision notification admission", () => {
  for (const role of ["user", "assistant", "tool"] as const) {
    test(`${role} audit row never enters notification recipient classification`, async () => {
      const script = new ScriptedTransaction([{
        operation: "select",
        result: [{
          role, content: "Internal inspection, not a Human update", replyToMessageId: null,
          transcriptOrigin: "main", roomId: "room-1", sessionOwnerId: "user-1", roomKind: "private",
          metadata: { originatedBy: "connected_web_operation", operationId: "operation-1", controlEpoch: 1 },
        }],
      }]);
      expect(await persistNotificationClassification(script as unknown as NotificationClassificationTx, {
        messageId: 42,
        context: { mentionedHumanUserIds: [], causalHumanUserId: null, causalHumanTurnId: null },
      })).toBe(false);
      expect(script.events).toEqual(["select"]);
      script.assertExhausted();
    });
  }
});

describe("canonical transcript edit transaction seam", () => {
  test("publishes a Full edit with exact fanout objects and no ordinary fields", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        messageId: 41, sessionId: "session-1", role: "user",
        fingerprint: "human-turn-1", editRevision: 2,
        ownerId: "user-1", roomId: "room-1",
      }] },
      { operation: "select", result: [
        { messageId: 41, sessionId: "session-1", role: "user", editRevision: 2 },
        { messageId: 52, sessionId: "session-2", role: "user", editRevision: 2 },
      ] },
      { operation: "update", result: [{ messageId: 41 }] },
      { operation: "update", result: [{ messageId: 52 }] },
      { operation: "insert", result: [] },
    ]);
    script.policyMode = "encrypted_only";
    const result = await editCanonicalTranscriptMessageInTx(asTx(script), {
      messageId: 41,
      expectedRevision: 2,
      content: null,
      publicationPolicy: { expectedRevision: 1, representation: "protected_only" },
      protectedTargets: [
        { sessionId: "session-1", messageId: 41, cryptoObjectId: "object-41-v3" },
        { sessionId: "session-2", messageId: 52, cryptoObjectId: "object-52-v3" },
      ],
    });
    expect(result?.nextRevision).toBe(3);
    expect(script.policyEvents).toEqual(["shared-policy-lock", "policy-read"]);
    expect(script.updatedValues.slice(0, 2)).toEqual([
      expect.objectContaining({ content: null, toolCalls: null, toolName: null, cryptoObjectId: "object-41-v3", editRevision: 3 }),
      expect.objectContaining({ content: null, toolCalls: null, toolName: null, cryptoObjectId: "object-52-v3", editRevision: 3 }),
    ]);
    script.assertExhausted();
  });

  test("rejects an incomplete Full target set before transcript mutation", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        messageId: 41, sessionId: "session-1", role: "user",
        fingerprint: "human-turn-1", editRevision: 2,
        ownerId: "user-1", roomId: "room-1",
      }] },
      { operation: "select", result: [
        { messageId: 41, sessionId: "session-1", role: "user", editRevision: 2 },
        { messageId: 52, sessionId: "session-2", role: "user", editRevision: 2 },
      ] },
    ]);
    script.policyMode = "encrypted_only";
    expect(await editCanonicalTranscriptMessageInTx(asTx(script), {
      messageId: 41,
      expectedRevision: 2,
      content: null,
      publicationPolicy: { expectedRevision: 1, representation: "protected_only" },
      protectedTargets: [
        { sessionId: "session-1", messageId: 41, cryptoObjectId: "object-41-v3" },
      ],
    })).toBeNull();
    expect(script.updatedValues).toEqual([]);
    script.assertExhausted();
  });

  test("edits every Human fingerprint sibling under one Room lock and invalidates the journal", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          messageId: 41,
          sessionId: "session-1",
          role: "user",
          fingerprint: "human-turn-1",
          editRevision: 2,
          ownerId: "user-1",
          roomId: "room-1",
        }],
      },
      {
        operation: "select",
        result: [
          {
            messageId: 41,
            sessionId: "session-1",
            role: "user",
            editRevision: 2,
          },
          {
            messageId: 52,
            sessionId: "session-2",
            role: "user",
            editRevision: 2,
          },
        ],
      },
      {
        operation: "update",
        result: [{ messageId: 41 }, { messageId: 52 }],
      },
      { operation: "insert", result: [] },
    ]);

    const result = await editCanonicalTranscriptMessageInTx(
      asTx(script),
      {
        messageId: 41,
        expectedRevision: 2,
        content: "edited logical turn",
        clearCryptoObjectId: true,
      },
      {
        afterRowsEdited: async ({ rows }) => {
          script.events.push(`hook:${rows.map((row) => row.messageId).join(",")}`);
          return "group-receipt";
        },
      },
    );

    expect(result?.rows.map((row) => row.messageId)).toEqual([41, 52]);
    expect(result?.nextRevision).toBe(3);
    expect(result?.hookResult).toBe("group-receipt");
    expect(script.events).toEqual([
      "select",
      "execute",
      "select",
      "for:update",
      "select",
      "for:update",
      "update",
      "insert",
      "hook:41,52",
    ]);
    script.assertExhausted();
  });

  test("keeps Agent-authored edits explicitly single-row", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          messageId: 61,
          sessionId: "session-agent",
          role: "assistant",
          fingerprint: "agent-fingerprint",
          editRevision: 0,
          ownerId: "user-1",
          roomId: "room-1",
        }],
      },
      { operation: "update", result: [{ messageId: 61 }] },
      { operation: "insert", result: [] },
    ]);

    const result = await editCanonicalTranscriptMessageInTx(asTx(script), {
      messageId: 61,
      expectedRevision: 0,
      content: "edited Agent row",
      clearCryptoObjectId: true,
    });

    expect(result?.rows).toEqual([{
      messageId: 61,
      sessionId: "session-agent",
      role: "assistant",
      editRevision: 0,
    }]);
    expect(script.events.filter((event) => event === "select")).toHaveLength(2);
    script.assertExhausted();
  });
});

const row: CanonicalTranscriptAppendRow = {
  role: "tool",
  content: "tool result",
  toolCalls: null,
  toolName: "search",
  fingerprint: "fp-1",
  humanTurnId: null,
  transcriptOrigin: "main",
  parentThreadId: null,
  scopeId: null,
  metadata: null,
  subthreadRoomId: null,
  replyToMessageId: null,
};

const session = {
  threadId: "room:room-1",
  ownerId: "user-1",
  personaId: "owner",
  agentId: "agent-1",
  roomId: "room-1",
  title: "Room",
};

function asTx(script: ScriptedTransaction): CanonicalTranscriptTx {
  return script as unknown as CanonicalTranscriptTx;
}

describe("canonical transcript append transaction seam", () => {
  test("Full blocks legacy ordinary append before Room or entity work", async () => {
    const script = new ScriptedTransaction([]);
    script.policyMode = "encrypted_only";
    expect(appendCanonicalTranscriptRowsInTx(asTx(script), {
      session, rows: [row],
    })).rejects.toThrow("ordinary_forbidden");
    expect(script.events).toEqual([]);
  });

  test("stale Full preparation cannot append after policy changes", async () => {
    const script = new ScriptedTransaction([]);
    script.policyMode = "encrypted_only";
    expect(appendCanonicalTranscriptRowsToExistingSessionInTx(asTx(script), {
      sessionId: "session-1",
      publicationPolicy: { expectedRevision: 0, representation: "protected_only" },
      rows: [{
        ...row, content: null, toolName: null,
        protectedStructuralProjection: {
          notificationEligibility: "excluded", subthreadReplyClassification: "excluded",
        },
      }],
    })).rejects.toThrow("stale");
    expect(script.events).toEqual([]);
  });
  test("rejects absent ordinary bodies without structural facts before querying", async () => {
    const script = new ScriptedTransaction([]);
    expect(appendCanonicalTranscriptRowsToExistingSessionInTx(asTx(script), {
      sessionId: "session-1", rows: [{ ...row, content: null }],
    })).rejects.toThrow("protected structural projection");
    expect(script.events).toEqual([]);
  });

  test("rejects hidden ordinary tool and metadata siblings before querying", async () => {
    const protectedRow: CanonicalTranscriptAppendRow = {
      ...row, content: null, toolName: null,
      protectedStructuralProjection: {
        notificationEligibility: "excluded", subthreadReplyClassification: "excluded",
      },
    };
    for (const changed of [
      { ...protectedRow, toolCalls: "private arguments" },
      { ...protectedRow, toolName: "private tool" },
      { ...protectedRow, metadata: { content: "private body" } },
    ]) {
      const script = new ScriptedTransaction([]);
      expect(appendCanonicalTranscriptRowsToExistingSessionInTx(asTx(script), {
        sessionId: "session-1", rows: [changed],
      })).rejects.toThrow("ordinary tool or metadata bodies");
      expect(script.events).toEqual([]);
    }
  });
  test("locks, dedups, allocates, hooks and inserts in the required order", async () => {
    const script = new ScriptedTransaction([
      { operation: "execute", result: [] }, // Room lock
      { operation: "select", result: [{ id: "session-1" }] },
      { operation: "select", result: [] }, // fingerprint precheck
      { operation: "execute", result: [{ id: 41 }] }, // nextval
      { operation: "insert", result: [{ id: 41, createdAt: new Date("2026-09-06T12:01:02Z") }] },
      {
        operation: "select",
        result: [{
          role: "tool",
          content: "tool result",
          replyToMessageId: null,
          transcriptOrigin: "main",
          metadata: null,
          roomId: "room-1",
          sessionOwnerId: "user-1",
          roomKind: "private",
        }],
      },
      { operation: "select", result: [{ messageCount: 3 }] },
      { operation: "update", result: [] },
    ]);

    const result = await appendCanonicalTranscriptRowsInTx(
      asTx(script),
      { session, rows: [row] },
      {
        afterMessageIdAllocated: async ({ messageId }) => {
          script.events.push(`hook:${messageId}`);
          return "receipt-41";
        },
      },
    );

    expect(script.events).toEqual([
      "execute",
      "select",
      "select",
      "execute",
      "hook:41",
      "insert",
      "select",
      "select",
      "update",
    ]);
    expect(script.insertedValues).toContainEqual(
      expect.objectContaining({ id: 41, sessionId: "session-1" }),
    );
    expect(result.insertedRows[0]?.hookResult).toBe("receipt-41");
    expect(result.insertedRows[0]?.createdAt).toBe("2026-09-06T12:01:02.000Z");
    script.assertExhausted();
  });

  test("fingerprint replay consumes neither a serial ID nor the hook", async () => {
    const script = new ScriptedTransaction([
      { operation: "execute", result: [] },
      { operation: "select", result: [{ id: "session-1" }] },
      { operation: "select", result: [{ id: 40 }] },
    ]);
    let hooked = false;

    const result = await appendCanonicalTranscriptRowsInTx(
      asTx(script),
      { session, rows: [row] },
      {
        afterMessageIdAllocated: async () => {
          hooked = true;
        },
      },
    );

    expect(hooked).toBe(false);
    expect(result.insertedCount).toBe(0);
    expect(script.events).toEqual(["execute", "select", "select"]);
    script.assertExhausted();
  });

  test("writes one content-free candidate after eligible message classification", async () => {
    const script = new ScriptedTransaction([
      { operation: "execute", result: [] },
      { operation: "select", result: [{ id: "session-1" }] },
      { operation: "select", result: [] },
      { operation: "execute", result: [{ id: 45 }] },
      { operation: "insert", result: [{ id: 45 }] },
      {
        operation: "select",
        result: [{
          role: "assistant",
          content: "A durable candidate follows a classified message.",
          replyToMessageId: null,
          transcriptOrigin: "main",
          metadata: null,
          roomId: "room-1",
          sessionOwnerId: "user-1",
          roomKind: "private",
        }],
      },
      {
        operation: "select",
        result: [{ actorId: "actor-1", kind: "user", userId: "user-1" }],
      },
      { operation: "insert", result: [] },
      { operation: "select", result: [{ messageCount: 3 }] },
      { operation: "update", result: [] },
    ]);

    await appendCanonicalTranscriptRowsInTx(asTx(script), {
      session,
      rows: [{
        ...row,
        role: "assistant",
        content: "A durable candidate follows a classified message.",
        humanTurnId: null,
      }],
    });

    expect(script.events).toEqual([
      "execute",
      "select",
      "select",
      "execute",
      "insert",
      "select",
      "select",
      "insert",
      "select",
      "update",
    ]);
    const candidate = script.insertedValues.find(
      (value) => typeof value === "object" && value !== null && "messageId" in value,
    );
    expect(candidate).toEqual({ messageId: 45 });
    script.assertExhausted();
  });

  test("existing-session append resolves and locks its canonical Room", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "execute", result: [{ id: 43 }] },
      { operation: "insert", result: [{ id: 43 }] },
      {
        operation: "select",
        result: [{
          role: "tool",
          content: "tool result",
          replyToMessageId: null,
          transcriptOrigin: "main",
          metadata: null,
          roomId: "room-1",
          sessionOwnerId: "user-1",
          roomKind: "private",
        }],
      },
      { operation: "select", result: [{ messageCount: 0 }] },
      { operation: "update", result: [] },
    ]);

    const result = await appendCanonicalTranscriptRowsToExistingSessionInTx(
      asTx(script),
      { sessionId: "session-1", rows: [row] },
      {
        afterMessageIdAllocated: async ({ roomId }) => {
          script.events.push(`hook:${roomId}`);
        },
      },
    );

    expect(result.insertedRows[0]?.id).toBe("43");
    expect(script.events).toEqual([
      "select",
      "execute",
      "select",
      "execute",
      "hook:room-1",
      "insert",
      "select",
      "select",
      "update",
    ]);
    script.assertExhausted();
  });

  test("rejects protected cross-Room Subthread and reply anchors under the Room lock", async () => {
    const crossSubthread = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
    ]);
    expect(
      appendCanonicalTranscriptRowsToExistingSessionInTx(
        asTx(crossSubthread),
        {
          sessionId: "session-1",
          rows: [{
            ...row,
            subthreadRoomId: "room-2",
            protectedStructuralProjection: {
              notificationEligibility: "excluded",
              subthreadReplyClassification: "excluded",
            },
          }],
        },
      ),
    ).rejects.toThrow(/Subthread does not belong/i);
    crossSubthread.assertExhausted();

    const crossReply = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
    ]);
    expect(
      appendCanonicalTranscriptRowsToExistingSessionInTx(
        asTx(crossReply),
        {
          sessionId: "session-1",
          rows: [{
            ...row,
            fingerprint: null,
            replyToMessageId: 91,
            protectedStructuralProjection: {
              notificationEligibility: "excluded",
              subthreadReplyClassification: "excluded",
            },
          }],
        },
      ),
    ).rejects.toThrow(/reply target is outside/i);
    expect(crossReply.events).toEqual(["select", "execute", "select"]);
    crossReply.assertExhausted();

    const legacyReplay = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{ id: 40 }] },
    ]);
    expect(
      await appendCanonicalTranscriptRowsToExistingSessionInTx(
        asTx(legacyReplay),
        {
          sessionId: "session-1",
          rows: [{ ...row, subthreadRoomId: "legacy-room-2" }],
        },
      ),
    ).toMatchObject({ insertedCount: 0 });
    legacyReplay.assertExhausted();
  });

  test("protected append notification predicates never select plaintext or metadata", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "execute", result: [{ id: 44 }] },
      { operation: "insert", result: [{ id: 44 }] },
      {
        operation: "select",
        result: [{
          roomId: "room-1",
          sessionOwnerId: "user-1",
          roomKind: "private",
        }],
      },
      { operation: "select", result: [{ messageCount: 0 }] },
      { operation: "update", result: [] },
    ]);

    await appendCanonicalTranscriptRowsToExistingSessionInTx(
      asTx(script),
      {
        sessionId: "session-1",
        rows: [{
          ...row,
          protectedStructuralProjection: {
            notificationEligibility: "excluded",
            subthreadReplyClassification: "excluded",
          },
        }],
      },
    );

    expect(script.selectedFieldKeys.flat()).not.toContain("content");
    expect(script.selectedFieldKeys.flat()).not.toContain("metadata");
    script.assertExhausted();
  });

  test.each(["tool result", null])("protected existing-Session append preserves representation %s with a reserved ID", async (content) => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "insert", result: [{ id: 917 }] },
      {
        operation: "select",
        result: [{
          roomId: "room-1",
          sessionOwnerId: "user-1",
          roomKind: "private",
        }],
      },
      { operation: "select", result: [{ messageCount: 0 }] },
      { operation: "update", result: [] },
    ]);

    script.policyMode = content === null ? "encrypted_only" : "shadow_encryption";
    const result = await appendCanonicalTranscriptRowsToExistingSessionInTx(
      asTx(script),
      {
        sessionId: "session-1",
        ...(content === null ? { publicationPolicy: {
          expectedRevision: 1, representation: "protected_only" as const,
        } } : {}),
        rows: [{
          ...row,
          content,
          toolName: content === null ? null : row.toolName,
          protectedStructuralProjection: {
            notificationEligibility: "excluded",
            subthreadReplyClassification: "excluded",
            reservedMessageId: 917,
            reservedCreatedAt: new Date("2026-08-20T12:00:00.000Z"),
          },
        }],
      },
    );

    expect(result.insertedRows[0]?.id).toBe("917");
    expect(script.events).toEqual([
      "select",
      "execute",
      "select",
      "insert",
      "select",
      "select",
      "update",
    ]);
    expect(script.insertedValues[0]).toMatchObject({
      id: 917,
      content,
      toolName: content === null ? null : row.toolName,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
    });
    expect(script.policyEvents).toEqual(["shared-policy-lock", "policy-read"]);
    script.assertExhausted();
  });

  test("Session-creating append cannot consume a protected reserved ID", async () => {
    const script = new ScriptedTransaction([]);
    let failure: unknown;
    try {
      await appendCanonicalTranscriptRowsInTx(asTx(script), {
        session,
        rows: [{
          ...row,
          protectedStructuralProjection: {
            notificationEligibility: "excluded",
            subthreadReplyClassification: "excluded",
            reservedMessageId: 917,
            reservedCreatedAt: new Date("2026-08-20T12:00:00.000Z"),
          },
        }],
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toMatch(/require an existing Session/i);
    script.assertExhausted();
  });

  test("a protected hook failure aborts before the message INSERT", async () => {
    const script = new ScriptedTransaction([
      { operation: "execute", result: [] },
      { operation: "select", result: [{ id: "session-1" }] },
      { operation: "select", result: [] },
      { operation: "execute", result: [{ id: 42 }] },
    ]);

    try {
      await appendCanonicalTranscriptRowsInTx(
        asTx(script),
        { session, rows: [row] },
        {
          afterMessageIdAllocated: async () => {
            script.events.push("hook");
            throw new Error("lifecycle refused");
          },
        },
      );
      throw new Error("expected lifecycle refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("lifecycle refused");
    }
    expect(script.events).toEqual([
      "execute",
      "select",
      "select",
      "execute",
      "hook",
    ]);
    script.assertExhausted();
  });
});

describe("canonical hard-delete transaction seam", () => {
  test("runs the receipt hook only after canonical effects are complete", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] }, // canonical Room write lock
      {
        operation: "select",
        result: [{
          roomId: "room-1",
          sessionId: "session-1",
          editRevision: 2,
          readAt: null,
          fingerprint: null,
          role: "assistant",
          content: "answer",
          metadata: null,
          subthreadRoomId: null,
        }],
      },
      { operation: "select", result: [] }, // anchor refusal
      { operation: "delete", result: [] },
      { operation: "update", result: [] },
    ]);

    const result = await deleteMessageHardInTx(
      asTx(script),
      77,
      {
        afterDeleteEffects: async (context) => {
          script.events.push(`hook:${context.editRevision}`);
          return "terminal-receipt";
        },
      },
    );

    expect(script.events).toEqual([
      "select",
      "execute",
      "select",
      "for:update",
      "select",
      "delete",
      "update",
      "hook:2",
    ]);
    expect(result).toMatchObject({
      roomId: "room-1",
      wasUnread: true,
      orphanedTurnId: null,
      rootSummary: null,
      hookResult: "terminal-receipt",
    });
    script.assertExhausted();
  });

  test("anchor refusal happens before any delete lifecycle hook", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          roomId: "room-1",
          sessionId: "session-1",
          editRevision: 0,
          readAt: null,
          fingerprint: null,
          role: "user",
          content: "root",
          metadata: null,
          subthreadRoomId: null,
        }],
      },
      { operation: "select", result: [{ id: "subthread-1" }] },
    ]);
    let hooked = false;

    try {
      await deleteMessageHardInTx(asTx(script), 78, {
        afterDeleteEffects: async () => {
          hooked = true;
        },
      });
      throw new Error("expected anchor refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MessageDeleteError);
      expect((error as MessageDeleteError).reason).toBe(
        "message_anchors_thread",
      );
    }
    expect(hooked).toBe(false);
    expect(script.events).toEqual([
      "select",
      "execute",
      "select",
      "for:update",
      "select",
    ]);
    script.assertExhausted();
  });

  test("protected delete predicate never selects plaintext or metadata", async () => {
    const script = new ScriptedTransaction([
      { operation: "select", result: [{ roomId: "room-1" }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          roomId: "room-1",
          sessionId: "session-1",
          editRevision: 0,
          readAt: null,
          fingerprint: null,
          role: "assistant",
          subthreadRoomId: null,
        }],
      },
      { operation: "select", result: [] },
      { operation: "delete", result: [] },
      { operation: "update", result: [] },
    ]);

    await deleteMessageHardInTx(asTx(script), 79, {
      protectedStructuralProjection: {
        subthreadReplyClassification: "excluded",
      },
    });

    expect(script.selectedFieldKeys.flat()).not.toContain("content");
    expect(script.selectedFieldKeys.flat()).not.toContain("metadata");
    script.assertExhausted();
  });
});
