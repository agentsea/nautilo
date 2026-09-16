import { describe, expect, test } from "bun:test";
import type {
  InitialDeviceBootstrapChallenge,
  NautiloActorId,
  NautiloUserId,
} from "../../src/index.ts";
import {
  PostgresInitialDeviceBootstrapRepository,
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
      parameters.some(
        (value) =>
          typeof value === "string"
          && value.startsWith("crypto-human-operation-capacity/"),
      )
      || statement.includes(
        "LEFT JOIN crypto_human_membership_transitions membership",
      )
    ) {
      return Promise.resolve([]);
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

const USER_ID =
  "00000000-0000-4000-8000-00000000000a" as NautiloUserId;
const ACTOR_ID =
  "00000000-0000-4000-8000-00000000000b" as NautiloActorId;
const LINEAGE = new Uint8Array(32).fill(0x31);
const AUTHORIZATION = new Uint8Array(32).fill(0x41);
const SIGNING_KEY = new Uint8Array(32).fill(0x51);
const ENCRYPTION_KEY = new Uint8Array(65).fill(0x61);
const RECOVERY_KEY = new Uint8Array(65).fill(0x71);
const CHALLENGE_HASH = new Uint8Array(32).fill(0x81);
const FINGERPRINT = new Uint8Array(32).fill(0x91);
const SIGNING_DIGEST = new Uint8Array(32).fill(0xa1);
const ENCRYPTION_DIGEST = new Uint8Array(32).fill(0xb1);
const RECOVERY_DIGEST = new Uint8Array(32).fill(0xc1);

const request = {
  userId: USER_ID,
  humanActorId: ACTOR_ID,
  deviceId: "device_alice_browser",
  clientKind: "browser" as const,
  installationLineageDigest: LINEAGE,
  signingPublicKey: SIGNING_KEY,
  encryptionPublicKey: ENCRYPTION_KEY,
  recoveryKeyId: "recovery_alice_1",
  recoveryPublicKey: RECOVERY_KEY,
  context: {
    kind: "preparation" as const,
    authorityId: "prep_1",
  },
  idempotencyKey: "bootstrap_alice_1",
};

const challenge: InitialDeviceBootstrapChallenge = {
  formatVersion: 1,
  ...request,
  challengeId: `bootstrap_${"11".repeat(32)}`,
  authorizationEvidenceDigest: new Uint8Array(32).fill(0x21),
  authorizationDigest: AUTHORIZATION,
  issuedAt: 10_000,
  expiresAt: 310_000,
};
const INVITE_OPERATION_ID = "membership_operation_charlie_invite";
const SIBLING_INVITE_OPERATION_ID =
  "membership_operation_charlie_second_invite";
const INVITE_NAMESPACE_ID = "namespace_charlie_invite";
const pendingInviteRequest = {
  ...request,
  context: {
    kind: "pending_encrypted_invite" as const,
    authorityId: INVITE_OPERATION_ID,
  },
};
const pendingInviteChallenge: InitialDeviceBootstrapChallenge = {
  ...challenge,
  ...pendingInviteRequest,
};

function pendingInviteAuthority(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation_id: INVITE_OPERATION_ID,
    operation_kind: "human_add",
    operation_state: "awaiting_target_device",
    target_human_id: null,
    target_device_id: null,
    deadline_at_ms: 600_000,
    namespace_id: INVITE_NAMESPACE_ID,
    target_human_actor_id: ACTOR_ID,
    admitted_bootstrap_device_id: null,
    bootstrap_device_id: null,
    admitted_target_domain_id: null,
    target_domain_id: null,
    membership_activated: false,
    membership_released: false,
    ...overrides,
  };
}

async function repositoryWithResults(results: unknown[][]): Promise<{
  readonly connection: ScriptedCryptoConnection;
  readonly repository: PostgresInitialDeviceBootstrapRepository;
}> {
  const connection = new ScriptedCryptoConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresInitialDeviceBootstrapRepository(handle),
  };
}

describe("Postgres first-device bootstrap repository", () => {
  test("rejects an unverified database handle", () => {
    const forged = new ScriptedCryptoConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() => new PostgresInitialDeviceBootstrapRepository(forged))
      .toThrow("verified nautilo_crypto handle");
  });

  test("resolves only the exact committed receipt without a transaction", async () => {
    const fixture = await repositoryWithResults([[
      {
        receipt_audit_ref: `bootstrap_${"ab".repeat(16)}`,
        committed_at_ms: "10000",
        device_id: request.deviceId,
        device_revision: 1,
        human_id: ACTOR_ID,
        current_recovery_generation: 1,
        custody_revision: 1,
        recovery_key_id: request.recoveryKeyId,
      },
    ]]);

    const receipt = await fixture.repository.resolveReceipt({
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: request.deviceId,
      challengeId: challenge.challengeId,
      publicFingerprint: FINGERPRINT,
    });

    expect(receipt).toEqual({
      formatVersion: 1,
      status: "active",
      humanActorId: ACTOR_ID,
      deviceId: request.deviceId,
      recoveryKeyId: request.recoveryKeyId,
      recoveryGeneration: 1,
      deviceRevision: 1,
      custodyRevision: 1,
      auditRef: `bootstrap_${"ab".repeat(16)}`,
      committedAt: 10_000,
    });
    expect(fixture.connection.transactionCount).toBe(0);
    expect(fixture.connection.queries.at(-1)?.parameters.slice(0, 5)).toEqual([
      challenge.challengeId,
      USER_ID,
      ACTOR_ID,
      request.deviceId,
      FINGERPRINT,
    ]);
  });

  test("creates custody, pending device, operation, and challenge atomically", async () => {
    const fixture = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await fixture.repository.begin({
      request,
      authorizationDigest: AUTHORIZATION,
      challengeId: challenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });

    expect(result).toEqual({
      status: "created",
      challengeId: challenge.challengeId,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    expect(fixture.connection.transactionCount).toBe(1);
    const transactionSql = fixture.connection.queries
      .slice(1)
      .map((query) => query.statement)
      .join("\n")
      .replaceAll('"', "")
      .toLowerCase();
    expect(transactionSql).toContain(
      "set transaction isolation level serializable",
    );
    expect(transactionSql).toContain("from users inner join actors");
    expect(transactionSql).toContain("actors.owner_id::text as actor_owner_id");
    expect(transactionSql).not.toContain("select *");
    expect(transactionSql).toContain(
      "insert into human_crypto_custodies",
    );
    expect(transactionSql).toContain("insert into human_crypto_devices");
    expect(transactionSql).toContain(
      "insert into crypto_delivery_operations",
    );
    expect(transactionSql).toContain(
      "insert into human_crypto_device_challenges",
    );
    expect(fixture.connection.queries.some(({ statement, parameters }) =>
      statement.includes("pg_advisory_xact_lock")
      && parameters[0]
        === `crypto-human-operation-capacity/${ACTOR_ID}`
    )).toBe(true);
  });

  test("rejects a mismatched canonical User/Human/Actor tuple before writes", async () => {
    const fixture = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: "00000000-0000-4000-8000-000000000099",
        actor_kind: "user",
      }],
    ]);
    const result = await fixture.repository.begin({
      request,
      authorizationDigest: AUTHORIZATION,
      challengeId: challenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });

    expect(result).toEqual({ status: "stale_state" });
    expect(
      fixture.connection.queries.some((query) =>
        query.statement.includes("INSERT INTO")
      ),
    ).toBe(false);
  });

  test("never reopens first bootstrap after all active devices are lost", async () => {
    const fixture = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        initial_installation_lineage_digest: LINEAGE,
        state: "recovery_required",
        ever_initialized: true,
        revision: 12,
      }],
    ]);

    expect(await fixture.repository.begin({
      request: {
        ...request,
        deviceId: "device_illegal_rebootstrap",
        idempotencyKey: "bootstrap_illegal_rebootstrap",
      },
      authorizationDigest: AUTHORIZATION,
      challengeId: challenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    })).toEqual({ status: "already_initialized" });
    expect(fixture.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO")
    )).toBe(false);
  });

  test("binds a pending-invite bootstrap to the exact unresolved membership operation", async () => {
    const authority = pendingInviteAuthority();
    const fixture = await repositoryWithResults([
      [],
      [],
      [authority],
      [],
      [authority],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    expect(await fixture.repository.begin({
      request: pendingInviteRequest,
      authorizationDigest: AUTHORIZATION,
      challengeId: pendingInviteChallenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: pendingInviteChallenge.issuedAt,
      expiresAt: pendingInviteChallenge.expiresAt,
    })).toMatchObject({ status: "created" });

    const transactionQueries = fixture.connection.queries.slice(1);
    expect(
      transactionQueries.filter(({ statement, parameters }) =>
        statement.includes("FROM crypto_delivery_operations o")
        && statement.includes("crypto_human_membership_transitions")
        && parameters.includes(INVITE_OPERATION_ID)
      ),
    ).toHaveLength(2);
    expect(transactionQueries.some(({ statement, parameters }) =>
      statement.includes("bootstrap_authority_id")
      && parameters.includes(INVITE_OPERATION_ID)
    )).toBe(true);
    expect(transactionQueries.some(({ statement, parameters }) =>
      statement.includes("pg_advisory_xact_lock")
      && parameters[0] === INVITE_NAMESPACE_ID
    )).toBe(true);
  });

  test("rejects pending-invite authority substitution before creating custody", async () => {
    const wrongAuthority = pendingInviteAuthority({
      target_human_actor_id:
        "00000000-0000-4000-8000-000000000099",
    });
    const fixture = await repositoryWithResults([
      [],
      [],
      [wrongAuthority],
      [],
      [wrongAuthority],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
    ]);

    expect(await fixture.repository.begin({
      request: pendingInviteRequest,
      authorizationDigest: AUTHORIZATION,
      challengeId: pendingInviteChallenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: pendingInviteChallenge.issuedAt,
      expiresAt: pendingInviteChallenge.expiresAt,
    })).toEqual({ status: "stale_state" });
    expect(fixture.connection.queries.some(({ statement }) =>
      statement.includes("INSERT INTO human_crypto_custodies")
    )).toBe(false);
  });

  test("replays the exact invite bootstrap after its membership operation progresses", async () => {
    const progressed = pendingInviteAuthority({
      operation_state: "preparing_domain",
      target_human_id: ACTOR_ID,
      target_device_id: pendingInviteRequest.deviceId,
      bootstrap_device_id: pendingInviteRequest.deviceId,
    });
    const idempotent = {
      bootstrap_context: pendingInviteRequest.context.kind,
      bootstrap_authority_id: INVITE_OPERATION_ID,
      human_id: ACTOR_ID,
      user_id: USER_ID,
      human_actor_id: ACTOR_ID,
      installation_lineage_digest: LINEAGE,
      authorization_digest: AUTHORIZATION,
      pending_device_id: pendingInviteRequest.deviceId,
      signing_public_key_digest: SIGNING_DIGEST,
      encryption_public_key_digest: ENCRYPTION_DIGEST,
      recovery_public_key_digest: RECOVERY_DIGEST,
      idempotency_key: pendingInviteRequest.idempotencyKey,
      challenge_id: pendingInviteChallenge.challengeId,
      issued_at_ms: pendingInviteChallenge.issuedAt,
      expires_at_ms: pendingInviteChallenge.expiresAt,
      client_kind: pendingInviteRequest.clientKind,
      device_lineage_digest: LINEAGE,
      signing_public_key: SIGNING_KEY,
      encryption_public_key: ENCRYPTION_KEY,
      public_fingerprint: FINGERPRINT,
    };
    const fixture = await repositoryWithResults([
      [],
      [],
      [progressed],
      [],
      [progressed],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [idempotent],
    ]);

    expect(await fixture.repository.begin({
      request: pendingInviteRequest,
      authorizationDigest: AUTHORIZATION,
      challengeId: pendingInviteChallenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: pendingInviteChallenge.issuedAt,
      expiresAt: pendingInviteChallenge.expiresAt,
    })).toEqual({
      status: "duplicate",
      challengeId: pendingInviteChallenge.challengeId,
      issuedAt: pendingInviteChallenge.issuedAt,
      expiresAt: pendingInviteChallenge.expiresAt,
    });
  });

  test("retires an expired attempt before creating a replacement challenge", async () => {
    const oldChallengeId = `bootstrap_${"22".repeat(32)}`;
    const fixture = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        initial_installation_lineage_digest: LINEAGE,
        state: "initializing",
        ever_initialized: false,
        revision: 0,
      }],
      [{
        challenge_id: oldChallengeId,
        pending_device_id: "device_expired",
        bootstrap_context: request.context.kind,
        bootstrap_authority_id: request.context.authorityId,
        expires_at_ms: 9_999,
        revision: 0,
      }],
      [{ challenge_id: oldChallengeId }],
      [{ device_id: "device_expired" }],
      [{ operation_id: `operation_${oldChallengeId}` }],
      [],
      [],
      [],
      [],
    ]);

    expect(await fixture.repository.begin({
      request: {
        ...request,
        deviceId: "device_alice_browser_retry",
        idempotencyKey: "bootstrap_alice_retry",
      },
      authorizationDigest: AUTHORIZATION,
      challengeId: challenge.challengeId,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    })).toMatchObject({ status: "created" });

    const transactionSql = fixture.connection.queries
      .slice(1)
      .map((query) => query.statement)
      .join("\n")
      .replaceAll('"', "")
      .toLowerCase();
    expect(transactionSql).toContain(
      "terminal_result_code = 'challenge_expired'",
    );
    expect(transactionSql).toContain("set state = 'rejected'");
    expect(transactionSql).toContain("failure_code = 'challenge_expired'");
    expect(transactionSql).not.toContain(
      "INSERT INTO human_crypto_custodies",
    );
  });

  test("activates device, custody, recovery, operation, and outbox in one transaction", async () => {
    const bootstrapRow = {
      challenge_id: challenge.challengeId,
      challenge_hash: CHALLENGE_HASH,
      bootstrap_context: request.context.kind,
      bootstrap_authority_id: request.context.authorityId,
      human_id: ACTOR_ID,
      user_id: USER_ID,
      human_actor_id: ACTOR_ID,
      installation_lineage_digest: LINEAGE,
      authorization_digest: AUTHORIZATION,
      pending_device_id: request.deviceId,
      signing_public_key_digest: SIGNING_DIGEST,
      encryption_public_key_digest: ENCRYPTION_DIGEST,
      recovery_public_key_digest: RECOVERY_DIGEST,
      idempotency_key: request.idempotencyKey,
      issued_at_ms: challenge.issuedAt,
      expires_at_ms: challenge.expiresAt,
      consumed_at_ms: null,
      invalidated: false,
      terminal_result_code: null,
      receipt_audit_ref: null,
      challenge_revision: 0,
      client_kind: request.clientKind,
      device_lineage_digest: LINEAGE,
      signing_public_key: SIGNING_KEY,
      encryption_public_key: ENCRYPTION_KEY,
      public_fingerprint: FINGERPRINT,
      device_state: "pending",
      authorization_evidence_digest: AUTHORIZATION,
      device_revision: 0,
      custody_state: "initializing",
      ever_initialized: false,
      current_recovery_generation: null,
      current_recovery_public_key_digest: null,
      custody_revision: 0,
      operation_state: "awaiting_target_device",
    };
    const fixture = await repositoryWithResults([
      [],
      [],
      [],
      [bootstrapRow],
      [],
      [],
      [],
      [],
      [{ device_id: request.deviceId }],
      [{ human_id: ACTOR_ID }],
      [{ challenge_id: challenge.challengeId }],
      [{ operation_id: `operation_${challenge.challengeId}` }],
      [],
    ]);
    const archiveHash = new Uint8Array(32).fill(0xd1);
    const result = await fixture.repository.complete({
      challenge,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      recoveryArchiveHash: archiveHash,
      recoveryArchiveBytes: new Uint8Array([1, 2, 3]),
      auditRef: "bootstrap_audit_1",
      committedAt: 20_000,
    });

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        deviceRevision: 1,
        custodyRevision: 1,
        recoveryGeneration: 1,
      },
    });
    expect(fixture.connection.transactionCount).toBe(1);
    const transactionSql = fixture.connection.queries
      .slice(1)
      .map((query) => query.statement)
      .join("\n")
      .replaceAll('"', "")
      .toLowerCase();
    for (const fragment of [
      "INSERT INTO human_crypto_recovery_keys",
      "INSERT INTO human_crypto_recovery_archives",
      "UPDATE human_crypto_devices",
      "UPDATE human_crypto_custodies",
      "UPDATE human_crypto_device_challenges",
      "UPDATE crypto_delivery_operations",
      "INSERT INTO crypto_operation_outbox",
    ]) {
      expect(transactionSql).toContain(fragment.toLowerCase());
    }
  });

  test("atomically advances every pending invite for the first activated Human device", async () => {
    const authority = pendingInviteAuthority();
    const bootstrapRow = {
      challenge_id: pendingInviteChallenge.challengeId,
      challenge_hash: CHALLENGE_HASH,
      bootstrap_context: pendingInviteRequest.context.kind,
      bootstrap_authority_id: INVITE_OPERATION_ID,
      human_id: ACTOR_ID,
      user_id: USER_ID,
      human_actor_id: ACTOR_ID,
      installation_lineage_digest: LINEAGE,
      authorization_digest: AUTHORIZATION,
      pending_device_id: pendingInviteRequest.deviceId,
      signing_public_key_digest: SIGNING_DIGEST,
      encryption_public_key_digest: ENCRYPTION_DIGEST,
      recovery_public_key_digest: RECOVERY_DIGEST,
      idempotency_key: pendingInviteRequest.idempotencyKey,
      issued_at_ms: pendingInviteChallenge.issuedAt,
      expires_at_ms: pendingInviteChallenge.expiresAt,
      consumed_at_ms: null,
      invalidated: false,
      terminal_result_code: null,
      receipt_audit_ref: null,
      challenge_revision: 0,
      client_kind: pendingInviteRequest.clientKind,
      device_lineage_digest: LINEAGE,
      signing_public_key: SIGNING_KEY,
      encryption_public_key: ENCRYPTION_KEY,
      public_fingerprint: FINGERPRINT,
      device_state: "pending",
      authorization_evidence_digest: AUTHORIZATION,
      device_revision: 0,
      custody_state: "initializing",
      ever_initialized: false,
      current_recovery_generation: null,
      current_recovery_public_key_digest: null,
      custody_revision: 0,
      operation_state: "awaiting_target_device",
    };
    const fixture = await repositoryWithResults([
      [],
      [],
      [],
      [authority],
      [],
      [authority],
      [bootstrapRow],
      [],
      [],
      [],
      [],
      [{ device_id: pendingInviteRequest.deviceId }],
      [{ human_id: ACTOR_ID }],
      [
        { operation_id: INVITE_OPERATION_ID },
        { operation_id: SIBLING_INVITE_OPERATION_ID },
      ],
      [
        { operation_id: INVITE_OPERATION_ID },
        { operation_id: SIBLING_INVITE_OPERATION_ID },
      ],
      [{ challenge_id: pendingInviteChallenge.challengeId }],
      [{ operation_id: `operation_${pendingInviteChallenge.challengeId}` }],
      [],
    ]);

    const result = await fixture.repository.complete({
      challenge: pendingInviteChallenge,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
      recoveryPublicKeyDigest: RECOVERY_DIGEST,
      recoveryArchiveHash: new Uint8Array(32).fill(0xd1),
      recoveryArchiveBytes: new Uint8Array([1, 2, 3]),
      auditRef: "audit_pending_invite_bootstrap",
      committedAt: 20_000,
    });

    expect(result).toMatchObject({ status: "applied" });
    const membershipUpdate = fixture.connection.queries.find(({ statement }) =>
      statement.includes(
        "UPDATE crypto_human_membership_transitions AS membership",
      )
    );
    expect(membershipUpdate?.statement).toContain(
      "SET bootstrap_device_id = $1",
    );
    expect(membershipUpdate?.statement).toContain(
      "FROM crypto_delivery_operations AS operation",
    );
    expect(membershipUpdate?.statement).toContain(
      "membership.target_human_actor_id = $2::uuid",
    );
    expect(membershipUpdate?.statement).not.toContain(
      "membership.operation_id = $",
    );
    expect(membershipUpdate?.parameters).toEqual([
      pendingInviteRequest.deviceId,
      ACTOR_ID,
      new Date(20_000).toISOString(),
    ]);

    const operationUpdate = fixture.connection.queries.find(({ statement }) =>
      statement.includes(
        "UPDATE crypto_delivery_operations AS operation",
      )
    );
    expect(operationUpdate?.statement).toContain(
      "SET state = 'preparing_domain'",
    );
    expect(operationUpdate?.statement).toContain("target_device_id = $1");
    expect(operationUpdate?.statement).toContain(
      "operation.deadline_at > $3::timestamptz",
    );
    expect(operationUpdate?.statement).not.toContain(
      "operation.operation_id = $",
    );
    expect(operationUpdate?.parameters).toEqual([
      pendingInviteRequest.deviceId,
      ACTOR_ID,
      new Date(20_000).toISOString(),
    ]);
  });
});
