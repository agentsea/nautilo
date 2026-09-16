import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  _resetAuthoredMemorySemanticChangeSinkForTests,
  installAuthoredMemorySemanticChangeSink,
} from "@nautilo/agent";
import type {
  ProtectedAgentMemoryRepository,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import type {
  AgentMemoryPublicationBoundary,
  ConversationProductCanonicalTransactionRunner,
  HumanMemoryPublicationBoundary,
} from "@nautilo/lattice-bridge/server";
import {
  type DeliverForegroundMemoryEffectReceipt,
  deliverCommittedForegroundMemoryEffect,
  deliverCommittedHumanMemoryEffect,
  withForegroundMemoryEffectReceipts,
} from
  "../../src/routes/foreground-memory-effect-receipts";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000003";
const MEMORY_ID = "10000000-0000-4000-8000-000000000004";
const OPERATION_ID = "foreground-memory-effect:1";

const authority: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace",
  subjectUserId: USER_ID,
  agentId: AGENT_ID,
  readableNamespaceIds: [NAMESPACE_ID],
  mutableNamespaceIds: [NAMESPACE_ID],
  writableNamespaceId: NAMESPACE_ID,
});

type ReceiptRow = Readonly<{
  operationId: string;
  memoryId: string;
  changeKind: "replace" | null;
  completion: "complete" | "pending" | "ordinary_fallback";
  acknowledgedAt: Date | null;
}>;

class ScriptedTransaction {
  readonly selectedFields: string[][] = [];
  readonly updatedFields: string[][] = [];
  readonly whereColumns: string[][] = [];
  private readonly selects: (readonly unknown[])[];
  private readonly updates: (readonly unknown[])[];

  constructor(
    selects: readonly (readonly unknown[])[],
    updates: readonly (readonly unknown[])[],
  ) {
    this.selects = [...selects];
    this.updates = [...updates];
  }

  select(fields: Record<string, unknown>) {
    this.selectedFields.push(Object.keys(fields));
    const rows = this.selects.shift() ?? [];
    const chain = {
      from: () => chain,
      where: (predicate: unknown) => {
        this.whereColumns.push(predicateColumnNames(predicate));
        return chain;
      },
      limit: () => Promise.resolve(rows),
    };
    return chain;
  }

  update() {
    const rows = this.updates.shift() ?? [];
    const chain = {
      set: (fields: Record<string, unknown>) => {
        this.updatedFields.push(Object.keys(fields));
        return chain;
      },
      where: (predicate: unknown) => {
        this.whereColumns.push(predicateColumnNames(predicate));
        return chain;
      },
      returning: () => Promise.resolve(rows),
    };
    return chain;
  }
}

function predicateColumnNames(value: unknown): string[] {
  const names = new Set<string>();
  const seen = new Set<object>();
  const visit = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null || seen.has(entry)) return;
    seen.add(entry);
    if (
      "name" in entry
      && typeof entry.name === "string"
      && "table" in entry
    ) names.add(entry.name);
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return [...names].sort();
}

function harness(input: Readonly<{
  transactions: ScriptedTransaction[];
  failTransaction?: number;
  role?: "nautilo" | "nautilo_agent";
}>) {
  const events: string[] = [];
  let count = 0;
  const runner = Object.freeze({
    role: input.role ?? "nautilo_agent",
    transaction: async (callback: (...args: never[]) => Promise<unknown>) => {
      count += 1;
      const tx = input.transactions.shift();
      if (tx === undefined) throw new Error("Unexpected transaction");
      events.push(`tx:${count}:start`);
      const result = await callback(tx as never, {} as never);
      if (input.failTransaction === count) throw new Error("transaction failed");
      events.push(`tx:${count}:commit`);
      return result;
    },
  }) as unknown as ConversationProductCanonicalTransactionRunner;
  const beforeLocks = mock(async ({ mutation }: { mutation: boolean }) => {
    expect(mutation).toBe(false);
    events.push("guard");
  }) as unknown as AgentMemoryPublicationBoundary["beforeLocks"];
  return { runner, beforeLocks, events };
}

function receipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    operationId: OPERATION_ID,
    memoryId: MEMORY_ID,
    changeKind: "replace",
    completion: "complete",
    acknowledgedAt: null,
    ...overrides,
  };
}

afterEach(() => _resetAuthoredMemorySemanticChangeSinkForTests());

describe("foreground Memory effect receipts", () => {
  test("Human delivery uses the same receipt with its own role and current authority", async () => {
    const read = new ScriptedTransaction([[receipt()]], []);
    const acknowledge = new ScriptedTransaction([], [[{ operationId: OPERATION_ID }]]);
    const { runner, events } = harness({ role: "nautilo", transactions: [read, acknowledge] });
    const human = { userId: USER_ID, mutableNamespaceIds: [NAMESPACE_ID], writableNamespaceIds: [NAMESPACE_ID] };
    const fence: HumanMemoryPublicationBoundary["fence"] = async (request) => {
      expect(request.authority).toBe(human);
      expect(request.mutation).toBe(true);
      events.push("human-guard");
    };
    installAuthoredMemorySemanticChangeSink(async () => { events.push("deliver"); });
    expect(await deliverCommittedHumanMemoryEffect({ canonicalRunner: runner,
      publication: { fence }, authority: human, operationId: OPERATION_ID, memoryId: MEMORY_ID,
    })).toBe("acknowledged");
    expect(events).toEqual(["tx:1:start", "human-guard", "tx:1:commit", "deliver",
      "tx:2:start", "human-guard", "tx:2:commit"]);
    expect(read.whereColumns[0]).toContain("anchor_namespace_id");
  });

  test("Human effect delivery refuses an Agent runner and leaves denied effects pending", async () => {
    const human = { userId: USER_ID, mutableNamespaceIds: [NAMESPACE_ID], writableNamespaceIds: [NAMESPACE_ID] };
    const fence: HumanMemoryPublicationBoundary["fence"] = async () => { throw new Error("revoked"); };
    const wrong = harness({ transactions: [] });
    expect(await deliverCommittedHumanMemoryEffect({ canonicalRunner: wrong.runner,
      publication: { fence }, authority: human, operationId: OPERATION_ID, memoryId: MEMORY_ID,
    }).catch((error: unknown) => error)).toMatchObject({ message: "Human Memory effects require a nautilo canonical runner" });
    const read = new ScriptedTransaction([[receipt()]], []);
    const valid = harness({ role: "nautilo", transactions: [read] });
    expect(await deliverCommittedHumanMemoryEffect({ canonicalRunner: valid.runner,
      publication: { fence }, authority: human, operationId: OPERATION_ID, memoryId: MEMORY_ID,
    })).toBe("pending");
    expect(read.selectedFields).toEqual([]);
  });

  test("reads the exact receipt, commits before delivery, then acknowledges", async () => {
    const read = new ScriptedTransaction([[receipt()]], []);
    const acknowledge = new ScriptedTransaction([], [[{ operationId: OPERATION_ID }]]);
    const { runner, beforeLocks, events } = harness({
      transactions: [read, acknowledge],
    });
    installAuthoredMemorySemanticChangeSink(async () => {
      events.push("deliver");
    });
    expect(await deliverCommittedForegroundMemoryEffect({
      canonicalRunner: runner,
      beforeLocks,
      authority,
      operationId: OPERATION_ID,
      memoryId: MEMORY_ID,
    })).toBe("acknowledged");
    expect(events).toEqual([
      "tx:1:start", "guard", "tx:1:commit", "deliver",
      "tx:2:start", "guard", "tx:2:commit",
    ]);
    expect(read.selectedFields[0]).toEqual([
      "operationId", "memoryId", "changeKind", "completion", "acknowledgedAt",
    ]);
    expect(acknowledge.updatedFields).toEqual([["semanticChangeAcknowledgedAt"]]);
    for (const column of ["operation_id", "memory_id", "anchor_namespace_id"]) {
      expect(read.whereColumns[0]).toContain(column);
    }
    for (const column of [
      "operation_id", "memory_id", "anchor_namespace_id", "completion",
      "semantic_change_kind", "semantic_change_acknowledged_at",
    ]) expect(acknowledge.whereColumns[0]).toContain(column);
  });

  test("does not report missing, incomplete, or effect-free receipts as delivered", async () => {
    for (const [rows, expected] of [
      [[], "pending"],
      [[receipt({ completion: "pending" })], "pending"],
      [[receipt({ changeKind: null })], "not_required"],
    ] as const) {
      _resetAuthoredMemorySemanticChangeSinkForTests();
      const sink = mock(async () => {});
      installAuthoredMemorySemanticChangeSink(sink);
      const { runner, beforeLocks } = harness({
        transactions: [new ScriptedTransaction([rows], [])],
      });
      expect(await deliverCommittedForegroundMemoryEffect({
        canonicalRunner: runner, beforeLocks, authority,
        operationId: OPERATION_ID, memoryId: MEMORY_ID,
      })).toBe(expected);
      expect(sink).not.toHaveBeenCalled();
    }
  });

  test("keeps a committed receipt pending after sink or acknowledgement failure", async () => {
    installAuthoredMemorySemanticChangeSink(async () => {
      throw new Error("sink failed");
    });
    let harnessValue = harness({
      transactions: [new ScriptedTransaction([[receipt()]], [])],
    });
    expect(await deliverCommittedForegroundMemoryEffect({
      canonicalRunner: harnessValue.runner,
      beforeLocks: harnessValue.beforeLocks,
      authority, operationId: OPERATION_ID, memoryId: MEMORY_ID,
    })).toBe("pending");

    _resetAuthoredMemorySemanticChangeSinkForTests();
    installAuthoredMemorySemanticChangeSink(async () => {});
    harnessValue = harness({
      transactions: [
        new ScriptedTransaction([[receipt()]], []),
        new ScriptedTransaction([], []),
      ],
      failTransaction: 2,
    });
    expect(await deliverCommittedForegroundMemoryEffect({
      canonicalRunner: harnessValue.runner,
      beforeLocks: harnessValue.beforeLocks,
      authority, operationId: OPERATION_ID, memoryId: MEMORY_ID,
    })).toBe("pending");
  });

  test("keeps the effect pending when guarded receipt lookup fails", async () => {
    const sink = mock(async () => {});
    installAuthoredMemorySemanticChangeSink(sink);
    const { runner, beforeLocks } = harness({
      transactions: [new ScriptedTransaction([[receipt()]], [])],
      failTransaction: 1,
    });
    expect(await deliverCommittedForegroundMemoryEffect({
      canonicalRunner: runner, beforeLocks, authority,
      operationId: OPERATION_ID, memoryId: MEMORY_ID,
    })).toBe("pending");
    expect(sink).not.toHaveBeenCalled();
  });

  test("does not redeliver an already acknowledged exact receipt", async () => {
    const sink = mock(async () => {});
    installAuthoredMemorySemanticChangeSink(sink);
    const { runner, beforeLocks } = harness({ transactions: [
      new ScriptedTransaction([[receipt({ completion: "ordinary_fallback",
        acknowledgedAt: new Date() })]], []),
    ] });
    expect(await deliverCommittedForegroundMemoryEffect({
      canonicalRunner: runner, beforeLocks, authority,
      operationId: OPERATION_ID, memoryId: MEMORY_ID,
    })).toBe("acknowledged");
    expect(sink).not.toHaveBeenCalled();
  });
});

function repository(overrides: Partial<ProtectedAgentMemoryRepository> = {}) {
  return {
    search: mock(async () => ({ status: "success" as const, value: [] })),
    save: mock(async () => ({
      status: "success" as const,
      value: { id: MEMORY_ID, action: "created" as const },
    })),
    replace: mock(async () => ({ status: "success" as const, value: undefined })),
    setTier: mock(async () => ({ status: "success" as const, value: undefined })),
    ...overrides,
  } satisfies ProtectedAgentMemoryRepository;
}

describe("foreground Memory effect repository wrapper", () => {
  test("delegates search untouched and delivers exact successful mutation receipts", async () => {
    const inner = repository();
    const delivered: Parameters<DeliverForegroundMemoryEffectReceipt>[0][] = [];
    const deliver: DeliverForegroundMemoryEffectReceipt = mock(async (
      value: Parameters<DeliverForegroundMemoryEffectReceipt>[0],
    ) => {
      delivered.push(value);
      return "acknowledged" as const;
    });
    const wrapped = withForegroundMemoryEffectReceipts({
      repository: inner,
      deliver,
      wakeRecovery: () => undefined,
    });
    const search = await wrapped.search({
      authority, query: "remember", limit: 3, includeArchive: false, mode: "vector",
    });
    expect(search).toEqual({ status: "success", value: [] });
    expect(deliver).not.toHaveBeenCalled();
    expect(await wrapped.save({
      authority, operationId: "save:1", type: "fact", content: "value",
    })).toEqual({ status: "success", value: { id: MEMORY_ID, action: "created" } });
    expect(await wrapped.replace({
      authority, operationId: "replace:1", memoryId: MEMORY_ID, content: "next",
    })).toEqual({ status: "success", value: undefined });
    expect(await wrapped.setTier({
      authority, operationId: "tier:1", memoryId: MEMORY_ID, action: "demote",
    })).toEqual({ status: "success", value: undefined });
    expect(delivered).toEqual([
      { authority, operationId: "save:1", memoryId: MEMORY_ID },
      { authority, operationId: "replace:1", memoryId: MEMORY_ID },
      { authority, operationId: "tier:1", memoryId: MEMORY_ID },
    ]);
  });

  test("never delivers failed or thrown mutations", async () => {
    const unavailable = { status: "unavailable" as const, reason: "stale_revision" as const };
    const inner = repository({
      save: mock(async () => unavailable),
      replace: mock(async () => { throw new Error("mutation failed"); }),
    });
    const deliver = mock(async () => "acknowledged" as const);
    const wakeRecovery = mock(() => undefined);
    const wrapped = withForegroundMemoryEffectReceipts({
      repository: inner, deliver, wakeRecovery,
    });
    expect(await wrapped.save({
      authority, operationId: "save:failed", type: "fact", content: "value",
    })).toBe(unavailable);
    try {
      await wrapped.replace({
        authority, operationId: "replace:failed", memoryId: MEMORY_ID, content: "next",
      });
      throw new Error("Expected replacement to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("mutation failed");
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(wakeRecovery).not.toHaveBeenCalled();
  });

  test("preserves success and marks follow-up pending when delivery cannot finish", async () => {
    const inner = repository();
    for (const deliver of [
      mock(async () => "pending" as const),
      mock(async () => { throw new Error("delivery failed"); }),
    ]) {
      const wakeRecovery = mock(() => undefined);
      const wrapped = withForegroundMemoryEffectReceipts({
        repository: inner, deliver, wakeRecovery,
      });
      expect(await wrapped.setTier({
        authority, operationId: "tier:pending", memoryId: MEMORY_ID, action: "promote",
      })).toEqual({ status: "success", value: undefined, followUpPending: true });
      expect(wakeRecovery).toHaveBeenCalledTimes(1);
    }
    expect(inner.setTier).toHaveBeenCalledTimes(2);
  });
});
