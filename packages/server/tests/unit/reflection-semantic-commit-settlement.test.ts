import { describe, expect, test } from "bun:test";
import type { BackgroundReflectionSemanticWorkDescriptorV2 } from
  "@nautilo/lattice-crypto/background";
import {
  verifyRecordProductPostgresHandle,
  type ClaimedProtectedRecordPublication,
} from "@nautilo/reflection-bridge/server";

import {
  completeAttachedReflectionSemanticPublication,
  readReflectionSemanticSettlement,
} from "../../src/reflection/protected-authority-composition";

const SOURCE_RECORD = "source:record";
const GENERATED_RECORD = "generated:record";
const OUTPUT_OBJECT = "semantic:output";
const CLAIM_GENERATION = 7;

function descriptor(input: Readonly<{
  workKind?: "reflection.organization" | "reflection.dependency_rewrite" | "reflection.search_projection";
  output?: boolean;
}> = {}): BackgroundReflectionSemanticWorkDescriptorV2 {
  const workKind = input.workKind ?? "reflection.organization";
  const common = {
    formatVersion: 2,
    requestId: "request:semantic",
    workId: "work:semantic",
    recipientGeneration: 1,
    anchorNamespaceId: "namespace:one",
    anchorDomainId: "domain:one",
    subject: {
      kind: "processor",
      processorKind: "reflection",
      processorVersion: 1,
    },
    namespaceRequirements: [],
    operations: input.output === false
      ? ["decrypt" as const]
      : ["decrypt" as const, "encrypt" as const],
    policyRevision: 1,
    source: {
      kind: "reflection_semantic",
      recordRef: SOURCE_RECORD,
      claimGeneration: CLAIM_GENERATION,
      fingerprint: new Uint8Array(32).fill(1),
    },
    inputBindings: [],
    outputSlots: input.output === false ? [] : [{
      objectId: OUTPUT_OBJECT,
      objectType: "nautilo.reflection.record.v1" as const,
      createdAt: 1_700_000_000_000,
      namespaceIds: ["namespace:one"],
    }],
    maximumPlaintextBytes: 1_048_576,
    maximumCiphertextBytes: 1_048_576,
    recipientKeyId: "key:one",
    recipientPublicKey: new Uint8Array(65).fill(2),
    issuedAt: 1_700_000_000_000,
    notBefore: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    idempotencyId: "request:semantic",
  } as const;
  if (workKind === "reflection.search_projection") {
    return { ...common, workKind, purpose: "record.search_projection" };
  }
  if (workKind === "reflection.dependency_rewrite") {
    return { ...common, workKind, purpose: "record.dependency_rewrite" };
  }
  return { ...common, workKind, purpose: "record.organize" };
}

function settlementExecutor(input: Readonly<{
  generation: number;
  completedGeneration: number;
  stage: "authority_projection" | "search_projection" | "organization";
  matchingCompleteReceipts?: number;
}>) {
  return {
    query<Row>(statement: string): Promise<readonly Row[]> {
      if (statement.includes('from "reflection_record_semantic_work"')) {
        return Promise.resolve([{
          generation: input.generation,
          completed_generation: input.completedGeneration,
          stage: input.stage,
        }] as Row[]);
      }
      if (statement.includes('from "reflection_record_publications"')) {
        return Promise.resolve(Array.from(
          { length: input.matchingCompleteReceipts ?? 0 },
          (_, index) => ({ publication_id: `publication:${index}` }),
        ) as Row[]);
      }
      throw new Error(`Unexpected settlement query: ${statement}`);
    },
  };
}

describe("Reflection semantic committed-request settlement", () => {
  test("output settlement requires both source acknowledgement and one complete receipt for the exact object", async () => {
    const committed = descriptor();
    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION,
      completedGeneration: CLAIM_GENERATION,
      stage: "organization",
      matchingCompleteReceipts: 1,
    }), committed, 1)).toBe("completed");

    for (const matchingCompleteReceipts of [0, 2]) {
      expect(await readReflectionSemanticSettlement(settlementExecutor({
        generation: CLAIM_GENERATION,
        completedGeneration: CLAIM_GENERATION,
        stage: "organization",
        matchingCompleteReceipts,
      }), committed, 1)).toBe("pending");
    }
    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION,
      completedGeneration: CLAIM_GENERATION - 1,
      stage: "organization",
      matchingCompleteReceipts: 1,
    }), committed, 1)).toBe("pending");
  });

  test("a zero-output marker settles from completion even when the request declared an output slot", async () => {
    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION,
      completedGeneration: CLAIM_GENERATION,
      stage: "organization",
    }), descriptor(), 0)).toBe("completed");
  });

  test("no-output work settles from completion or a durable search checkpoint", async () => {
    const noOutput = descriptor({ output: false });
    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION,
      completedGeneration: CLAIM_GENERATION,
      stage: "organization",
    }), noOutput, 0)).toBe("completed");

    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION,
      completedGeneration: CLAIM_GENERATION - 1,
      stage: "organization",
    }), descriptor({ workKind: "reflection.search_projection", output: false }), 0))
      .toBe("completed");

    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION,
      completedGeneration: CLAIM_GENERATION - 1,
      stage: "organization",
    }), noOutput, 0)).toBe("pending");
  });

  test("a newer incomplete generation supersedes an old no-output request", async () => {
    expect(await readReflectionSemanticSettlement(settlementExecutor({
      generation: CLAIM_GENERATION + 1,
      completedGeneration: CLAIM_GENERATION - 1,
      stage: "search_projection",
    }), descriptor({ output: false }), 0)).toBe("superseded");
  });

  test("malformed output counts remain pending without consulting product state", async () => {
    const unused = {
      query: () => Promise.reject(new Error("malformed markers must fail closed before querying")),
    };
    expect(await readReflectionSemanticSettlement(unused, descriptor(), -1)).toBe("pending");
    expect(await readReflectionSemanticSettlement(
      unused,
      descriptor({ output: false }),
      1,
    )).toBe("pending");
    expect(await readReflectionSemanticSettlement(unused, descriptor(), 2)).toBe("pending");
  });
});

const publication: ClaimedProtectedRecordPublication = {
  idempotencyKey: "publication:semantic",
  recordId: GENERATED_RECORD,
  state: "product_attached",
  leaseToken: "lease:publication",
  cryptoObjectId: OUTPUT_OBJECT,
};

interface ProductState {
  receiptState: "product_attached" | "complete";
  receiptLeaseToken: string | null;
  workGeneration: number;
  completedGeneration: number;
  workState: "pending" | "complete";
  claimGeneration: number | null;
  leaseToken: string | null;
  nextAttemptAt: string | null;
}

class TransactionalProductConnection {
  readonly events: string[] = [];
  failAfterReceiptOnce = false;
  transactionDepth = 0;

  constructor(
    readonly state: ProductState,
    private readonly completionGeneration: number,
  ) {}

  query<Row>(statement: string): Promise<readonly Row[]> {
    this.events.push(statement);
    if (statement.includes("current_user AS current_role")) {
      return Promise.resolve([{
        current_role: "nautilo",
        session_role: "nautilo",
      }] as Row[]);
    }
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo",
        session_user: "nautilo",
      }] as Row[]);
    }
    if (statement.startsWith("SELECT state, record_id, lease_token")) {
      return Promise.resolve([{
        state: this.state.receiptState,
        record_id: GENERATED_RECORD,
        lease_token: this.state.receiptLeaseToken,
      }] as Row[]);
    }
    if (statement.startsWith('update "reflection_record_publications"')) {
      if (this.transactionDepth !== 1) throw new Error("receipt update escaped the product transaction");
      this.state.receiptState = "complete";
      this.state.receiptLeaseToken = null;
      return Promise.resolve([]);
    }
    if (statement.includes('from "reflection_record_semantic_work"')) {
      if (this.failAfterReceiptOnce && this.state.receiptState === "complete") {
        this.failAfterReceiptOnce = false;
        throw new Error("injected semantic acknowledgement failure");
      }
      return Promise.resolve([{
        generation: this.state.workGeneration,
        completed_generation: this.state.completedGeneration,
      }] as Row[]);
    }
    if (statement.startsWith('update "reflection_record_semantic_work"')) {
      if (this.transactionDepth !== 1) throw new Error("source acknowledgement escaped the product transaction");
      this.state.completedGeneration = this.completionGeneration;
      if (this.state.workGeneration === this.completionGeneration) {
        this.state.workState = "complete";
        this.state.claimGeneration = null;
        this.state.leaseToken = null;
        this.state.nextAttemptAt = null;
      }
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected product query: ${statement}`);
  }

  async transaction<Result>(use: (transaction: this) => Promise<Result>): Promise<Result> {
    const before = { ...this.state };
    this.transactionDepth += 1;
    try {
      const result = await use(this);
      this.events.push("commit");
      return result;
    } catch (error) {
      Object.assign(this.state, before);
      this.events.push("rollback");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function productState(workGeneration = CLAIM_GENERATION): ProductState {
  return {
    receiptState: "product_attached",
    receiptLeaseToken: publication.leaseToken,
    workGeneration,
    completedGeneration: CLAIM_GENERATION - 1,
    workState: "pending",
    claimGeneration: workGeneration,
    leaseToken: "lease:semantic",
    nextAttemptAt: "2026-09-12T00:00:00.000Z",
  };
}

async function completeFixture(connection: TransactionalProductConnection) {
  return completeAttachedReflectionSemanticPublication({
    product: await verifyRecordProductPostgresHandle(connection),
    item: publication,
    sourceRecordRef: SOURCE_RECORD,
    claimGeneration: CLAIM_GENERATION,
    commitmentKey: new Uint8Array(32).fill(4),
  });
}

describe("product-attached semantic recovery", () => {
  test("commits the receipt and exact source acknowledgement together", async () => {
    const state = productState();
    const connection = new TransactionalProductConnection(state, CLAIM_GENERATION);
    expect(await completeFixture(connection)).toBe(true);
    expect(state).toMatchObject({
      receiptState: "complete",
      receiptLeaseToken: null,
      completedGeneration: CLAIM_GENERATION,
      workState: "complete",
      claimGeneration: null,
      leaseToken: null,
      nextAttemptAt: null,
    });
    expect(connection.events.at(-1)).toBe("commit");
    expect(connection.events.filter((event) => event === "commit")).toHaveLength(1);
  });

  test("failure after receipt update rolls back both changes and a retry converges", async () => {
    const state = productState();
    const connection = new TransactionalProductConnection(state, CLAIM_GENERATION);
    connection.failAfterReceiptOnce = true;

    expect(await completeFixture(connection).then(
      () => null,
      (error: unknown) => error,
    )).toBeInstanceOf(Error);
    expect(state).toMatchObject({
      receiptState: "product_attached",
      receiptLeaseToken: publication.leaseToken,
      completedGeneration: CLAIM_GENERATION - 1,
      workState: "pending",
    });
    expect(connection.events.at(-1)).toBe("rollback");

    expect(await completeFixture(connection)).toBe(true);
    expect(state).toMatchObject({
      receiptState: "complete",
      completedGeneration: CLAIM_GENERATION,
      workState: "complete",
    });
    expect(connection.events.at(-1)).toBe("commit");
  });

  test("acknowledging an older attached generation preserves newer scheduling", async () => {
    const state = productState(CLAIM_GENERATION + 1);
    const connection = new TransactionalProductConnection(state, CLAIM_GENERATION);
    expect(await completeFixture(connection)).toBe(true);
    expect(state).toMatchObject({
      receiptState: "complete",
      completedGeneration: CLAIM_GENERATION,
      workGeneration: CLAIM_GENERATION + 1,
      workState: "pending",
      claimGeneration: CLAIM_GENERATION + 1,
      leaseToken: "lease:semantic",
      nextAttemptAt: "2026-09-12T00:00:00.000Z",
    });
  });
});
