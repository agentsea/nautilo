import { describe, expect, test } from "bun:test";
import {
  DELIVERY_LEASE_TTL_MS,
  deliveryRetryAtMs,
} from "../../src/index.ts";
import {
  PostgresDomainTransitionLeaseRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: unknown[][];
  constructor(results: unknown[][]) {
    this.#results = [...results];
  }
  query<Row>(
    statement: string,
    _parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
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

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDomainTransitionLeaseRepository(handle),
  };
}

describe("Postgres Domain transition worker leases", () => {
  test("claims eligible work with SKIP LOCKED and deterministic persisted backoff", async () => {
    const retryAt = deliveryRetryAtMs(
      "operation_1/domain_ab",
      1,
      50_000,
    );
    const setup = await repository([
      [],
      [{
        operation_id: "operation_1",
        domain_id: "domain_ab",
        state: "awaiting_committer",
        lease_owner: null,
        lease_expires_at_ms: null,
        retry_count: 1,
        failure_code: "provider_temporarily_unavailable",
        updated_at_ms: 50_000,
      }],
      [{ operation_id: "operation_1", domain_id: "domain_ab" }],
    ]);
    expect(await setup.repository.claim({
      workerId: "worker_a",
      now: retryAt,
    })).toEqual({
      operationId: "operation_1",
      domainId: "domain_ab",
      state: "awaiting_committer",
      workerId: "worker_a",
      retryCount: 1,
      leaseExpiresAt: retryAt + DELIVERY_LEASE_TTL_MS,
    });
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("FOR UPDATE OF s SKIP LOCKED");
    expect(sql).toContain("retry_count < 8");
    expect(sql).toContain("s.committer_device_id IS NOT NULL");
    expect(normalizedSql(sql)).toContain("lease_expires_at =");
    expect(sql).toContain(
      "s.state IN (\n                  'awaiting_committer', 'preparing'\n                )",
    );
    expect(sql).not.toContain("'awaiting_delivery', 'ready_to_activate'");
  });

  test("fails a claimed step with one CAS and clears its lease", async () => {
    const setup = await repository([
      [{ operation_id: "operation_1", domain_id: "domain_ab" }],
    ]);
    expect(await setup.repository.fail({
      claim: {
        operationId: "operation_1",
        domainId: "domain_ab",
        state: "awaiting_committer",
        workerId: "worker_a",
        retryCount: 0,
        leaseExpiresAt: 40_000,
      },
      now: 20_000,
      failureCode: "provider_temporarily_unavailable",
      transient: true,
    })).toEqual({
      status: "retry_scheduled",
      retryCount: 1,
    });
    const sql = setup.connection.statements.join("\n");
    const normalized = normalizedSql(sql);
    expect(normalized).toContain("lease_owner =");
    expect(normalized).toContain("retry_count =");
    expect(normalized).toContain("updated_at =");
  });

  test("returns the same live exact lease to the same HTTP worker", async () => {
    const setup = await repository([
      [],
      [{
        operation_id: "operation_1",
        domain_id: "domain_ab",
        state: "awaiting_committer",
        lease_owner: "worker_a",
        lease_expires_at_ms: 45_000,
        retry_count: 0,
        updated_at_ms: 10_000,
      }],
    ]);
    expect(await setup.repository.claimExact({
      operationId: "operation_1",
      domainId: "domain_ab",
      workerId: "worker_a",
      now: 20_000,
    })).toEqual({
      operationId: "operation_1",
      domainId: "domain_ab",
      state: "awaiting_committer",
      workerId: "worker_a",
      retryCount: 0,
      leaseExpiresAt: 45_000,
    });
    expect(setup.connection.statements.join("\n")).not.toContain(
      "UPDATE crypto_domain_transition_steps",
    );
  });

});
