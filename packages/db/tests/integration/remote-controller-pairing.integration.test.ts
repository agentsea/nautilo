import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  ensureDatabase,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let connection: ReturnType<typeof postgres>;
const fixtureUserIds = new Set<string>();

interface Fixture {
  userId: string;
  actorId: string;
  relayTokenId: string;
  controllerInstallationId: string;
  hostInstallationId: string;
  serverInstanceId: string;
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const fixture: Fixture = {
    userId: randomUUID(),
    actorId: randomUUID(),
    relayTokenId: randomUUID(),
    controllerInstallationId: randomUUID(),
    hostInstallationId: randomUUID(),
    serverInstanceId: randomUUID(),
  };
  fixtureUserIds.add(fixture.userId);
  await connection`
    INSERT INTO users (id, name, email, handle)
    VALUES (${fixture.userId}, ${`D458 ${suffix}`}, ${`d458-${suffix}@test.local`}, ${`d458-${suffix}`})
  `;
  await connection`
    INSERT INTO actors (id, owner_id, display_name, kind)
    VALUES (${fixture.actorId}, ${fixture.userId}, 'D458 controller', 'user')
  `;
  await connection`
    INSERT INTO relay_tokens (id, user_id, actor_id, token_hash, label, capabilities, installation_id)
    VALUES (
      ${fixture.relayTokenId}, ${fixture.userId}, ${fixture.actorId},
      ${`d458-token-${suffix}`}, 'D458 host', '{}'::jsonb, ${fixture.hostInstallationId}
    )
  `;
  await connection`
    INSERT INTO remote_controller_installations (
      id, user_id, actor_id, server_instance_id, server_binding_generation,
      installation_id, proof_key_algorithm, proof_key, proof_key_fingerprint, label
    )
    VALUES (
      ${fixture.controllerInstallationId}, ${fixture.userId}, ${fixture.actorId},
      ${fixture.serverInstanceId}, 1, ${randomUUID()},
      'unselected', ${`public-${suffix}`}, ${`fingerprint-${suffix}`}, 'D458 mobile'
    )
  `;
  return fixture;
}

async function insertChallenge(
  fixture: Fixture,
  options: {
    expiresAt?: Date;
    consumedAt?: Date | null;
    revokedAt?: Date | null;
    serverBindingGeneration?: number;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await connection`
    INSERT INTO remote_pairing_challenges (
      id, server_instance_id, server_binding_generation, user_id, actor_id, relay_token_id,
      host_installation_id, desktop_session_id, pairing_generation,
      qr_verifier_digest, expires_at, consumed_at, revoked_at
    ) VALUES (
      ${id}, ${fixture.serverInstanceId}, ${options.serverBindingGeneration ?? 1}, ${fixture.userId}, ${fixture.actorId},
      ${fixture.relayTokenId}, ${fixture.hostInstallationId}, 'desktop-session',
      ${fixture.relayTokenId}, ${`digest-${id}`},
      ${options.expiresAt ?? new Date(Date.now() + 60_000)},
      ${options.consumedAt ?? null}, ${options.revokedAt ?? null}
    )
  `;
  return id;
}

async function recordFailedVerifierAttempt(challengeId: string): Promise<void> {
  const now = new Date();
  await connection`
    UPDATE remote_pairing_challenges
    SET
      failed_attempts = failed_attempts + 1,
      revoked_at = CASE WHEN failed_attempts + 1 >= 5 THEN ${now} ELSE revoked_at END
    WHERE id = ${challengeId}
      AND version = 1
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ${now}
      AND failed_attempts < 5
  `;
}

/** Mirrors the store's one-time CAS + revoke-old + insert-replacement unit. */
async function consumeAndBind(
  fixture: Fixture,
  challengeId: string,
): Promise<"committed" | "conflict"> {
  return connection.begin(async (tx) => {
    const now = new Date();
    const consumed = await tx<{ id: string }[]>`
      UPDATE remote_pairing_challenges
      SET consumed_at = ${now}
      WHERE id = ${challengeId}
        AND version = 1
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${now}
        AND server_instance_id = ${fixture.serverInstanceId}
        AND server_binding_generation = 1
        AND user_id = ${fixture.userId}
        AND actor_id = ${fixture.actorId}
        AND relay_token_id = ${fixture.relayTokenId}
        AND host_installation_id = ${fixture.hostInstallationId}
        AND desktop_session_id = 'desktop-session'
        AND pairing_generation = ${fixture.relayTokenId}
        AND failed_attempts < 5
      RETURNING id
    `;
    if (consumed.length !== 1) return "conflict";
    await tx`
      UPDATE remote_controller_bindings
      SET revoked_at = ${now}
      WHERE controller_installation_id = ${fixture.controllerInstallationId}
        AND revoked_at IS NULL
    `;
    await tx`
      INSERT INTO remote_controller_bindings (
        server_instance_id, server_binding_generation, controller_installation_id, installation_generation,
        user_id, actor_id, relay_token_id, host_installation_id,
        desktop_session_id, pairing_generation, challenge_id
      ) VALUES (
        ${fixture.serverInstanceId}, 1, ${fixture.controllerInstallationId}, 1,
        ${fixture.userId}, ${fixture.actorId}, ${fixture.relayTokenId},
        ${fixture.hostInstallationId}, 'desktop-session', ${fixture.relayTokenId},
        ${challengeId}
      )
    `;
    return "committed";
  });
}

describe("D458 remote-controller pairing schema", () => {
  beforeAll(async () => {
    // This bootstraps only the disposable `test-cruft` instance; it never uses
    // the operator's default database.
    bootstrapTestDbInstance();
    await ensureDatabase();
    connection = postgres(resolveDirectDatabaseConnectionString(), { max: 4 });
  });

  afterEach(async () => {
    for (const userId of fixtureUserIds) {
      await connection`DELETE FROM users WHERE id = ${userId}`;
    }
    fixtureUserIds.clear();
  });

  afterAll(async () => {
    await connection?.end({ timeout: 5 });
  });

  test("migrates all durable pairing tables and the identity columns", async () => {
    const rows = await connection<{ name: string }[]>`
      SELECT relname AS name
      FROM pg_class
      WHERE relkind = 'r'
        AND relname IN (
          'remote_controller_installations',
          'remote_pairing_challenges',
          'remote_controller_bindings'
        )
      ORDER BY relname
    `;
    expect(rows.map((row) => row.name)).toEqual([
      "remote_controller_bindings",
      "remote_controller_installations",
      "remote_pairing_challenges",
    ]);

    const identityColumns = await connection<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'nautilo_instance_identity'
        AND column_name IN ('server_instance_id', 'server_binding_generation')
      ORDER BY column_name
    `;
    expect(identityColumns.map((row) => row.column_name)).toEqual([
      "server_binding_generation",
      "server_instance_id",
    ]);
  });

  test("CAS consumes once, revokes the old binding, and leaves one active binding", async () => {
    const fixture = await createFixture();
    const first = await insertChallenge(fixture);
    const replacement = await insertChallenge(fixture);

    expect(await consumeAndBind(fixture, first)).toBe("committed");
    expect(await consumeAndBind(fixture, first)).toBe("conflict");
    expect(await consumeAndBind(fixture, replacement)).toBe("committed");

    const bindings = await connection<{ challenge_id: string; revoked_at: Date | null }[]>`
      SELECT challenge_id, revoked_at
      FROM remote_controller_bindings
      WHERE controller_installation_id = ${fixture.controllerInstallationId}
      ORDER BY created_at, challenge_id
    `;
    expect(bindings).toHaveLength(2);
    expect(bindings.filter((binding) => binding.revoked_at === null)).toHaveLength(1);
    expect(bindings.find((binding) => binding.challenge_id === first)?.revoked_at).not.toBeNull();
    expect(bindings.find((binding) => binding.challenge_id === replacement)?.revoked_at).toBeNull();
  });

  test("partial uniqueness is per controller and desktop enrollment", async () => {
    const fixture = await createFixture();
    const first = await insertChallenge(fixture, { consumedAt: new Date() });
    const second = await insertChallenge(fixture, { consumedAt: new Date() });
    await connection`
      INSERT INTO remote_controller_bindings (
        server_instance_id, server_binding_generation, controller_installation_id, installation_generation,
        user_id, actor_id, relay_token_id, host_installation_id,
        desktop_session_id, pairing_generation, challenge_id
      ) VALUES (
        ${fixture.serverInstanceId}, 1, ${fixture.controllerInstallationId}, 1, ${fixture.userId},
        ${fixture.actorId}, ${fixture.relayTokenId}, ${fixture.hostInstallationId},
        'desktop-session', ${fixture.relayTokenId}, ${first}
      )
    `;
    const suppressed = await connection<{ id: string }[]>`
      INSERT INTO remote_controller_bindings (
        server_instance_id, server_binding_generation, controller_installation_id, installation_generation,
        user_id, actor_id, relay_token_id, host_installation_id,
        desktop_session_id, pairing_generation, challenge_id
      ) VALUES (
        ${fixture.serverInstanceId}, 1, ${fixture.controllerInstallationId}, 1, ${fixture.userId},
        ${fixture.actorId}, ${fixture.relayTokenId}, ${fixture.hostInstallationId},
        'desktop-session', ${fixture.relayTokenId}, ${second}
      )
      ON CONFLICT (controller_installation_id, relay_token_id)
        WHERE revoked_at IS NULL DO NOTHING
      RETURNING id
    `;
    expect(suppressed).toHaveLength(0);

    const secondRelayTokenId = randomUUID();
    const secondHostInstallationId = randomUUID();
    const third = await insertChallenge(fixture, { consumedAt: new Date() });
    await connection`
      INSERT INTO relay_tokens (id, user_id, actor_id, token_hash, label, capabilities, installation_id)
      VALUES (
        ${secondRelayTokenId}, ${fixture.userId}, ${fixture.actorId}, ${`d458-second-${randomUUID()}`},
        'D458 second host', '{}'::jsonb, ${secondHostInstallationId}
      )
    `;
    await connection`
      UPDATE remote_pairing_challenges
      SET relay_token_id = ${secondRelayTokenId},
          pairing_generation = ${secondRelayTokenId},
          host_installation_id = ${secondHostInstallationId}
      WHERE id = ${third}
    `;
    const inserted = await connection<{ id: string }[]>`
      INSERT INTO remote_controller_bindings (
        server_instance_id, server_binding_generation, controller_installation_id, installation_generation,
        user_id, actor_id, relay_token_id, host_installation_id,
        desktop_session_id, pairing_generation, challenge_id
      ) VALUES (
        ${fixture.serverInstanceId}, 1, ${fixture.controllerInstallationId}, 1, ${fixture.userId},
        ${fixture.actorId}, ${secondRelayTokenId}, ${secondHostInstallationId},
        'desktop-session-2', ${secondRelayTokenId}, ${third}
      )
      RETURNING id
    `;
    expect(inserted).toHaveLength(1);
  });

  test("five concurrent failed verifier attempts revoke atomically and block the sixth/consume", async () => {
    const fixture = await createFixture();
    const challenge = await insertChallenge(fixture);
    await Promise.all(
      Array.from({ length: 6 }, () => recordFailedVerifierAttempt(challenge)),
    );
    const rows = await connection<{ failed_attempts: number; revoked_at: Date | null }[]>`
      SELECT failed_attempts, revoked_at
      FROM remote_pairing_challenges
      WHERE id = ${challenge}
    `;
    expect(rows[0]).toMatchObject({ failed_attempts: 5 });
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(await consumeAndBind(fixture, challenge)).toBe("conflict");
  });

  test("a challenge from an old server binding generation cannot consume", async () => {
    const fixture = await createFixture();
    const oldGeneration = await insertChallenge(fixture, {
      serverBindingGeneration: 0,
    });
    expect(await consumeAndBind(fixture, oldGeneration)).toBe("conflict");
    const row = await connection<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM remote_pairing_challenges WHERE id = ${oldGeneration}
    `;
    expect(row[0]?.consumed_at).toBeNull();
  });

  test("a binding-insert failure rolls back the challenge consume", async () => {
    const fixture = await createFixture();
    const challenge = await insertChallenge(fixture);
    const now = new Date();
    let rejectionCode: string | undefined;
    try {
      await Promise.resolve(connection.begin(async (tx) => {
        await tx`
          UPDATE remote_pairing_challenges
          SET consumed_at = ${now}
          WHERE id = ${challenge}
            AND version = 1
            AND consumed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > ${now}
            AND failed_attempts < 5
        `;
        await tx`
          INSERT INTO remote_controller_bindings (
            server_instance_id, server_binding_generation, controller_installation_id,
            installation_generation, user_id, actor_id, relay_token_id,
            host_installation_id, desktop_session_id, pairing_generation, challenge_id
          ) VALUES (
            ${fixture.serverInstanceId}, 1, ${randomUUID()}, 1,
            ${fixture.userId}, ${fixture.actorId}, ${fixture.relayTokenId},
            ${fixture.hostInstallationId}, 'desktop-session', ${fixture.relayTokenId}, ${challenge}
          )
        `;
      }));
    } catch (error) {
      rejectionCode = (error as { code?: string }).code;
    }
    expect(rejectionCode).toBe("23503");
    const state = await connection<{ consumed_at: Date | null; count: string }[]>`
      SELECT challenge.consumed_at, COUNT(binding.id)::text AS count
      FROM remote_pairing_challenges AS challenge
      LEFT JOIN remote_controller_bindings AS binding ON binding.challenge_id = challenge.id
      WHERE challenge.id = ${challenge}
      GROUP BY challenge.consumed_at
    `;
    expect(state[0]).toMatchObject({ consumed_at: null, count: "0" });
  });

  test("expired or revoked challenges cannot consume, and cleanup keeps consumed/future rows", async () => {
    const fixture = await createFixture();
    const past = new Date(Date.now() - 60_000);
    const expired = await insertChallenge(fixture, { expiresAt: past });
    const revoked = await insertChallenge(fixture, { revokedAt: new Date() });
    const consumed = await insertChallenge(fixture, { expiresAt: past, consumedAt: new Date() });
    const future = await insertChallenge(fixture);

    expect(await consumeAndBind(fixture, expired)).toBe("conflict");
    expect(await consumeAndBind(fixture, revoked)).toBe("conflict");

    const removed = await connection<{ id: string }[]>`
      DELETE FROM remote_pairing_challenges
      WHERE expires_at < ${new Date()}
        AND consumed_at IS NULL
      RETURNING id
    `;
    expect(removed.map((row) => row.id)).toEqual([expired]);
    const remaining = await connection<{ id: string }[]>`
      SELECT id FROM remote_pairing_challenges
      WHERE id IN (${consumed}, ${future})
      ORDER BY id
    `;
    expect(remaining.map((row) => row.id).sort()).toEqual([consumed, future].sort());
  });

  test("user-scoped revoke cannot mutate another controller binding", async () => {
    const owner = await createFixture();
    const other = await createFixture();
    const ownerChallenge = await insertChallenge(owner);
    expect(await consumeAndBind(owner, ownerChallenge)).toBe("committed");

    const attempted = await connection<{ id: string }[]>`
      UPDATE remote_controller_bindings
      SET revoked_at = ${new Date()}
      WHERE challenge_id = ${ownerChallenge}
        AND user_id = ${other.userId}
        AND revoked_at IS NULL
      RETURNING id
    `;
    expect(attempted).toHaveLength(0);
    const after = await connection<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM remote_controller_bindings WHERE challenge_id = ${ownerChallenge}
    `;
    expect(after[0]?.revoked_at).toBeNull();
  });
});
