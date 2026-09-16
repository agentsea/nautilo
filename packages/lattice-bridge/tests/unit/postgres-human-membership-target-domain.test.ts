import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "@nautilo/lattice-crypto";
import {
  validateProviderPublicTransitionV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createDeviceJoinPackage,
  createHumanMembershipTargetDomainSubmission,
  createProviderTransitionSubmission,
} from "../../src/index.ts";
import {
  PostgresHumanMembershipTargetDomainRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedCryptoConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const ALICE_DEVICE = cryptoDeviceId("device_alice");
const CHARLIE_DEVICE = cryptoDeviceId("device_charlie");
const DOMAIN = cryptoDomainId("domain_alice_charlie");
const SOURCE_DOMAIN = cryptoDomainId("domain_alice");
const OPERATION = "membership_operation_target_domain";
const NAMESPACE = "namespace_room_1";

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

function roster(entries: readonly {
  readonly leafIndex: number;
  readonly humanId: string;
  readonly deviceId: string;
}[]): Uint8Array {
  return concat([
    text("nautilo/lattice-crypto/openmls-roster/v2"),
    u32(entries.length),
    ...entries.flatMap((entry) => [
      u32(entry.leafIndex),
      text(entry.humanId),
      text(entry.deviceId),
    ]),
  ]);
}

function targetDomainFixture() {
  const crypto = new LatticeCrypto();
  const alice = crypto.generateSigningKeyPair();
  const charlie = crypto.generateSigningKeyPair();
  const participantDigest = new Uint8Array(32).fill(0x41);
  const initialHead = {
    providerId: "openmls-v2",
    domainId: DOMAIN,
    epoch: domainEpoch(0),
    stateHash: new Uint8Array(32).fill(0x51),
  };
  const initialRosterBytes = roster([{
    leafIndex: 0,
    humanId: ALICE,
    deviceId: ALICE_DEVICE,
  }]);
  const joinPackage = createDeviceJoinPackage({
    crypto,
    request: {
      formatVersion: 2,
      providerId: initialHead.providerId,
      domainId: DOMAIN,
      humanId: CHARLIE,
      deviceId: CHARLIE_DEVICE,
      expectedHead: initialHead,
      keyPackageBytes: new Uint8Array([0x61]),
    },
    generation: 1,
    packageId: "package_charlie",
    createdAt: 1_000,
    expiresAt: 2_000,
    signingPrivateKey: charlie.privateKey,
  });
  const welcomeBytes = new Uint8Array([0x71]);
  const finalRosterBytes = roster([
    {
      leafIndex: 0,
      humanId: ALICE,
      deviceId: ALICE_DEVICE,
    },
    {
      leafIndex: 1,
      humanId: CHARLIE,
      deviceId: CHARLIE_DEVICE,
    },
  ]);
  const transition = validateProviderPublicTransitionV2({
    formatVersion: 2,
    providerId: initialHead.providerId,
    domainId: DOMAIN,
    operation: "add",
    targetHumanId: CHARLIE,
    targetDeviceId: CHARLIE_DEVICE,
    expectedHead: initialHead,
    nextHead: {
      ...initialHead,
      epoch: domainEpoch(1),
      stateHash: new Uint8Array(32).fill(0x52),
    },
    commitBytes: new Uint8Array([0x81]),
    welcomeHash: crypto.hash(welcomeBytes),
    welcomeBytes,
    rosterBytes: finalRosterBytes,
  });
  const providerSubmission = createProviderTransitionSubmission({
    crypto,
    transition,
    operationId: OPERATION,
    committerDeviceId: ALICE_DEVICE,
    expectedAuthorizationRevision: 0,
    expectedParticipantDigest: participantDigest,
    signingPrivateKey: alice.privateKey,
  });
  return {
    crypto,
    alice,
    charlie,
    participantDigest,
    finalRosterBytes,
    submission: createHumanMembershipTargetDomainSubmission({
      crypto,
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      participants: [ALICE, CHARLIE],
      participantDigest,
      committerDeviceId: ALICE_DEVICE,
      committerHumanId: ALICE,
      initialProviderHead: initialHead,
      initialRosterBytes,
      additions: [{ joinPackage, providerSubmission }],
      signingPrivateKey: alice.privateKey,
    }),
  };
}

async function repositoryWithResults(
  crypto: LatticeCrypto,
  results: unknown[][],
) {
  const connection = new ScriptedCryptoConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresHumanMembershipTargetDomainRepository({
      handle,
      crypto,
    }),
  };
}

function deliveryDevice(deviceId: string) {
  return {
    device_id: deviceId,
    state: "active",
    delivery_sequence_high_watermark: 0,
    delivery_acknowledged_sequence: 0,
    delivery_blocked_sequence: null,
    delivery_blocked_operation_id: null,
    delivery_blocked_at: null,
    delivery_blocked_reason: null,
    first_unresolved_expires_at_ms: null,
  };
}

describe("Postgres Human membership target Domain", () => {
  test("rejects an unverified database handle", () => {
    const crypto = new LatticeCrypto();
    const forged = new ScriptedCryptoConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() =>
      new PostgresHumanMembershipTargetDomainRepository({
        handle: forged,
        crypto,
      })
    ).toThrow("verified nautilo_crypto handle");
  });

  test("creates, maps, delivers, and attaches a new exact-set Domain atomically", async () => {
    const setup = targetDomainFixture();
    const headHash = new Uint8Array(32).fill(0x31);
    const authoritative = {
      operation_id: OPERATION,
      kind: "human_add",
      state: "preparing_domain",
      target_human_id: CHARLIE,
      target_device_id: CHARLIE_DEVICE,
      fanout_row_count: 0,
      aggregate_payload_bytes: 0,
      deadline_live: true,
      namespace_id: NAMESPACE,
      target_human_actor_id: CHARLIE,
      admitted_bootstrap_device_id: null,
      bootstrap_device_id: CHARLIE_DEVICE,
      old_participants: [ALICE],
      old_participant_digest: new Uint8Array(32).fill(0x21),
      new_participants: [ALICE, CHARLIE],
      new_participant_digest: setup.participantDigest,
      old_domain_id: SOURCE_DOMAIN,
      admitted_target_domain_id: null,
      target_domain_id: null,
      expected_access_revision: 4,
      expected_binding_hash: headHash,
      committer_device_id: null,
      candidate_submitted_at: null,
      activated_at: null,
      released_at: null,
      head_access_revision: 4,
      head_binding_hash: headHash,
      head_domain_id: SOURCE_DOMAIN,
      head_writes_paused: false,
      head_pause_operation_id: null,
      source_participants: [ALICE],
      source_participant_digest: new Uint8Array(32).fill(0x21),
      committer_human_id: ALICE,
      committer_state: "active",
      signing_public_key: setup.alice.publicKey,
      source_mapping_human_id: ALICE,
      source_mapping_removed_at: null,
    };
    const inventory = [
      {
        device_id: ALICE_DEVICE,
        human_id: ALICE,
        device_generation: 1,
        signing_public_key: setup.alice.publicKey,
        state: "active",
        human_actor_id: ALICE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
      {
        device_id: CHARLIE_DEVICE,
        human_id: CHARLIE,
        device_generation: 1,
        signing_public_key: setup.charlie.publicKey,
        state: "active",
        human_actor_id: CHARLIE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
    ];
    const fixture = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [authoritative],
      [],
      [],
      inventory,
      [deliveryDevice(ALICE_DEVICE), deliveryDevice(CHARLIE_DEVICE)],
      [{ device_id: ALICE_DEVICE }],
      [{ device_id: CHARLIE_DEVICE }],
      [{ id: DOMAIN }],
      [{ domain_id: DOMAIN }],
      [{ device_id: ALICE_DEVICE }],
      [{ device_id: CHARLIE_DEVICE }],
      [{ message_id: "delivery_alice" }],
      [{ message_id: "delivery_charlie" }],
      [{ operation_id: OPERATION }],
      [{ operation_id: OPERATION }],
    ]);

    const result = await fixture.repository.create({
      submission: setup.submission,
      preparedAt: 1_500,
    });
    expect(result).toMatchObject({
      status: "created",
      targetDomainId: DOMAIN,
      targetEpoch: 1,
      recipientCount: 2,
      messageCount: 2,
    });
    const sql = fixture.connection.queries
      .map(({ statement }) => statement).join("\n");
    expect(sql).toContain("INSERT INTO crypto_domains");
    expect(sql).toContain("INSERT INTO crypto_domain_provider_heads");
    expect(sql).toContain("INSERT INTO crypto_domain_devices");
    expect(sql).toContain("'public_state'");
    expect(sql).toContain("SET target_domain_id = $2");
    expect(sql).toContain("SET state = 'awaiting_committer'");
    expect(fixture.connection.queries.find(({ statement }) =>
      statement.includes("INSERT INTO crypto_delivery_messages")
    )?.statement).toContain("$1, $2, NULL, NULL, $3");
  });

  test("creates the exact remaining-Human Domain while removal writes stay paused", async () => {
    const setup = targetDomainFixture();
    const headHash = new Uint8Array(32).fill(0x31);
    const inventory = [
      {
        device_id: ALICE_DEVICE,
        human_id: ALICE,
        device_generation: 1,
        signing_public_key: setup.alice.publicKey,
        state: "active",
        human_actor_id: ALICE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
      {
        device_id: CHARLIE_DEVICE,
        human_id: CHARLIE,
        device_generation: 1,
        signing_public_key: setup.charlie.publicKey,
        state: "active",
        human_actor_id: CHARLIE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
    ];
    const fixture = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [{
        operation_id: OPERATION,
        kind: "human_remove",
        state: "preparing_domain",
        target_human_id: null,
        target_device_id: null,
        fanout_row_count: 0,
        aggregate_payload_bytes: 0,
        deadline_live: true,
        namespace_id: NAMESPACE,
        target_human_actor_id: BOB,
        admitted_bootstrap_device_id: null,
        bootstrap_device_id: null,
        old_participants: [ALICE, BOB, CHARLIE],
        old_participant_digest: new Uint8Array(32).fill(0x21),
        new_participants: [ALICE, CHARLIE],
        new_participant_digest: setup.participantDigest,
        old_domain_id: SOURCE_DOMAIN,
        admitted_target_domain_id: null,
        target_domain_id: null,
        expected_access_revision: 4,
        expected_binding_hash: headHash,
        committer_device_id: null,
        candidate_submitted_at: null,
        activated_at: null,
        released_at: null,
        head_access_revision: 4,
        head_binding_hash: headHash,
        head_domain_id: SOURCE_DOMAIN,
        head_writes_paused: true,
        head_pause_operation_id: OPERATION,
        source_participants: [ALICE, BOB, CHARLIE],
        source_participant_digest: new Uint8Array(32).fill(0x21),
        committer_human_id: ALICE,
        committer_state: "active",
        signing_public_key: setup.alice.publicKey,
        source_mapping_human_id: ALICE,
        source_mapping_removed_at: null,
      }],
      [],
      [],
      inventory,
      [deliveryDevice(ALICE_DEVICE), deliveryDevice(CHARLIE_DEVICE)],
      [{ device_id: ALICE_DEVICE }],
      [{ device_id: CHARLIE_DEVICE }],
      [{ id: DOMAIN }],
      [{ domain_id: DOMAIN }],
      [{ device_id: ALICE_DEVICE }],
      [{ device_id: CHARLIE_DEVICE }],
      [{ message_id: "delivery_alice" }],
      [{ message_id: "delivery_charlie" }],
      [{ operation_id: OPERATION }],
      [{ operation_id: OPERATION }],
    ]);

    expect(await fixture.repository.create({
      submission: setup.submission,
      preparedAt: 1_500,
    })).toMatchObject({
      status: "created",
      targetDomainId: DOMAIN,
      recipientCount: 2,
    });
    const sql = fixture.connection.queries
      .map(({ statement }) => statement).join("\n");
    expect(sql).toContain("kind IN ('human_add', 'human_remove')");
    expect(sql).toContain("head.pause_operation_id");
    expect(sql).toContain(
      "$3 = 'human_remove' AND bootstrap_device_id IS NULL",
    );
  });

  test("accepts an exact creation replay after membership activation", async () => {
    const setup = targetDomainFixture();
    const final = setup.submission.additions.at(-1)!.providerSubmission
      .transition;
    const inventory = [
      {
        device_id: ALICE_DEVICE,
        human_id: ALICE,
        device_generation: 1,
        signing_public_key: setup.alice.publicKey,
        state: "active",
        human_actor_id: ALICE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
      {
        device_id: CHARLIE_DEVICE,
        human_id: CHARLIE,
        device_generation: 1,
        signing_public_key: setup.charlie.publicKey,
        state: "active",
        human_actor_id: CHARLIE,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
    ];
    const fixture = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [{
        operation_id: OPERATION,
        kind: "human_add",
        state: "active",
        target_human_id: CHARLIE,
        target_device_id: CHARLIE_DEVICE,
        fanout_row_count: 4,
        aggregate_payload_bytes: 1_024,
        deadline_live: false,
        namespace_id: NAMESPACE,
        target_human_actor_id: CHARLIE,
        admitted_bootstrap_device_id: null,
        bootstrap_device_id: CHARLIE_DEVICE,
        old_participants: [ALICE],
        old_participant_digest: new Uint8Array(32).fill(0x21),
        new_participants: [ALICE, CHARLIE],
        new_participant_digest: setup.participantDigest,
        old_domain_id: SOURCE_DOMAIN,
        admitted_target_domain_id: null,
        target_domain_id: DOMAIN,
        expected_access_revision: 4,
        expected_binding_hash: new Uint8Array(32).fill(0x31),
        committer_device_id: ALICE_DEVICE,
        candidate_submitted_at: "1970-01-01T00:00:01.600Z",
        activated_at: "1970-01-01T00:00:01.700Z",
        released_at: "1970-01-01T00:00:01.700Z",
        head_access_revision: 5,
        head_binding_hash: new Uint8Array(32).fill(0x32),
        head_domain_id: DOMAIN,
        head_writes_paused: false,
        head_pause_operation_id: null,
        source_participants: [ALICE],
        source_participant_digest: new Uint8Array(32).fill(0x21),
        committer_human_id: ALICE,
        committer_state: "active",
        signing_public_key: setup.alice.publicKey,
        source_mapping_human_id: ALICE,
        source_mapping_removed_at: null,
      }],
      [],
      [{ id: DOMAIN }],
      inventory,
      [{
        id: DOMAIN,
        participants: [ALICE, CHARLIE],
        participant_digest: setup.participantDigest,
        epoch: 1,
        authorization_revision: 0,
        roster_bytes: setup.finalRosterBytes,
        writes_paused: false,
        pause_operation_id: null,
        provider_id: final.providerId,
        provider_epoch: 1,
        state_hash: final.nextHead.stateHash,
        provider_roster_bytes: setup.finalRosterBytes,
      }],
      [
        {
          device_id: ALICE_DEVICE,
          human_id: ALICE,
          leaf_index: 0,
          joined_epoch: 0,
        },
        {
          device_id: CHARLIE_DEVICE,
          human_id: CHARLIE,
          leaf_index: 1,
          joined_epoch: 1,
        },
      ],
      [{ message_count: 4 }],
    ]);

    expect(await fixture.repository.create({
      submission: setup.submission,
      preparedAt: 5_000,
    })).toEqual({
      status: "duplicate",
      targetDomainId: DOMAIN,
      targetEpoch: 1,
      recipientCount: 2,
      messageCount: 4,
    });
    expect(fixture.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO crypto_domains")
    )).toBe(false);
  });

  test("reuses an exact current roster but rejects no-device shortcuts", async () => {
    const setup = targetDomainFixture();
    const row = {
      operation_id: OPERATION,
      kind: "human_add",
      state: "preparing_domain",
      deadline_live: true,
      namespace_id: NAMESPACE,
      target_human_actor_id: CHARLIE,
      admitted_bootstrap_device_id: null,
      bootstrap_device_id: CHARLIE_DEVICE,
      new_participants: [ALICE, CHARLIE],
      new_participant_digest: setup.participantDigest,
      old_domain_id: SOURCE_DOMAIN,
      admitted_target_domain_id: null,
      target_domain_id: null,
      candidate_submitted_at: null,
      activated_at: null,
      released_at: null,
      head_domain_id: SOURCE_DOMAIN,
      head_writes_paused: false,
      head_pause_operation_id: null,
      target_participants: [ALICE, CHARLIE],
      target_participant_digest: setup.participantDigest,
      target_epoch: 1,
      target_roster_bytes: setup.finalRosterBytes,
      authorization_revision: 0,
      target_writes_paused: false,
      provider_id: "openmls-v2",
      provider_epoch: 1,
      provider_roster_bytes: setup.finalRosterBytes,
      bootstrap_state: "active",
      bootstrap_human_id: CHARLIE,
      bootstrap_human_actor_id: CHARLIE,
      bootstrap_mapping_human_id: CHARLIE,
      bootstrap_mapping_removed_at: null,
    };
    const inventory = [
      {
        device_id: ALICE_DEVICE,
        human_id: ALICE,
        state: "active",
        leaf_index: 0,
        joined_epoch: 0,
        removed_at: null,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
      {
        device_id: CHARLIE_DEVICE,
        human_id: CHARLIE,
        state: "active",
        leaf_index: 1,
        joined_epoch: 1,
        removed_at: null,
        custody_state: "active",
        current_recovery_generation: 1,
        recovery_state: "current",
      },
    ];
    const fixture = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [row],
      inventory,
      inventory.map((device) => ({
        device_id: device.device_id,
        human_id: device.human_id,
        leaf_index: device.leaf_index,
        joined_epoch: device.joined_epoch,
      })),
      [{ device_id: ALICE_DEVICE }],
      [{ operation_id: OPERATION }],
      [{ operation_id: OPERATION }],
    ]);

    expect(await fixture.repository.reuse({
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      resolvedAt: 1_500,
    })).toEqual({
      status: "reused",
      targetDomainId: DOMAIN,
      targetEpoch: 1,
      recipientCount: 2,
      messageCount: 0,
    });
    const sql = fixture.connection.queries
      .map(({ statement }) => statement).join("\n");
    expect(sql).toContain("JOIN crypto_domain_devices target");
    expect(sql).toContain("SET target_domain_id = $2");

    const removal = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [{
        ...row,
        kind: "human_remove",
        target_human_actor_id: BOB,
        bootstrap_device_id: null,
        head_writes_paused: true,
        head_pause_operation_id: OPERATION,
        bootstrap_state: null,
        bootstrap_human_id: null,
        bootstrap_human_actor_id: null,
        bootstrap_mapping_human_id: null,
        bootstrap_mapping_removed_at: null,
      }],
      inventory,
      inventory.map((device) => ({
        device_id: device.device_id,
        human_id: device.human_id,
        leaf_index: device.leaf_index,
        joined_epoch: device.joined_epoch,
      })),
      [{ device_id: ALICE_DEVICE }],
      [{ operation_id: OPERATION }],
      [{ operation_id: OPERATION }],
    ]);
    expect(await removal.repository.reuse({
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      resolvedAt: 1_500,
    })).toEqual({
      status: "reused",
      targetDomainId: DOMAIN,
      targetEpoch: 1,
      recipientCount: 2,
      messageCount: 0,
    });

    const progressed = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [{
        ...row,
        state: "active",
        target_domain_id: DOMAIN,
        candidate_submitted_at: "1970-01-01T00:00:01.600Z",
        activated_at: "1970-01-01T00:00:01.700Z",
        released_at: "1970-01-01T00:00:01.700Z",
        head_domain_id: DOMAIN,
      }],
      inventory,
      inventory.map((device) => ({
        device_id: device.device_id,
        human_id: device.human_id,
        leaf_index: device.leaf_index,
        joined_epoch: device.joined_epoch,
      })),
      [{ device_id: ALICE_DEVICE }],
    ]);
    expect(await progressed.repository.reuse({
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      resolvedAt: 5_000,
    })).toEqual({
      status: "duplicate",
      targetDomainId: DOMAIN,
      targetEpoch: 1,
      recipientCount: 2,
      messageCount: 0,
    });

    const missingDevice = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [row],
      inventory.slice(0, 1),
    ]);
    expect(await missingDevice.repository.reuse({
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      resolvedAt: 1_500,
    })).toEqual({ status: "stale_state" });

    const extraMapping = await repositoryWithResults(setup.crypto, [
      [],
      [{ namespace_id: NAMESPACE }],
      [],
      [row],
      inventory,
      [
        ...inventory.map((device) => ({
          device_id: device.device_id,
          human_id: device.human_id,
          leaf_index: device.leaf_index,
          joined_epoch: device.joined_epoch,
        })),
        {
          device_id: "device_revoked_but_still_mapped",
          human_id: ALICE,
          leaf_index: 2,
          joined_epoch: 1,
        },
      ],
    ]);
    expect(await extraMapping.repository.reuse({
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      resolvedAt: 1_500,
    })).toEqual({ status: "stale_state" });
  });
});
