import { describe, expect, test } from "bun:test";
import {
  PostgresDeviceFanoutAdmissionRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";
import {
  createVerifiedDeviceFanoutAdmissionFixture,
} from "./device-fanout-admission-fixture.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedCryptoConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];
  transactionCount = 0;
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (
      statement.includes(
        "SELECT d.device_id, d.state, d.delivery_sequence_high_watermark",
      )
    ) {
      return Promise.resolve(
        (parameters[0] as string[]).map((deviceId) => ({
          device_id: deviceId,
          state: "active",
          delivery_sequence_high_watermark: 0,
          delivery_acknowledged_sequence: 0,
          delivery_blocked_sequence: null,
          delivery_blocked_operation_id: null,
          delivery_blocked_at: null,
          delivery_blocked_reason: null,
          first_unresolved_expires_at_ms: null,
        })) as Row[],
      );
    }
    if (
      statement.includes(
        "SET delivery_sequence_high_watermark = $2",
      )
    ) {
      return Promise.resolve([{ device_id: parameters[0] }] as Row[]);
    }
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    return callback(this);
  }
}

const { admission } = await createVerifiedDeviceFanoutAdmissionFixture();
const domain = admission.plan.domains[0]!;
const namespace = domain.namespaces[0]!;

async function repositoryWithResults(results: unknown[][]) {
  const connection = new ScriptedCryptoConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeviceFanoutAdmissionRepository(handle),
  };
}

function currentState(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: admission.plan.operationId,
    operation_kind: "device_add",
    operation_state: "awaiting_committer",
    operation_human_id: admission.plan.humanId,
    operation_target_device_id: admission.plan.targetDeviceId,
    operation_custody_revision: 4,
    operation_recovery_generation: 2,
    operation_device_revision: 0,
    operation_inventory_digest: admission.plan.inventoryDigest,
    operation_fanout_row_count: 0,
    operation_aggregate_payload_bytes: 0,
    device_state: "pending",
    device_revision: 0,
    device_human_id: admission.plan.humanId,
    custody_state: "active",
    custody_revision: 4,
    custody_recovery_generation: 2,
    custody_inventory_revision: 8,
    custody_inventory_count: 1,
    custody_inventory_digest: admission.plan.inventoryDigest,
    challenge_kind: "device_approval",
    challenge_expires_at_ms: 21_000,
    challenge_consumed_at: null,
    challenge_invalidated_at: null,
    source_state: "active",
    source_human_id: admission.plan.humanId,
    admitted_operation_id: null,
    ...overrides,
  };
}

describe("Postgres device fanout admission repository", () => {
  test("rejects an unverified database handle", () => {
    const forged = new ScriptedCryptoConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() => new PostgresDeviceFanoutAdmissionRepository(forged))
      .toThrow("verified nautilo_crypto handle");
  });

  test("rejects a structural admission look-alike before opening a transaction", async () => {
    const setup = await repositoryWithResults([]);
    expect(() => setup.repository.admit(structuredClone(admission)))
      .toThrow("not cryptographically verified");
    expect(setup.connection.transactionCount).toBe(0);
  });

  test("rejects mutation after admission verification before opening a transaction", async () => {
    const setup = await repositoryWithResults([]);
    const { admission: mutable } =
      await createVerifiedDeviceFanoutAdmissionFixture();
    mutable.messages[0]!.payloadBytes[0] =
      mutable.messages[0]!.payloadBytes[0]! ^ 1;
    expect(() => setup.repository.admit(mutable))
      .toThrow("not cryptographically verified");
    expect(setup.connection.transactionCount).toBe(0);
  });

  test("persists the exact activation gate, transition plan, opaque rows, and outbox atomically", async () => {
    const setup = await repositoryWithResults([
      [],
      [],
      [currentState()],
      [{
        domain_id: "domain_ab",
        epoch: 3,
        authorization_revision: 5,
        participant_digest: domain.expectedParticipantDigest,
        writes_paused: false,
      }],
      [{
        device_id: admission.sourceDeviceId,
        human_id: admission.plan.humanId,
        state: "active",
      }],
      [{
        namespace_id: "namespace_room",
        domain_id: "domain_ab",
        domain_epoch: 3,
        access_revision: 7,
        binding_hash: namespace.expectedBindingHash,
        writes_paused: false,
      }],
      [{ operation_id: admission.plan.operationId }],
      [{ operation_id: admission.plan.operationId }],
      [{ namespace_id: "namespace_room" }],
      [{ message_id: admission.messages[0]!.messageId }],
      [{ operation_id: admission.plan.operationId }],
      [{ outbox_id: admission.outbox.outboxId }],
    ]);

    expect(await setup.repository.admit(admission)).toEqual({
      status: "admitted",
    });
    expect(setup.connection.transactionCount).toBe(1);
    const sql = setup.connection.queries
      .slice(1)
      .map((query) => query.statement)
      .join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("INSERT INTO crypto_device_epoch_operations");
    expect(sql).toContain("INSERT INTO crypto_domain_transition_steps");
    expect(sql).toContain("INSERT INTO crypto_domain_transition_namespaces");
    expect(sql).toContain("INSERT INTO crypto_delivery_messages");
    expect(sql).toContain("INSERT INTO crypto_operation_outbox");
    expect(sql).not.toContain("state = 'active'");
    expect(sql).toContain(
      "SET delivery_sequence_high_watermark = $2",
    );
    const messageInsert = setup.connection.queries.find((query) =>
      query.statement.trim().startsWith(
        "INSERT INTO crypto_delivery_messages",
      )
    );
    expect(messageInsert?.parameters[2]).toBe(1);
    expect(messageInsert?.parameters[3]).toBe(
      admission.messages[0]!.recipientDeviceId,
    );
    expect(sql).not.toContain("SET state = 'active'");
  });

  test("admits a current Domain while the retained Namespace inventory is canonically empty", async () => {
    const { admission: emptyAdmission } =
      await createVerifiedDeviceFanoutAdmissionFixture({
        emptyNamespaceInventory: true,
      });
    const emptyDomain = emptyAdmission.plan.domains[0]!;
    const setup = await repositoryWithResults([
      [],
      [],
      [currentState({
        operation_id: emptyAdmission.plan.operationId,
        operation_human_id: emptyAdmission.plan.humanId,
        operation_target_device_id: emptyAdmission.plan.targetDeviceId,
        operation_inventory_digest: emptyAdmission.plan.inventoryDigest,
        device_human_id: emptyAdmission.plan.humanId,
        custody_inventory_revision: null,
        custody_inventory_count: null,
        custody_inventory_digest: null,
        source_human_id: emptyAdmission.plan.humanId,
      })],
      [{
        domain_id: emptyDomain.domainId,
        epoch: emptyDomain.expectedEpoch,
        authorization_revision: emptyDomain.expectedAuthorizationRevision,
        participant_digest: emptyDomain.expectedParticipantDigest,
        writes_paused: false,
      }],
      [{
        device_id: emptyAdmission.sourceDeviceId,
        human_id: emptyAdmission.plan.humanId,
        state: "active",
      }],
      [],
      [{ operation_id: emptyAdmission.plan.operationId }],
      [{ operation_id: emptyAdmission.plan.operationId }],
      [{ message_id: emptyAdmission.messages[0]!.messageId }],
      [{ operation_id: emptyAdmission.plan.operationId }],
      [{ outbox_id: emptyAdmission.outbox.outboxId }],
    ]);

    expect(await setup.repository.admit(emptyAdmission)).toEqual({
      status: "admitted",
    });
  });

  test("rejects a stale Domain before the first mutation", async () => {
    const setup = await repositoryWithResults([
      [],
      [],
      [currentState()],
      [{
        domain_id: "domain_ab",
        epoch: 4,
        authorization_revision: 5,
        participant_digest: domain.expectedParticipantDigest,
        writes_paused: false,
      }],
    ]);

    expect(await setup.repository.admit(admission)).toEqual({
      status: "stale_state",
    });
    expect(
      setup.connection.queries.some((query) =>
        query.statement.includes("INSERT INTO")
      ),
    ).toBe(false);
  });
});
