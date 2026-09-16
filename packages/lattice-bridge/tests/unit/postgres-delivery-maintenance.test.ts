import { describe, expect, test } from "bun:test";
import {
  PostgresDeliveryMaintenanceRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
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

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeliveryMaintenanceRepository(handle),
  };
}

describe("Postgres delivery maintenance", () => {
  test("durably blocks the exact first unresolved delivery at its expiry cutoff", async () => {
    const setup = await repository([
      [],
      [{
        recipient_device_id: "device_alice",
        recipient_sequence: 3,
        operation_id: "operation_old",
      }],
      [],
      [{ lock_acquired: true }],
      [{
        device_id: "device_alice",
        device_state: "active",
        delivery_acknowledged_sequence: 2,
        delivery_sequence_high_watermark: 4,
        delivery_blocked_sequence: null,
        message_id: "message_3",
        message_operation_id: "operation_old",
        message_recipient_sequence: 3,
        operation_id: "operation_old",
      }],
      [{ device_id: "device_alice" }],
    ]);

    expect(await setup.repository.blockExpiredDeliveries({
      now: 90_000,
    })).toEqual({ scanned: 1, blocked: 1 });

    const sql = setup.connection.statements.join("\n");
    const normalizedSql = sql.replaceAll('"', "").replaceAll(/\s+/g, " ");
    expect(normalizedSql).toContain(
      "crypto_delivery_messages.expires_at <= $3::timestamptz",
    );
    expect(normalizedSql).toContain(
      "crypto_delivery_messages.recipient_sequence",
    );
    expect(normalizedSql).toContain(
      "human_crypto_devices.delivery_acknowledged_sequence + 1",
    );
    expect(sql).toContain("pg_try_advisory_xact_lock");
    expect(sql).toContain("FOR UPDATE OF d, o");
    expect(sql).not.toContain("FOR UPDATE OF d, m, o");
    expect(normalizedSql).toContain("delivery_blocked_reason = $4");
    expect(sql).not.toContain("SET delivery_acknowledged_sequence =");
    expect(sql).not.toContain("revision = revision + 1");
  });

  test("skips a candidate when acknowledgement owns the device lock", async () => {
    const setup = await repository([
      [],
      [{
        recipient_device_id: "device_alice",
        recipient_sequence: 3,
        operation_id: "operation_old",
      }],
      [],
      [{ lock_acquired: false }],
    ]);

    expect(await setup.repository.blockExpiredDeliveries({
      now: 90_000,
    })).toEqual({ scanned: 1, blocked: 0 });
    expect(setup.connection.statements.join("\n")).not.toContain(
      "SET delivery_blocked_sequence",
    );
  });

  test("rechecks the exact queue head and treats an acknowledgement race as no-op", async () => {
    const setup = await repository([
      [],
      [{
        recipient_device_id: "device_alice",
        recipient_sequence: 3,
        operation_id: "operation_old",
      }],
      [],
      [{ lock_acquired: true }],
      [],
    ]);

    expect(await setup.repository.blockExpiredDeliveries({
      now: 90_000,
    })).toEqual({ scanned: 1, blocked: 0 });
  });

  test("terminalizes successors inserted after an outbox predecessor became poison", async () => {
    const setup = await repository([
      [],
      [{ outbox_id: "outbox_late_successor" }],
    ]);
    expect(await setup.repository.terminalizeBlockedOutboxTails({
      now: 90_000,
    })).toBe(1);
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("poison.sequence < current.sequence");
    expect(sql).toContain("poison.terminal_at IS NOT NULL");
    expect(sql).toContain("failure_code = 'prior_event_failed'");
    expect(sql).toContain("FOR UPDATE OF current SKIP LOCKED");
    expect(sql).toContain("LIMIT 256");
  });

  test("prunes bounded operational state child-first while retaining bootstrap anchors", async () => {
    const setup = await repository([
      [],
      [{ challenge_id: "challenge_old" }],
      [{ package_id: "package_old" }],
      [{ message_id: "message_old" }],
      [{ message_id: "message_old" }],
      [{ message_id: "message_old" }],
      [{ outbox_id: "outbox_old" }],
      [{ namespace_id: "namespace_old" }],
      [{ domain_id: "domain_old" }],
      [{ operation_id: "operation_device_old" }],
      [{ operation_id: "operation_membership_old" }],
      [{ operation_id: "operation_old" }],
    ]);
    expect(await setup.repository.pruneRetainedState({
      now: 100 * 24 * 60 * 60 * 1_000,
    })).toEqual({
      challenges: 1,
      keyPackages: 1,
      acknowledgements: 1,
      messages: 1,
      outbox: 1,
      namespaceSteps: 1,
      domainSteps: 1,
      deviceOperations: 1,
      membershipTransitions: 1,
      operations: 1,
    });
    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("kind <> 'initial_bootstrap'");
    expect(sql).toContain("o.kind <> 'first_device_bootstrap'");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).not.toContain("FOR UPDATE OF m");
    expect(sql).toContain("LIMIT 256");
    expect(sql.indexOf("DELETE FROM crypto_domain_transition_namespaces"))
      .toBeLessThan(sql.indexOf("DELETE FROM crypto_domain_transition_steps"));
    expect(sql.indexOf("DELETE FROM crypto_domain_transition_steps"))
      .toBeLessThan(sql.indexOf("DELETE FROM crypto_delivery_operations"));
  });
});
