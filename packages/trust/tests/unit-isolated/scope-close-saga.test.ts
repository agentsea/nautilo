import { describe, expect, test } from "bun:test";

import {
  PostgresProtectedScopeCloseSaga,
  type ScopeClosePostgresConnection,
  type ScopeCloseRow,
  type ScopeCloseScalar,
} from "../../src/scope-close-saga.ts";

const SCOPE = "11000000-0000-4000-8000-000000000001";
const AGENT = "22000000-0000-4000-8000-000000000001";
const HUMAN = "33000000-0000-4000-8000-000000000001";
const TARGET = "44000000-0000-4000-8000-000000000001";
const OPERATION = "scope-close:test-operation";
const CLAIM = "55000000-0000-4000-8000-000000000001";
const NOW = 10_000;

type Item = Record<string, unknown>;

function captured(index: number, origin: "seed" | "scope" = "scope"): Item {
  return {
    memory_id: `66000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    origin,
    crypto_object_id: `memory:v1:scope-${index}`,
    content_revision: 2,
    crypto_access_revision: 1,
    crypto_required_namespace_fingerprint: new Uint8Array(32).fill(index + 1),
    scope_origin_namespace_id: origin === "scope"
      ? "77000000-0000-4000-8000-000000000001" : null,
    pending_crypto_operation: false,
  };
}

class MemoryConnection implements ScopeClosePostgresConnection {
  scope: Record<string, unknown> | null = {
    id: SCOPE,
    parent_agent_id: AGENT,
    speaker_user_id: HUMAN,
    lifecycle_state: "open",
    revision: 0,
    close_operation_id: null,
  };
  inventory: Item[] = [captured(1)];
  operation: Record<string, unknown> | null = null;
  items: Item[] = [];
  remainingEdge = true;
  readonly statements: string[] = [];

  transaction<Result>(callback: (executor: this) => Promise<Result>): Promise<Result> {
    return callback(this);
  }

  query<Row extends ScopeCloseRow = ScopeCloseRow>(
    statement: string,
    parameters: readonly ScopeCloseScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    const normalized = statement.replaceAll('"', "").replace(/\s+/g, " ")
      .trim().toUpperCase();
    const has = (text: string): boolean =>
      normalized.includes(text.toUpperCase());
    if (statement.startsWith("SET TRANSACTION")
      || statement.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (statement.includes("protected-scope-close:mutation-admission")) {
      return Promise.resolve((this.scope === null ? [] : [this.scope]) as Row[]);
    }
    if (statement.includes("protected-scope-close:scope")) {
      return Promise.resolve((this.scope === null ? [] : [this.scope]) as Row[]);
    }
    if (statement.includes("protected-scope-close:operation")) {
      return Promise.resolve((this.operation === null ? [] : [this.operation]) as Row[]);
    }
    if (statement.includes("protected-scope-close:inventory")
      || has("FROM memory_scopes INNER JOIN memories")) {
      return Promise.resolve(this.inventory as Row[]);
    }
    if (statement.includes("protected-scope-close:replay-items")
      || (!statement.includes("protected-scope-close:")
        && has("SELECT ordinal, memory_id::text, origin, crypto_object_id"))) {
      return Promise.resolve(this.items as Row[]);
    }
    if (has("INSERT INTO agent_scope_close_operations")) {
      this.operation = {
        operation_id: parameters[0], scope_id: parameters[1],
        parent_agent_id: parameters[2], speaker_user_id: parameters[3],
        source_scope_revision: parameters[4], captured_item_count: parameters[5],
        inventory_digest: (parameters[6] as Uint8Array).slice(), state: "active",
        failure_code: null,
      };
      return Promise.resolve([]);
    }
    if (has("INSERT INTO agent_scope_close_items")) {
      this.items.push({
        operation_id: parameters[0], ordinal: parameters[1],
        memory_id: parameters[2], origin: parameters[3],
        crypto_object_id: parameters[4], expected_content_revision: parameters[5],
        expected_access_revision: parameters[6],
        expected_required_namespace_fingerprint:
          (parameters[7] as Uint8Array).slice(),
        source_origin_namespace_id: parameters[8], action: parameters[9],
        target_namespace_id: parameters[10], state: "pending", attempt_count: 0,
        claim_token: null, claim_owner: null, claim_expires_at: null,
        failure_code: null, product_receipt_ref: null, crypto_receipt_ref: null,
      });
      return Promise.resolve([]);
    }
    if (has("UPDATE agent_scopes")) {
      if (this.scope === null || this.scope["lifecycle_state"] !== "open") {
        return Promise.resolve([]);
      }
      this.scope["lifecycle_state"] = "closing";
      this.scope["revision"] = Number(this.scope["revision"]) + 1;
      this.scope["close_operation_id"] = parameters.find((value) =>
        typeof value === "string" && value.startsWith("scope-close:")
      );
      return Promise.resolve([{ id: SCOPE }] as unknown as Row[]);
    }
    if (statement.startsWith("SELECT operation_id FROM agent_scope_close_operations")) {
      return Promise.resolve(this.operation?.["state"] === "active"
        ? [{ operation_id: OPERATION }] as unknown as Row[] : []);
    }
    if (statement.includes("protected-scope-close:claim-candidate")) {
      const item = this.items.find((entry) =>
        Number(entry["attempt_count"]) < 8
        && (entry["state"] === "pending" || entry["state"] === "claimed")
      );
      return Promise.resolve((item === undefined ? [] : [item]) as Row[]);
    }
    if (statement.includes("protected-scope-close:exhausted-item")) {
      const item = this.items.find((entry) =>
        Number(entry["attempt_count"]) >= 8
        && (entry["state"] === "pending" || entry["state"] === "claimed")
      );
      const result: readonly ScopeCloseRow[] = item === undefined
        ? []
        : [{ ordinal: item["ordinal"] }];
      return Promise.resolve(result as readonly Row[]);
    }
    if (has("UPDATE agent_scope_close_items")
      && parameters.includes("claimed")) {
      const ordinal = parameters.find(
        (value): value is number => typeof value === "number",
      )!;
      const item = this.items[ordinal]!;
      item["state"] = "claimed";
      item["attempt_count"] = Number(item["attempt_count"]) + 1;
      item["claim_token"] = parameters.find((value) =>
        typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)
      );
      item["claim_owner"] = parameters.find((value) =>
        typeof value === "string" && value.startsWith("worker")
      );
      item["claim_expires_at"] = parameters.find((value) =>
        value instanceof Date
        || (typeof value === "string" && value.endsWith("Z"))
      );
      return Promise.resolve([{ attempt_count: item["attempt_count"] }] as unknown as Row[]);
    }
    if (statement.includes("protected-scope-close:claimed-item")) {
      const item = this.items[Number(parameters[1])];
      return Promise.resolve((item === undefined ? [] : [{
        ...item,
        operation_state: this.operation?.["state"],
      }]) as unknown as Row[]);
    }
    if (has("UPDATE agent_scope_close_items")) {
      const ordinal = parameters.find(
        (value): value is number => typeof value === "number",
      )!;
      const item = this.items[ordinal]!;
      if (parameters.includes("retry_exhausted")) {
        Object.assign(item, { state: "quarantined", claim_token: null,
          claim_owner: null, claim_expires_at: null,
          failure_code: "retry_exhausted" });
      } else if (parameters.includes("complete")) {
        const receiptRefs = parameters.filter((value): value is string =>
          typeof value === "string" && value.includes("receipt")
        );
        Object.assign(item, { state: "complete", claim_token: null,
          claim_owner: null, claim_expires_at: null,
          product_receipt_ref: receiptRefs[0], crypto_receipt_ref: receiptRefs[1] });
      } else if (parameters.includes("pending")) {
        Object.assign(item, { state: "pending", claim_token: null,
          claim_owner: null, claim_expires_at: null });
      } else {
        const state = parameters.find((value) =>
          value === "stale" || value === "quarantined"
        );
        const failure = parameters.find((value) =>
          typeof value === "string"
          && value !== OPERATION
          && value !== state
        );
        Object.assign(item, { state, claim_token: null,
          claim_owner: null, claim_expires_at: null, failure_code: failure });
      }
      return Promise.resolve([]);
    }
    if (statement.startsWith("SELECT ordinal, memory_id::text, state")
      || has("SELECT ordinal, memory_id::text, state, attempt_count, failure_code FROM agent_scope_close_items")) {
      return Promise.resolve(this.items as Row[]);
    }
    if (statement.startsWith("SELECT id::text, lifecycle_state")) {
      return Promise.resolve((this.scope === null ? [] : [this.scope]) as Row[]);
    }
    if (statement.startsWith("SELECT ordinal, memory_id::text, origin")) {
      return Promise.resolve(this.items as Row[]);
    }
    if (statement.includes("protected-scope-close:remaining-edge")) {
      return Promise.resolve(this.remainingEdge
        ? [{ memory_id: "other" }] as unknown as Row[] : []);
    }
    if (has("DELETE FROM agent_scopes")) {
      if (this.scope === null) return Promise.resolve([]);
      this.scope = null;
      return Promise.resolve([{ id: SCOPE }] as unknown as Row[]);
    }
    if (has("UPDATE agent_scope_close_operations")) {
      if (this.operation !== null) {
        const quarantined = parameters.includes("quarantined");
        this.operation["state"] = quarantined ? "quarantined" : "complete";
        this.operation["failure_code"] = quarantined
          ? parameters.find((value) =>
            typeof value === "string"
            && value !== "quarantined"
            && value !== OPERATION
          )
          : null;
      }
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

function saga(connection = new MemoryConnection()) {
  return { connection, saga: new PostgresProtectedScopeCloseSaga(connection) };
}

async function begin(setup: ReturnType<typeof saga>, operationId = OPERATION) {
  return setup.saga.begin({ operationId, scopeId: SCOPE,
    parentAgentId: AGENT, speakerUserId: HUMAN, expectedScopeRevision: 0,
    targetNamespaceId: TARGET });
}

describe("protected AgentScope close saga", () => {
  test("captures exact content-free inventory and freezes new protected mutations", async () => {
    const setup = saga();
    expect(await setup.saga.assertOpenForProtectedMutation({ scopeId: SCOPE,
      parentAgentId: AGENT, speakerUserId: HUMAN, expectedRevision: 0 }))
      .toEqual({ status: "open", scopeId: SCOPE, scopeRevision: 0 });
    expect(await begin(setup)).toMatchObject({ status: "started",
      capturedItemCount: 1, sourceScopeRevision: 0 });
    expect(setup.connection.operation).not.toHaveProperty("content");
    expect(setup.connection.items[0]).toMatchObject({
      origin: "scope", action: "promote_origin", target_namespace_id: TARGET,
    });
    expect(await setup.saga.assertOpenForProtectedMutation({ scopeId: SCOPE,
      parentAgentId: AGENT, speakerUserId: HUMAN }))
      .toEqual({ status: "closing" });
    expect(await begin(setup)).toMatchObject({ status: "replayed",
      capturedItemCount: 1 });
    expect(await begin(setup, "scope-close:other-operation"))
      .toEqual({ status: "closing_conflict" });
  });

  test("rejects an oversized inventory atomically before durable close rows", async () => {
    const setup = saga();
    setup.connection.inventory = Array.from({ length: 257 }, (_, index) =>
      captured(index, "seed")
    );
    expect(await begin(setup)).toEqual({ status: "too_many_items" });
    expect(setup.connection.operation).toBeNull();
    expect(setup.connection.items).toEqual([]);
    expect(setup.connection.scope).toMatchObject({ lifecycle_state: "open",
      revision: 0, close_operation_id: null });
  });

  test("does not start close while a captured Memory publication is pending", async () => {
    const setup = saga();
    setup.connection.inventory[0]!["pending_crypto_operation"] = true;
    expect(await begin(setup)).toEqual({
      status: "protected_mapping_unavailable",
    });
    expect(setup.connection.operation).toBeNull();
    expect(setup.connection.scope).toMatchObject({ lifecycle_state: "open" });
  });

  test("fails closed when durable replay inventory was substituted", async () => {
    const setup = saga();
    await begin(setup);
    setup.connection.items[0]!["crypto_object_id"] = "memory:v1:substituted";
    expect(await begin(setup)).toEqual({ status: "closing_conflict" });
  });

  test("rejects a globally colliding operation before capturing inventory", async () => {
    const setup = saga();
    setup.connection.operation = {
      operation_id: OPERATION,
      scope_id: "11000000-0000-4000-8000-000000000099",
      parent_agent_id: AGENT,
      speaker_user_id: HUMAN,
      source_scope_revision: 0,
      captured_item_count: 0,
      inventory_digest: new Uint8Array(32),
      state: "active",
      failure_code: null,
    };
    expect(await begin(setup)).toEqual({ status: "closing_conflict" });
    expect(setup.connection.scope).toMatchObject({ lifecycle_state: "open" });
    expect(setup.connection.statements.some((statement) =>
      statement.includes("protected-scope-close:inventory")
    )).toBeFalse();
  });

  test("requires promotion target and exact protected Memory mapping", async () => {
    const target = saga();
    expect(await target.saga.begin({ operationId: OPERATION, scopeId: SCOPE,
      parentAgentId: AGENT, speakerUserId: HUMAN, expectedScopeRevision: 0 }))
      .toEqual({ status: "target_required" });
    const mapping = saga();
    mapping.connection.inventory[0]!["crypto_object_id"] = null;
    expect(await begin(mapping)).toEqual({ status: "protected_mapping_unavailable" });
  });

  test("claims, retries, completes, and exactly replays a terminal claim", async () => {
    const setup = saga();
    await begin(setup);
    const first = await setup.saga.claim({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: CLAIM, claimOwner: "worker-a", now: NOW, leaseMs: 1_000 });
    expect(first).toMatchObject({ status: "claimed", attemptCount: 1,
      item: { memoryId: setup.connection.inventory[0]!["memory_id"] } });
    expect(await setup.saga.completeClaim({ operationId: OPERATION, ordinal: 0,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: CLAIM, claimOwner: "worker-a", now: NOW + 1,
      result: { status: "retry", nextAttemptAt: NOW + 2 } })).toBe("applied");
    const secondClaim = "55000000-0000-4000-8000-000000000002";
    expect(await setup.saga.claim({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: secondClaim, claimOwner: "worker-b", now: NOW + 2,
      leaseMs: 1_000 })).toMatchObject({ status: "claimed", attemptCount: 2 });
    const complete = { status: "complete" as const,
      productReceiptRef: "product-receipt", cryptoReceiptRef: "crypto-receipt" };
    expect(await setup.saga.completeClaim({ operationId: OPERATION, ordinal: 0,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: secondClaim, claimOwner: "worker-b", now: NOW + 3,
      result: complete })).toBe("applied");
    expect(await setup.saga.completeClaim({ operationId: OPERATION, ordinal: 0,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: secondClaim, claimOwner: "worker-b", now: NOW + 4,
      result: complete })).toBe("duplicate");
  });

  test("rejects an expired claim and quarantines exhausted retry work", async () => {
    const expired = saga();
    await begin(expired);
    await expired.saga.claim({ operationId: OPERATION, claimToken: CLAIM,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimOwner: "worker", now: NOW, leaseMs: 1 });
    expect(await expired.saga.completeClaim({ operationId: OPERATION, ordinal: 0,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: CLAIM, claimOwner: "worker", now: NOW + 1,
      result: { status: "complete", productReceiptRef: "product",
        cryptoReceiptRef: "crypto" } })).toBe("stale_claim");

    const exhausted = saga();
    await begin(exhausted);
    exhausted.connection.items[0]!["attempt_count"] = 8;
    expect(await exhausted.saga.claim({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: CLAIM, claimOwner: "worker", now: NOW, leaseMs: 10 }))
      .toEqual({ status: "empty" });
    expect(exhausted.connection.items[0]).toMatchObject({
      state: "quarantined", failure_code: "retry_exhausted",
    });
    expect(exhausted.connection.operation).toMatchObject({
      state: "quarantined", failure_code: "item_quarantined",
    });
  });

  test("makes stale terminal work visible and quarantines finalization", async () => {
    const setup = saga();
    await begin(setup);
    await setup.saga.claim({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN, claimToken: CLAIM,
      claimOwner: "worker", now: NOW, leaseMs: 100 });
    expect(await setup.saga.completeClaim({ operationId: OPERATION, ordinal: 0,
      parentAgentId: AGENT, speakerUserId: HUMAN, claimToken: CLAIM,
      claimOwner: "worker", now: NOW + 1,
      result: { status: "stale", failureCode: "memory_state_conflict" } }))
      .toBe("applied");
    expect(await setup.saga.finalize({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN, now: NOW + 2 }))
      .toBe("quarantined");
    expect(await setup.saga.observe({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN })).toMatchObject({
      state: "quarantined",
      items: [{ state: "stale", failureCode: "memory_state_conflict" }],
    });
  });

  test("closes an empty exact inventory without creating synthetic work", async () => {
    const setup = saga();
    setup.connection.inventory = [];
    setup.connection.remainingEdge = false;
    expect(await begin(setup)).toMatchObject({ status: "started",
      capturedItemCount: 0 });
    expect(setup.connection.items).toEqual([]);
    expect(await setup.saga.finalize({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN, now: NOW }))
      .toBe("complete");
  });

  test("finalizes only an exact terminal inventory and survives response-loss replay", async () => {
    const setup = saga();
    await begin(setup);
    const claim = await setup.saga.claim({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: CLAIM, claimOwner: "worker", now: NOW, leaseMs: 1_000 });
    if (claim.status !== "claimed") throw new Error("expected claim");
    await setup.saga.completeClaim({ operationId: OPERATION, ordinal: 0,
      parentAgentId: AGENT, speakerUserId: HUMAN,
      claimToken: CLAIM, claimOwner: "worker", now: NOW + 1,
      result: { status: "complete", productReceiptRef: "product-receipt",
        cryptoReceiptRef: "crypto-receipt" } });
    setup.connection.remainingEdge = false;
    expect(await setup.saga.finalize({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN, now: NOW + 2 }))
      .toBe("complete");
    expect(setup.connection.scope).toBeNull();
    expect(await setup.saga.finalize({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN, now: NOW + 3 }))
      .toBe("already_complete");
    expect(await setup.saga.observe({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN })).toMatchObject({
      state: "complete", capturedItemCount: 1,
      items: [{ state: "complete", attemptCount: 1 }],
    });
  });

  test("keeps scope closing when a terminal receipt left any product edge", async () => {
    const setup = saga();
    await begin(setup);
    setup.connection.items[0]!["state"] = "complete";
    expect(await setup.saga.finalize({ operationId: OPERATION,
      parentAgentId: AGENT, speakerUserId: HUMAN, now: NOW }))
      .toBe("quarantined");
    expect(setup.connection.scope).toMatchObject({ lifecycle_state: "closing" });
    expect(setup.connection.operation).toMatchObject({ state: "quarantined",
      failure_code: "inventory_conflict" });
  });
});
