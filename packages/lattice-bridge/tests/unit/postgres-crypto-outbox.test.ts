import { describe, expect, test } from "bun:test";
import {
  deliveryRetryAtMs,
} from "../../src/index.ts";
import {
  PostgresCryptoOutboxRepository,
  verifyCryptoPostgresHandle,
  type ClaimedCryptoOutboxEvent,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: readonly unknown[][] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    (this.parameters as unknown[][]).push([...parameters]);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim()
    .toLowerCase();
}

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    outbox_id: "outbox_device_ready",
    operation_id: "operation_device_add",
    sequence: 2,
    event_type: "crypto_device_ready",
    payload_bytes: new Uint8Array([1, 2, 3]),
    idempotency_key: "crypto-device-ready/token",
    claimed_by: null,
    claim_expires_at_ms: null,
    attempts: 0,
    maximum_attempts: 8,
    ...overrides,
  };
}

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresCryptoOutboxRepository(handle),
  };
}

function claim(
  overrides: Partial<ClaimedCryptoOutboxEvent> = {},
): ClaimedCryptoOutboxEvent {
  return {
    outboxId: "outbox_device_ready",
    operationId: "operation_device_add",
    sequence: 2,
    eventType: "crypto_device_ready",
    payloadBytes: new Uint8Array([1, 2, 3]),
    idempotencyKey: "crypto-device-ready/token",
    workerId: "worker_alpha",
    attempts: 0,
    maximumAttempts: 8,
    leaseExpiresAt: 40_000,
    ...overrides,
  };
}

describe("Postgres crypto outbox worker", () => {
  test("rejects a database handle that did not pass the crypto-role probe", () => {
    const forged = new ScriptedConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() => new PostgresCryptoOutboxRepository(forged))
      .toThrow("verified nautilo_crypto handle");
  });

  test("claims only the first ordered event with an expiring lease and stable idempotency key", async () => {
    const setup = await repository([
      [],
      [outboxRow()],
      [{ outbox_id: "outbox_device_ready" }],
    ]);
    expect(await setup.repository.claim({
      workerId: "worker_alpha",
      now: 10_000,
    })).toEqual(claim());
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("FOR UPDATE OF outbox SKIP LOCKED");
    expect(sql).toContain("prior.sequence < outbox.sequence");
    expect(sql).toContain("prior.delivered_at IS NULL");
    expect(normalizedSql(sql)).toContain("attempts =");
  });

  test("does not consume a retry merely because a worker crashed after claim", async () => {
    const setup = await repository([
      [],
      [outboxRow({
        claimed_by: "worker_crashed",
        claim_expires_at_ms: 9_000,
        attempts: 7,
      })],
      [{ outbox_id: "outbox_device_ready" }],
    ]);
    expect(await setup.repository.claim({
      workerId: "worker_rescue",
      now: 10_000,
    })).toEqual(claim({
      workerId: "worker_rescue",
      attempts: 7,
    }));
    const claimUpdate = setup.connection.statements.find((statement) =>
      normalizedSql(statement).includes("set claimed_by =")
    );
    expect(normalizedSql(claimUpdate ?? "")).not.toContain("set attempts");
    expect(normalizedSql(claimUpdate ?? "")).not.toContain(", attempts");
  });

  test("renews and completes only the exact live claim", async () => {
    const setup = await repository([
      [{ outbox_id: "outbox_device_ready" }],
      [{ outbox_id: "outbox_device_ready" }],
    ]);
    const renewed = await setup.repository.heartbeat({
      claim: claim(),
      now: 20_000,
    });
    expect(renewed).toEqual(claim({ leaseExpiresAt: 50_000 }));
    expect(await setup.repository.delivered({
      claim: renewed!,
      now: 21_000,
    })).toBe("delivered");
    const sql = setup.connection.statements.join("\n");
    const normalized = normalizedSql(sql);
    expect(normalized).toContain("claim_expires_at >");
    expect(normalized).toContain("delivered_at =");
    expect(normalized).toContain("claimed_by =");
  });

  test("persists deterministic backoff in the lease without making work immediately claimable", async () => {
    const setup = await repository([
      [{ outbox_id: "outbox_device_ready" }],
    ]);
    const expectedRetryAt = deliveryRetryAtMs(
      "outbox_device_ready",
      1,
      20_000,
    );
    expect(await setup.repository.fail({
      claim: claim(),
      now: 20_000,
      failureCode: "event_bus_unavailable",
      transient: true,
    })).toEqual({
      status: "retry_scheduled",
      retryAt: expectedRetryAt,
      attempts: 1,
    });
    const updateIndex = setup.connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("set claim_expires_at =")
    );
    expect(setup.connection.parameters[updateIndex]).toContain(
      new Date(expectedRetryAt).toISOString(),
    );
  });

  test("terminalizes permanent and exhausted failures without erasing the poison row", async () => {
    const permanent = await repository([
      [{ outbox_id: "outbox_device_ready" }],
    ]);
    expect(await permanent.repository.fail({
      claim: claim(),
      now: 20_000,
      failureCode: "event_rejected",
      transient: false,
    })).toEqual({
      status: "terminal_failure",
      attempts: 1,
    });
    const exhausted = await repository([
      [{ outbox_id: "outbox_device_ready" }],
    ]);
    expect(await exhausted.repository.fail({
      claim: claim({ attempts: 7 }),
      now: 20_000,
      failureCode: "event_bus_unavailable",
      transient: true,
    })).toEqual({
      status: "terminal_failure",
      attempts: 8,
    });
    const exhaustedParameters = exhausted.connection.parameters.find(
      (_, index) =>
        normalizedSql(exhausted.connection.statements[index] ?? "").includes(
          "terminal_at =",
        ),
    );
    expect(exhaustedParameters).toContain("maximum_attempts_reached");
    const exhaustedSql = exhausted.connection.statements.join("\n");
    expect(normalizedSql(exhaustedSql)).toContain("sequence >");
    expect(exhausted.connection.parameters.flat()).toContain(
      "prior_event_failed",
    );
    expect(exhaustedSql).not.toContain("DELETE FROM crypto_operation_outbox");
  });

  test("reports lease loss instead of inventing delivery success", async () => {
    const setup = await repository([[]]);
    expect(await setup.repository.delivered({
      claim: claim(),
      now: 20_000,
    })).toBe("lost_lease");
  });
});
