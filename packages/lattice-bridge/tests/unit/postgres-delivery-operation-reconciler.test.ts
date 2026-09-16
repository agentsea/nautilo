import { describe, expect, test } from "bun:test";
import { DELIVERY_LEASE_TTL_MS } from "../../src/index.ts";
import {
  PostgresDeliveryOperationReconciler,
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

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeliveryOperationReconciler(handle),
  };
}

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim()
    .toLowerCase();
}

const claim = {
  operationId: "operation_device_add",
  kind: "device_add" as const,
  workerId: "reconciler_a",
  leaseExpiresAt: 50_000,
};

describe("Postgres delivery operation reconciler", () => {
  test("claims poison work through the durable operation lease", async () => {
    const setup = await repository([
      [],
      [{
        operation_id: "operation_device_add",
        kind: "device_add",
        lease_owner: null,
        lease_expires_at_ms: null,
      }],
      [{ operation_id: "operation_device_add" }],
    ]);
    expect(await setup.repository.claim({
      workerId: "reconciler_a",
      now: 20_000,
    })).toEqual({
      ...claim,
      leaseExpiresAt: 20_000 + DELIVERY_LEASE_TTL_MS,
    });
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("FOR UPDATE OF o SKIP LOCKED");
    expect(sql).toContain("failed_step.state = 'failed'");
    expect(sql).toContain("blocked_device.delivery_blocked_operation_id");
    expect(sql).toContain("expired_challenge.expires_at");
  });

  test("heartbeats only the exact unexpired operation lease", async () => {
    const setup = await repository([
      [{ operation_id: "operation_device_add" }],
    ]);
    expect(await setup.repository.heartbeat({
      claim,
      now: 30_000,
    })).toEqual({
      ...claim,
      leaseExpiresAt: 30_000 + DELIVERY_LEASE_TTL_MS,
    });
    expect(normalizedSql(setup.connection.statements.join("\n"))).toContain(
      "lease_expires_at >",
    );
  });

  test("claims Human membership work when committer availability changes", async () => {
    const setup = await repository([
      [],
      [{
        operation_id: "operation_human_remove",
        kind: "human_remove",
        lease_owner: null,
        lease_expires_at_ms: null,
      }],
      [{ operation_id: "operation_human_remove" }],
    ]);
    expect(await setup.repository.claim({
      workerId: "reconciler_a",
      now: 20_000,
    })).toEqual({
      operationId: "operation_human_remove",
      kind: "human_remove",
      workerId: "reconciler_a",
      leaseExpiresAt: 20_000 + DELIVERY_LEASE_TTL_MS,
    });
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("no_live_committer");
    expect(sql).toContain("crypto_human_membership_transitions membership");
    expect(sql).toContain("crypto_domain_devices source_mapping");
    expect(sql).toContain("crypto_domain_devices target_mapping");
  });

  test("keeps a Human removal visibly blocked and paused without a live committer", async () => {
    const membershipClaim = {
      ...claim,
      operationId: "operation_human_remove",
      kind: "human_remove" as const,
    };
    const setup = await repository([
      [],
      [{
        operation_id: "operation_human_remove",
        kind: "human_remove",
        state: "preparing_domain",
        target_device_id: null,
        idempotency_key: "membership/remove-1",
        failure_code: null,
        membership_target_domain_id: null,
        membership_live_committer: false,
        deadline_expired: true,
        failed_step_count: 0,
        blocked_device_count: 0,
        expired_challenge_count: 0,
      }],
      [{ operation_id: "operation_human_remove" }],
    ]);
    expect(await setup.repository.reconcile({
      claim: membershipClaim,
      now: 30_000,
    })).toEqual({ status: "blocked_no_committer" });
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("state = 'awaiting_committer'");
    expect(sql).toContain("failure_code = 'no_live_committer'");
    expect(sql).not.toContain("SET released_at");
    expect(sql).not.toContain("SET writes_paused = false");
  });

  test("deterministically resumes blocked Human membership when a committer returns", async () => {
    const membershipClaim = {
      ...claim,
      operationId: "operation_human_remove",
      kind: "human_remove" as const,
    };
    const setup = await repository([
      [],
      [{
        operation_id: "operation_human_remove",
        kind: "human_remove",
        state: "awaiting_committer",
        target_device_id: null,
        idempotency_key: "membership/remove-1",
        failure_code: "no_live_committer",
        membership_target_domain_id: null,
        membership_live_committer: true,
        deadline_expired: true,
        failed_step_count: 0,
        blocked_device_count: 0,
        expired_challenge_count: 0,
      }],
      [{ operation_id: "operation_human_remove" }],
    ]);
    expect(await setup.repository.reconcile({
      claim: membershipClaim,
      now: 30_000,
    })).toEqual({ status: "preparing_domain" });
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("SET state = $2");
    expect(sql).toContain("failure_code = NULL");
    expect(sql).toContain("deadline_at = $3::timestamptz");
    expect(sql).not.toContain("SET released_at");
  });

  test("atomically rejects add/recovery work and records a terminal outbox fact", async () => {
    const setup = await repository([
      [],
      [{
        operation_id: "operation_device_add",
        kind: "device_add",
        state: "awaiting_committer",
        target_device_id: "device_alice_pending",
        idempotency_key: "device-add/request-1",
        deadline_expired: false,
        failed_step_count: 1,
        blocked_device_count: 0,
        expired_challenge_count: 0,
      }],
      [],
      [],
      [{ device_id: "device_alice_pending" }],
      [{ challenge_id: "challenge_add_1" }],
      [{ operation_id: "operation_device_add" }],
      [{ outbox_id: "outbox_failed" }],
    ]);
    expect(await setup.repository.reconcile({
      claim,
      now: 30_000,
    })).toEqual({ status: "failed" });
    const sql = setup.connection.statements.join("\n").replaceAll('"', "")
      .toUpperCase();
    expect(sql).toContain("UPDATE CRYPTO_DOMAIN_TRANSITION_STEPS SET");
    expect(sql).toContain("UPDATE HUMAN_CRYPTO_DEVICES SET STATE =");
    expect(sql).toContain("TERMINAL_AT");
    expect(sql).toContain("INSERT INTO CRYPTO_OPERATION_OUTBOX");
    expect(sql).toContain("EVENT_TYPE");
    expect(sql).toContain("'PRIOR_EVENT_FAILED'");
  });

  test("turns failed revocation Domains into explicit rebootstrap work", async () => {
    const revocationClaim = {
      ...claim,
      operationId: "operation_device_revoke",
      kind: "device_revoke" as const,
    };
    const setup = await repository([
      [],
      [{
        operation_id: "operation_device_revoke",
        kind: "device_revoke",
        state: "awaiting_committer",
        target_device_id: "device_alice_revoked",
        idempotency_key: "device-revoke/request-1",
        deadline_expired: false,
        failed_step_count: 1,
        blocked_device_count: 0,
        expired_challenge_count: 0,
      }],
      [{ domain_id: "domain_ab" }],
      [{ namespace_id: "namespace_room_1" }],
      [{ remaining_count: 0, committer_count: 0 }],
      [{ operation_id: "operation_device_revoke" }],
    ]);
    expect(await setup.repository.reconcile({
      claim: revocationClaim,
      now: 30_000,
    })).toEqual({ status: "ready_to_activate" });
    const sql = setup.connection.statements.join("\n").replaceAll('"', "")
      .toUpperCase();
    expect(sql).toContain("UPDATE CRYPTO_DOMAIN_TRANSITION_STEPS SET");
    expect(sql).toContain("FAILED_STEP.STATE = 'FAILED'");
    expect(sql).not.toContain("UPDATE HUMAN_CRYPTO_DEVICES SET");
  });

  test("releases failed Human membership ownership without undoing removal pause", async () => {
    const membershipClaim = {
      ...claim,
      operationId: "operation_human_remove",
      kind: "human_remove" as const,
    };
    const setup = await repository([
      [],
      [{
        operation_id: "operation_human_remove",
        kind: "human_remove",
        state: "awaiting_committer",
        target_device_id: null,
        idempotency_key: "membership/remove-1",
        failure_code: null,
        membership_target_domain_id: "domain_remaining_humans",
        membership_live_committer: true,
        deadline_expired: true,
        failed_step_count: 0,
        blocked_device_count: 0,
        expired_challenge_count: 0,
      }],
      [{ operation_id: "operation_human_remove" }],
      [{ operation_id: "operation_human_remove" }],
      [{ outbox_id: "outbox_failed" }],
    ]);
    expect(await setup.repository.reconcile({
      claim: membershipClaim,
      now: 30_000,
    })).toEqual({ status: "failed" });
    const sql = setup.connection.statements.join("\n").replaceAll('"', "")
      .toUpperCase();
    expect(sql).toContain("UPDATE CRYPTO_HUMAN_MEMBERSHIP_TRANSITIONS");
    expect(sql).toContain("SET RELEASED_AT =");
    expect(sql).not.toContain("SET WRITES_PAUSED = FALSE");
  });
});
