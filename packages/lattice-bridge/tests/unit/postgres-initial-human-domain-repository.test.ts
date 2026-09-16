import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  participantDigest,
} from "@nautilo/lattice-crypto";

import {
  createHumanMembershipTargetDomainSubmission,
  humanMembershipTargetDomainSubmissionDigest,
} from "../../src/delivery/human-membership-target-domain.ts";
import {
  PostgresInitialHumanDomainRepository,
} from "../../src/server/device/postgres-initial-human-domain-repository.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

const USER = "10000000-0000-4000-8000-000000000274";
const HUMAN = "20000000-0000-4000-8000-000000000274";
const DEVICE = cryptoDeviceId("device_m274_initial_domain");
const DOMAIN = cryptoDomainId("domain_m274_initial_human");
const OPERATION = "operation_m274_initial_human_domain";
const COMMITTED_AT = 27_400;

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function singletonRoster(): Uint8Array {
  return concat([
    text("nautilo/lattice-crypto/openmls-roster/v2"),
    u32(1),
    u32(0),
    text(HUMAN),
    text(DEVICE),
  ]);
}

function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const digest = participantDigest([humanId(HUMAN)]);
  const rosterBytes = singletonRoster();
  const submission = createHumanMembershipTargetDomainSubmission({
    crypto,
    operationId: OPERATION,
    targetDomainId: DOMAIN,
    participants: [HUMAN],
    participantDigest: digest,
    committerDeviceId: DEVICE,
    committerHumanId: HUMAN,
    initialProviderHead: {
      providerId: "openmls-v2",
      domainId: DOMAIN,
      epoch: domainEpoch(0),
      stateHash: new Uint8Array(32).fill(0x27),
    },
    initialRosterBytes: rosterBytes,
    additions: [],
    signingPrivateKey: signing.privateKey,
  });
  return { crypto, signing, digest, rosterBytes, submission };
}

interface Scenario {
  replayRows?: readonly Record<string, unknown>[];
  inventoryRows?: readonly Record<string, unknown>[];
  existingDomainRows?: readonly Record<string, unknown>[];
  activeDomainRows?: readonly Record<string, unknown>[];
}

class InitialDomainConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];

  constructor(readonly scenario: Scenario) {}

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (statement.includes("SELECT current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as Row[]);
    }
    if (statement.includes("FROM crypto_delivery_operations o")) {
      return Promise.resolve((this.scenario.replayRows ?? []) as Row[]);
    }
    if (statement.includes("FROM human_crypto_custodies custody")) {
      const rows = this.scenario.inventoryRows ?? [];
      return Promise.resolve((statement.includes("device.state = 'active'")
        ? rows.filter((row) => row["device_state"] === "active")
        : rows) as Row[]);
    }
    if (statement.includes("FROM crypto_domains domain_row")
      && statement.includes("JOIN crypto_domain_devices mapping")) {
      return Promise.resolve((this.scenario.activeDomainRows ?? []) as Row[]);
    }
    if (statement.includes("FROM crypto_domains") && statement.includes("OR (")) {
      return Promise.resolve(
        (this.scenario.existingDomainRows ?? []) as Row[],
      );
    }
    if (statement.includes("RETURNING")) {
      return Promise.resolve([{ accepted: true }] as Row[]);
    }
    return Promise.resolve([]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function authorityRow(signingPublicKey: Uint8Array) {
  return {
    human_id: HUMAN,
    user_id: USER,
    human_actor_id: HUMAN,
    custody_state: "active",
    current_recovery_generation: 1,
    current_inventory_revision: null,
    current_inventory_count: null,
    current_inventory_digest: null,
    custody_revision: 1,
    device_id: DEVICE,
    device_generation: 1,
    signing_public_key: signingPublicKey,
    device_state: "active",
    device_revision: 1,
  };
}

function durableReplayRow(input: ReturnType<typeof fixture>) {
  const submissionDigest = humanMembershipTargetDomainSubmissionDigest({
    crypto: input.crypto,
    submission: input.submission,
  });
  return {
    operation_id: OPERATION,
    idempotency_key:
      `domain_bootstrap/${Buffer.from(submissionDigest).toString("base64url")}`,
    kind: "domain_bootstrap",
    state: "active",
    human_id: HUMAN,
    target_human_id: HUMAN,
    target_device_id: DEVICE,
    expected_custody_revision: 1,
    expected_recovery_generation: 1,
    expected_device_revision: 1,
    expected_participant_digest: input.digest,
    aggregate_payload_bytes: 0,
    fanout_row_count: 0,
    failure_code: null,
    audit_ref: DOMAIN,
    terminal_at_ms: COMMITTED_AT,
    domain_id: DOMAIN,
    participants: [HUMAN],
    participant_digest: input.digest,
    domain_epoch: 0,
    authorization_revision: 0,
    domain_roster_bytes: input.rosterBytes,
    writes_paused: false,
    pause_operation_id: null,
    provider_domain_id: DOMAIN,
    provider_id: "openmls-v2",
    provider_epoch: 0,
    state_hash: input.submission.initialProviderHead.stateHash,
    provider_roster_bytes: input.rosterBytes,
    mapping_domain_id: DOMAIN,
    mapping_device_id: DEVICE,
    mapping_human_id: HUMAN,
    leaf_index: 0,
    joined_epoch: 0,
    removed_epoch: null,
    removed_at: null,
  };
}

async function setup(
  scenario: Scenario | ((state: ReturnType<typeof fixture>) => Scenario),
) {
  const state = fixture();
  const connection = new InitialDomainConnection(
    typeof scenario === "function" ? scenario(state) : scenario,
  );
  const handle = await verifyCryptoPostgresHandle(connection);
  const repository = new PostgresInitialHumanDomainRepository({
    handle,
    crypto: state.crypto,
  });
  return { state, connection, repository };
}

function activate(
  repository: PostgresInitialHumanDomainRepository,
  submission: ReturnType<typeof fixture>["submission"],
) {
  return repository.activate({
    authority: {
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: DEVICE,
    },
    submission,
    committedAt: COMMITTED_AT,
  });
}

describe("Postgres initial Human Domain repository", () => {
  test("plans only the exact singleton active device before a Domain exists", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [{
        ...authorityRow(state.signing.publicKey),
        active_device_ids: [DEVICE],
        containing_domain_count: 0,
        delivery_sequence_high_watermark: 7,
      }],
    }));
    expect(await setupState.repository.planSingleton({
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: DEVICE,
    })).toEqual({
      status: "available",
      humanId: HUMAN,
      deviceId: DEVICE,
      activeDeviceIds: [DEVICE],
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 7,
    });
    expect(setupState.connection.queries.at(-1)?.statement)
      .toContain("delivery_sequence_high_watermark");
    expect(setupState.connection.queries.at(-1)?.statement)
      .toContain("current_inventory_revision");
  });

  test("rejects a pre-existing device inventory when planning a singleton Domain", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [{
        ...authorityRow(state.signing.publicKey),
        current_inventory_revision: 1,
        current_inventory_count: 1,
        current_inventory_digest: new Uint8Array(32).fill(0x27),
        active_device_ids: [DEVICE],
        containing_domain_count: 0,
        delivery_sequence_high_watermark: 7,
      }],
    }));
    expect(await setupState.repository.planSingleton({
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: DEVICE,
    })).toEqual({ status: "stale_identity" });
  });

  test("returns exact active Domain facts for a mapped device in a multi-device Human", async () => {
    const stateHash = new Uint8Array(32).fill(0x42);
    const setupState = await setup((state) => ({
      inventoryRows: [{
        ...authorityRow(state.signing.publicKey),
        active_device_ids: [DEVICE, "device_second"],
        containing_domain_count: 1,
        delivery_sequence_high_watermark: 7,
      }],
      activeDomainRows: [{
        domain_id: DOMAIN,
        domain_epoch: 0,
        provider_id: "openmls-v2",
        provider_epoch: 0,
        state_hash: stateHash,
        mapping_human_id: HUMAN,
        mapping_device_id: DEVICE,
      }],
    }));
    expect(await setupState.repository.planSingleton({
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: DEVICE,
    })).toEqual({
      status: "active",
      humanId: HUMAN,
      deviceId: DEVICE,
      domainId: DOMAIN,
      providerId: "openmls-v2",
      epoch: 0,
      stateHash,
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 7,
    });
  });

  test("returns the active Domain after its delivery inventory is established", async () => {
    const stateHash = new Uint8Array(32).fill(0x43);
    const setupState = await setup((state) => ({
      inventoryRows: [{
        ...authorityRow(state.signing.publicKey),
        current_inventory_revision: 3,
        current_inventory_count: 14,
        current_inventory_digest: new Uint8Array(32).fill(0x29),
        active_device_ids: [DEVICE],
        containing_domain_count: 1,
        delivery_sequence_high_watermark: 9,
      }],
      activeDomainRows: [{
        domain_id: DOMAIN,
        domain_epoch: 2,
        provider_id: "openmls-v2",
        provider_epoch: 2,
        state_hash: stateHash,
        mapping_human_id: HUMAN,
        mapping_device_id: DEVICE,
      }],
    }));
    expect(await setupState.repository.planSingleton({
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: DEVICE,
    })).toEqual({
      status: "active",
      humanId: HUMAN,
      deviceId: DEVICE,
      domainId: DOMAIN,
      providerId: "openmls-v2",
      epoch: 2,
      stateHash,
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 9,
    });
  });

  test("routes an unregistered device to existing-Domain delivery", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [{
        ...authorityRow(state.signing.publicKey),
        device_id: null,
        device_state: null,
        current_inventory_revision: 3,
        current_inventory_count: 14,
        current_inventory_digest: new Uint8Array(32).fill(0x29),
        active_device_ids: [DEVICE],
        containing_domain_count: 1,
        delivery_sequence_high_watermark: 9,
      }],
    }));
    expect(await setupState.repository.planSingleton({
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: "device_new_browser",
    })).toEqual({ status: "existing_domain" });
  });

  test("keeps exact profile migration coordinates when legacy Domain delivery is required", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [{
        ...authorityRow(state.signing.publicKey),
        active_device_ids: [DEVICE],
        containing_domain_count: 1,
        delivery_sequence_high_watermark: 9,
      }],
      activeDomainRows: [],
    }));
    expect(await setupState.repository.planSingleton({
      userId: USER,
      humanActorId: HUMAN,
      humanId: HUMAN,
      deviceId: DEVICE,
    })).toEqual({
      status: "existing_domain",
      migration: {
        trustedDeviceRevision: 1,
        trustedHostAuthorizationRevision: 1,
        deliveryHighWatermark: 9,
      },
    });
  });

  test("atomically verifies and persists one content-free rev-0 Domain", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [authorityRow(state.signing.publicKey)],
    }));
    const result = await activate(
      setupState.repository,
      setupState.state.submission,
    );

    expect(result).toMatchObject({
      status: "active",
      receipt: {
        formatVersion: 1,
        status: "active",
        operationId: OPERATION,
        humanId: HUMAN,
        deviceId: DEVICE,
        domainId: DOMAIN,
        providerId: "openmls-v2",
        epoch: 0,
        committedAt: COMMITTED_AT,
      },
    });
    const sql = setupState.connection.queries.map((query) => query.statement)
      .join("\n");
    expect(sql).toContain("INSERT INTO crypto_domains");
    expect(sql).toContain("INSERT INTO crypto_domain_provider_heads");
    expect(sql).toContain("INSERT INTO crypto_domain_devices");
    expect(sql).toContain("'domain_bootstrap', 'active'");
    expect(sql).not.toContain("snapshot");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("crypto_delivery_messages");
  });

  test("replays only from the exact terminal operation and durable Domain facts", async () => {
    const setupState = await setup((state) => ({
      replayRows: [durableReplayRow(state)],
    }));
    const result = await activate(
      setupState.repository,
      setupState.state.submission,
    );
    expect(result.status).toBe("replayed");
    expect(setupState.connection.queries.some((query) =>
      query.statement.includes("FROM human_crypto_custodies custody")
    )).toBe(false);
    expect(setupState.connection.queries.some((query) =>
      query.statement.includes("INSERT INTO crypto_domains")
    )).toBe(false);
    const replayQuery = setupState.connection.queries.find((query) =>
      query.statement.includes("FROM crypto_delivery_operations o")
    )?.statement;
    expect(replayQuery).toContain("p.epoch = 0");
    expect(replayQuery).toContain("m.joined_epoch = 0");
    expect(replayQuery).toContain("FOR UPDATE OF o");
    expect(replayQuery).not.toContain("FOR UPDATE OF o, d");
  });

  test("rejects operation, Domain, and durable roster substitutions", async () => {
    const setupState = await setup((state) => ({ replayRows: [{
      ...durableReplayRow(state),
      provider_roster_bytes: new Uint8Array([1]),
    }] }));
    const result = await activate(
      setupState.repository,
      setupState.state.submission,
    );
    expect(result).toEqual({ status: "conflicting_state" });
  });

  test("rejects multiple, revoked, and substituted current device authority", async () => {
    const multiple = await setup((state) => ({ inventoryRows: [
      authorityRow(state.signing.publicKey),
      { ...authorityRow(state.signing.publicKey), device_id: "device_second" },
    ] }));
    expect(await activate(multiple.repository, multiple.state.submission))
      .toEqual({ status: "multiple_active_devices" });

    const revoked = await setup((state) => ({ inventoryRows: [{
      ...authorityRow(state.signing.publicKey),
      device_state: "revoked",
    }] }));
    expect(await activate(revoked.repository, revoked.state.submission))
      .toEqual({ status: "stale_state" });
  });

  test("ignores historical removed devices in the singleton active inventory", async () => {
    const setupState = await setup((state) => ({ inventoryRows: [
      authorityRow(state.signing.publicKey),
      {
        ...authorityRow(state.signing.publicKey),
        device_id: "device_historical_removed",
        device_state: "revoked",
      },
    ] }));
    expect(await activate(setupState.repository, setupState.state.submission))
      .toMatchObject({ status: "active" });
    const inventoryQuery = setupState.connection.queries.find((query) =>
      query.statement.includes("FROM human_crypto_custodies custody")
    );
    expect(inventoryQuery?.statement).toContain("device.state = 'active'");
  });

  test("returns typed existing Domain and never creates a rival", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [authorityRow(state.signing.publicKey)],
      existingDomainRows: [{
        id: "domain_already_active",
        participants: [HUMAN],
        participant_digest: participantDigest([humanId(HUMAN)]),
      }],
    }));
    const result = await activate(
      setupState.repository,
      setupState.state.submission,
    );
    expect(result).toEqual({ status: "existing_domain" });
    expect(setupState.connection.queries.some((query) =>
      query.statement.includes("INSERT INTO crypto_domains")
    )).toBe(false);
  });

  test("fails closed on a tampered signed client submission before writes", async () => {
    const setupState = await setup((state) => ({
      inventoryRows: [authorityRow(state.signing.publicKey)],
    }));
    const tampered = {
      ...setupState.state.submission,
      signature: setupState.state.submission.signature.slice().fill(0xff),
    };
    expect(await activate(setupState.repository, tampered)).toEqual({
      status: "conflicting_state",
    });
    expect(setupState.connection.queries.some((query) =>
      query.statement.includes("INSERT INTO crypto_domains")
    )).toBe(false);
  });
});
