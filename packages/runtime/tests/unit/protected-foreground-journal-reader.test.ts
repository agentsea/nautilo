import { describe, expect, test } from "bun:test";
import type {
  ProtectedJournalAgentContentOpener,
  ProtectedJournalOpenedRecord,
  ProtectedJournalProductReadBatch,
} from "@nautilo/lattice-bridge";

import {
  createProtectedForegroundJournalReader,
} from "../../src/stenographer/protected-journal-reader";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000002";
const EVENT_ID = "10000000-0000-4000-8000-000000000003";
const ROLLUP_ID = "10000000-0000-4000-8000-000000000004";
const BATCH_ID = "10000000-0000-4000-8000-000000000005";

function batch(): ProtectedJournalProductReadBatch {
  return Object.freeze({
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    domainId: "domain-journal-reader",
    rebuildGeneration: 4,
    expectedAccessRevision: 5,
    expectedPolicyRevision: 9,
    rollup: Object.freeze({
      kind: "rollup",
      cryptoObjectId: "journal:rollup:8",
      rebuildGeneration: 4,
      binding: Object.freeze({
        rollupId: ROLLUP_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        throughEventSequence: 8,
        sourceEventCount: 8,
        modelId: "journal-compactor",
        compactorVersion: "v1",
        createdAt: "2027-01-15T08:00:00.000Z",
      }),
    }),
    events: Object.freeze([
      Object.freeze({
        kind: "event",
        cryptoObjectId: "journal:event:9",
        rebuildGeneration: 4,
        status: "active",
        binding: Object.freeze({
          eventId: EVENT_ID,
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          sequence: 9,
          kind: "fact",
          supersedesEventId: null,
          resolvesEventId: null,
          sourceMessageIds: [41],
          sourceBatchId: BATCH_ID,
          batchLocalOrdinal: 0,
          extractorVersion: "v1",
          createdAt: "2027-01-15T08:01:00.000Z",
        }),
      }),
    ]),
  });
}

function opened(): readonly ProtectedJournalOpenedRecord[] {
  return Object.freeze([
    Object.freeze({
      kind: "rollup",
      cryptoObjectId: "journal:rollup:8",
      payload: Object.freeze({
        ...batch().rollup!.binding,
        content: "Earlier durable context.",
      }),
    }),
    Object.freeze({
      kind: "event",
      cryptoObjectId: "journal:event:9",
      payload: Object.freeze({
        ...batch().events[0]!.binding,
        statement: "A newer protected fact.",
      }),
    }),
  ]);
}

function opener(
  implementation?: ProtectedJournalAgentContentOpener["openBatch"],
): ProtectedJournalAgentContentOpener {
  return {
    openBatch: implementation ?? (async (input) => ({
      status: "executed",
      value: await input.execute(opened()),
    })),
  };
}

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    maximumEvents: 16,
    maximumContextBytes: 4_096,
    productReadAuthorization: Object.freeze({}) as never,
    authorization: Object.freeze({
      sessionId: "foreground-session",
      viewId: "foreground-view",
    }) as never,
    entrypointId: "foreground.main" as const,
    execute: (journal: unknown) => journal,
    ...overrides,
  };
}

describe("dormant protected foreground journal reader", () => {
  test("preserves latest-rollup plus active-tail ordering inside one session-bound callback", async () => {
    const source = batch();
    let openedInput: unknown;
    const reader = createProtectedForegroundJournalReader({
      productReads: {
        readCurrent: async () => source,
      },
      contentOpener: opener(async (input) => {
        openedInput = input;
        return {
          status: "executed",
          value: await input.execute(opened()),
        };
      }),
    });

    const result = await reader.withCurrentJournal(request());

    expect(result).toEqual({
      status: "executed",
      value: {
        rollup: {
          throughEventSequence: 8,
          content: "Earlier durable context.",
          sourceEventCount: 8,
        },
        events: [{
          id: EVENT_ID,
          roomId: ROOM_ID,
          sequence: 9,
          kind: "fact",
          statement: "A newer protected fact.",
          status: "active",
          supersedesEventId: null,
          resolvesEventId: null,
        }],
      },
    });
    expect(openedInput).toMatchObject({
      authorizationSession: request().authorization,
      entrypointId: "foreground.main",
      namespaceId: NAMESPACE_ID,
      domainId: "domain-journal-reader",
      rebuildGeneration: 4,
      expectedAccessRevision: 5,
      expectedPolicyRevision: 9,
    });
  });

  test.each([
    ["wrong Room", { roomId: "10000000-0000-4000-8000-000000000099" }],
    ["wrong Namespace", {
      namespaceId: "10000000-0000-4000-8000-000000000099",
    }],
    ["wrong generation", { rebuildGeneration: 5 }],
    ["reordered tail", {
      events: [
        { ...batch().events[0], binding: { ...batch().events[0]!.binding, sequence: 10 } },
        { ...batch().events[0], cryptoObjectId: "journal:event:8" },
      ],
    }],
    ["plaintext field", { statement: "product plaintext must not pass" }],
    ["unsigned status substitution", { status: "resolved" }],
    ["nested plaintext field", {
      binding: {
        ...batch().events[0]!.binding,
        statement: "nested product plaintext must not pass",
      },
    }],
  ])("rejects %s product projection before opening content", async (
    _label,
    mutation,
  ) => {
    let openerCalls = 0;
    const original = batch();
    const mutated = "statement" in mutation || "binding" in mutation
      ? { ...original, events: [{ ...original.events[0], ...mutation }] }
      : { ...original, ...mutation };
    const result = await createProtectedForegroundJournalReader({
      productReads: { readCurrent: async () => mutated as never },
      contentOpener: opener(async () => {
        openerCalls += 1;
        throw new Error("must not open");
      }),
    }).withCurrentJournal(request());

    expect(result).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
    expect(openerCalls).toBe(0);
  });

  test("fails closed on missing mapping, stale session, opened substitution, and budget overflow", async () => {
    const missing = await createProtectedForegroundJournalReader({
      productReads: { readCurrent: async () => null },
      contentOpener: opener(),
    }).withCurrentJournal(request());
    expect(missing).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });

    const stale = await createProtectedForegroundJournalReader({
      productReads: { readCurrent: async () => batch() },
      contentOpener: opener(async () => ({
        status: "unavailable",
        reason: "authorization_unavailable",
      })),
    }).withCurrentJournal(request());
    expect(stale).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });

    const substituted = await createProtectedForegroundJournalReader({
      productReads: { readCurrent: async () => batch() },
      contentOpener: opener(async (input) => ({
        status: "executed",
        value: await input.execute([
          { ...opened()[0]!, cryptoObjectId: "journal:rollup:other" },
          opened()[1]!,
        ]),
      })),
    }).withCurrentJournal(request());
    expect(substituted).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });

    const overBudget = await createProtectedForegroundJournalReader({
      productReads: { readCurrent: async () => batch() },
      contentOpener: opener(),
    }).withCurrentJournal(request({ maximumContextBytes: 8 }));
    expect(overBudget).toEqual({
      status: "unavailable",
      reason: "content_invalid",
    });
  });

  test("does not disguise a foreground consumer failure as corrupt content", async () => {
    const failure = new Error("model context assembly failed");
    const result = createProtectedForegroundJournalReader({
      productReads: { readCurrent: async () => batch() },
      contentOpener: opener(),
    }).withCurrentJournal(request({
      execute: () => {
        throw failure;
      },
    }));

    expect(await result.catch((cause: unknown) => cause)).toBe(failure);
  });
});
