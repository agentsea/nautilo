import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  __resetSharedDirectDbForTests,
  ensureDatabase,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  getRemotePairingStore,
  type ConsumeChallengeEnsureInstallationInput,
} from "../../src/remote-control/pairing-store";
import { getRelayTokenStore } from "../../src/lib/relay-token-store";
import { getOrdinaryAdmissionStore } from "../../src/remote-control/ordinary-admission-store";

let connection: ReturnType<typeof postgres>;
const fixtureUsers = new Set<string>();
let previousAppConnection: string | undefined;

interface Fixture {
  userId: string;
  actorId: string;
  relayTokenId: string;
  tokenHash: string;
  hostInstallationId: string;
  serverInstanceId: string;
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const fixture: Fixture = {
    userId: randomUUID(),
    actorId: randomUUID(),
    relayTokenId: randomUUID(),
    tokenHash: `d458-server-token-${suffix}`,
    hostInstallationId: randomUUID(),
    serverInstanceId: randomUUID(),
  };
  fixtureUsers.add(fixture.userId);
  await connection`
    INSERT INTO users (id, name, email, handle)
    VALUES (${fixture.userId}, ${`D458 server ${suffix}`}, ${`d458-server-${suffix}@test.local`}, ${`d458-server-${suffix}`})
  `;
  await connection`
    INSERT INTO actors (id, owner_id, display_name, kind)
    VALUES (${fixture.actorId}, ${fixture.userId}, 'D458 server controller', 'user')
  `;
  await connection`
    INSERT INTO relay_tokens (id, user_id, actor_id, token_hash, label, capabilities, installation_id)
    VALUES (
      ${fixture.relayTokenId}, ${fixture.userId}, ${fixture.actorId}, ${fixture.tokenHash},
      'D458 paired Mac', '{"profile":"desktop-agent","canControlDesktop":true}'::jsonb,
      ${fixture.hostInstallationId}
    )
  `;
  return fixture;
}

async function createAdditionalHost(fixture: Fixture): Promise<Fixture> {
  const relayTokenId = randomUUID();
  const hostInstallationId = randomUUID();
  await connection`
    INSERT INTO relay_tokens (id, user_id, actor_id, token_hash, label, capabilities, installation_id)
    VALUES (
      ${relayTokenId}, ${fixture.userId}, ${fixture.actorId}, ${`d458-second-host-${randomUUID()}`},
      'D458 second paired Mac', '{"profile":"desktop-agent","canRunShell":true}'::jsonb,
      ${hostInstallationId}
    )
  `;
  return { ...fixture, relayTokenId, hostInstallationId };
}

async function relayAuthorityState(fixture: Fixture, challengeId: string, bindingId?: string) {
  const [relay] = await connection<{ revoked_at: Date | null }[]>`
    SELECT revoked_at FROM relay_tokens WHERE id = ${fixture.relayTokenId}
  `;
  const [challenge] = await connection<{ revoked_at: Date | null; consumed_at: Date | null }[]>`
    SELECT revoked_at, consumed_at FROM remote_pairing_challenges WHERE id = ${challengeId}
  `;
  const [binding] = bindingId
    ? await connection<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM remote_controller_bindings WHERE id = ${bindingId}
      `
    : [];
  return { relay, challenge, binding };
}

async function insertChallenge(fixture: Fixture): Promise<string> {
  const challengeId = randomUUID();
  await connection`
    INSERT INTO remote_pairing_challenges (
      id, server_instance_id, server_binding_generation, user_id, actor_id,
      relay_token_id, host_installation_id, desktop_session_id, pairing_generation,
      qr_verifier_digest, expires_at
    ) VALUES (
      ${challengeId}, ${fixture.serverInstanceId}, 1, ${fixture.userId}, ${fixture.actorId},
      ${fixture.relayTokenId}, ${fixture.hostInstallationId}, 'desktop-session', ${fixture.relayTokenId},
      'digest', ${new Date(Date.now() + 60_000)}
    )
  `;
  return challengeId;
}

function atomicInput(fixture: Fixture, challengeId: string, installationId = randomUUID()): ConsumeChallengeEnsureInstallationInput {
  return {
    challengeId,
    expectedVersion: 1,
    consumedAt: new Date(),
    serverInstanceId: fixture.serverInstanceId,
    serverBindingGeneration: 1,
    userId: fixture.userId,
    actorId: fixture.actorId,
    relayTokenId: fixture.relayTokenId,
    hostInstallationId: fixture.hostInstallationId,
    desktopSessionId: "desktop-session",
    pairingGeneration: fixture.relayTokenId,
    controller: {
      userId: fixture.userId,
      actorId: fixture.actorId,
      serverInstanceId: fixture.serverInstanceId,
      serverBindingGeneration: 1,
      installationId,
      proofKeyAlgorithm: "Ed25519",
      proofKey: `public-${installationId}`,
      proofKeyFingerprint: `fingerprint-${installationId}`,
    },
  };
}

describe("D458 remote pairing store against disposable Postgres", () => {
  beforeAll(async () => {
    // This is the isolated, disposable test-cruft instance—not the operator's
    // live default DB. The guard runs before any schema or fixture mutation.
    bootstrapTestDbInstance();
    await ensureDatabase();
    // `ensureDatabase()` may have used the shared handle while applying
    // migrations. Reopen it after the test-cruft guard has normalized env so
    // the store cannot inherit an earlier worktree/default target.
    previousAppConnection = process.env["DB_CONNECTION_STRING"];
    const testCruftDirectConnection = resolveDirectDatabaseConnectionString();
    process.env["DB_CONNECTION_STRING"] = testCruftDirectConnection;
    await __resetSharedDirectDbForTests();
    connection = postgres(testCruftDirectConnection, { max: 4 });
  });

  afterEach(async () => {
    for (const userId of fixtureUsers) await connection`DELETE FROM users WHERE id = ${userId}`;
    fixtureUsers.clear();
  });

  afterAll(async () => {
    await connection?.end({ timeout: 5 });
    await __resetSharedDirectDbForTests();
    if (previousAppConnection === undefined) delete process.env["DB_CONNECTION_STRING"];
    else process.env["DB_CONNECTION_STRING"] = previousAppConnection;
  });

  test("one exact active durable tuple projects; revoked and generation-mismatched tuples do not", async () => {
    const fixture = await createFixture();
    const challenge = await insertChallenge(fixture);
    const committed = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(fixture, challenge));
    expect(committed.outcome).toBe("committed");

    const store = getRemotePairingStore();
    const exact = await store.listPairedHostRowsForUser({
      userId: fixture.userId,
      serverInstanceId: fixture.serverInstanceId,
      serverBindingGeneration: 1,
    });
    expect(exact).toHaveLength(1);
    expect(exact[0]).toMatchObject({ pairingGeneration: fixture.relayTokenId, label: "D458 paired Mac" });
    const scoped = await store.listPairedHostRowsForController({
      userId: fixture.userId,
      actorId: fixture.actorId,
      controllerInstallationId: committed.controllerInstallationId!,
      installationGeneration: committed.installationGeneration!,
      serverInstanceId: fixture.serverInstanceId,
      serverBindingGeneration: 1,
    });
    expect(scoped.rows).toHaveLength(1);
    expect(await store.listPairedHostRowsForUser({
      userId: fixture.userId,
      serverInstanceId: fixture.serverInstanceId,
      serverBindingGeneration: 2,
    })).toEqual([]);

    await connection`UPDATE relay_tokens SET revoked_at = now() WHERE id = ${fixture.relayTokenId}`;
    expect(await store.listPairedHostRowsForUser({
      userId: fixture.userId,
      serverInstanceId: fixture.serverInstanceId,
      serverBindingGeneration: 1,
    })).toEqual([]);
  });

  test("re-pairing the same phone to the same Mac refreshes one logical binding", async () => {
    const fixture = await createFixture();
    const installationId = randomUUID();
    const firstChallenge = await insertChallenge(fixture);
    const first = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(fixture, firstChallenge, installationId),
      );
    expect(first.outcome).toBe("committed");
    if (!first.bindingId || !first.controllerInstallationId) {
      throw new Error("first pairing did not return durable authority ids");
    }
    const firstBindingId = first.bindingId;
    const firstControllerInstallationId = first.controllerInstallationId;

    const secondChallenge = await insertChallenge(fixture);
    const second = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(fixture, secondChallenge, installationId),
      );
    expect(second).toMatchObject({
      outcome: "committed",
      bindingId: firstBindingId,
      controllerInstallationId: firstControllerInstallationId,
    });

    const [state] = await connection<{
      total: string;
      active: string;
      latest_challenge: string;
      consumed_challenges: string;
    }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE binding.revoked_at IS NULL)::text AS active,
        MAX(binding.challenge_id::text)::text AS latest_challenge,
        (
          SELECT COUNT(*)::text
          FROM remote_pairing_challenges AS challenge
          WHERE challenge.id IN (${firstChallenge}, ${secondChallenge})
            AND challenge.consumed_at IS NOT NULL
        ) AS consumed_challenges
      FROM remote_controller_bindings AS binding
      WHERE binding.controller_installation_id = ${firstControllerInstallationId}
    `;
    expect(state).toEqual({
      total: "1",
      active: "1",
      latest_challenge: secondChallenge,
      consumed_challenges: "2",
    });
  });

  test("one phone retains independent active bindings to two Mac enrollments", async () => {
    const firstHost = await createFixture();
    const secondHost = await createAdditionalHost(firstHost);
    const installationId = randomUUID();

    const first = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(firstHost, await insertChallenge(firstHost), installationId),
      );
    const second = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(secondHost, await insertChallenge(secondHost), installationId),
      );
    expect(first.outcome).toBe("committed");
    expect(second.outcome).toBe("committed");
    expect(second.controllerInstallationId).toBe(first.controllerInstallationId);

    const bindings = await connection<{
      relay_token_id: string;
      revoked_at: Date | null;
    }[]>`
      SELECT relay_token_id, revoked_at
      FROM remote_controller_bindings
      WHERE controller_installation_id = ${first.controllerInstallationId!}
      ORDER BY relay_token_id
    `;
    expect(bindings).toHaveLength(2);
    expect(bindings.every((binding) => binding.revoked_at === null)).toBe(true);
    expect(bindings.map((binding) => binding.relay_token_id).sort()).toEqual(
      [firstHost.relayTokenId, secondHost.relayTokenId].sort(),
    );

    const store = getRemotePairingStore();
    const origin = await store.findControllerOriginForOrdinaryRequest({
      installationId,
      userId: firstHost.userId,
      actorId: firstHost.actorId,
      serverInstanceId: firstHost.serverInstanceId,
      serverBindingGeneration: 1,
    });
    expect(origin).toMatchObject({
      controllerInstallationId: first.controllerInstallationId,
      installationId,
      installationGeneration: 1,
      serverInstanceId: firstHost.serverInstanceId,
      serverBindingGeneration: 1,
      userId: firstHost.userId,
      actorId: firstHost.actorId,
      proofKeyAlgorithm: "Ed25519",
      proofKey: `public-${installationId}`,
      revokedAt: null,
    });
    const requestId = randomUUID();
    const admission = {
      requestId,
      userId: firstHost.userId,
      actorId: firstHost.actorId,
      controllerInstallationId: first.controllerInstallationId!,
      installationGeneration: 1,
      bodySha256: "ab".repeat(32),
      admittedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await getOrdinaryAdmissionStore().admitOnce(admission)).toBe(true);
    expect(await getOrdinaryAdmissionStore().admitOnce(admission)).toBe(false);
    expect(await store.findControllerOriginForOrdinaryRequest({
      installationId,
      userId: randomUUID(),
      actorId: firstHost.actorId,
      serverInstanceId: firstHost.serverInstanceId,
      serverBindingGeneration: 1,
    })).toBeNull();

    expect(await store.revokeBindingForUser({
      bindingId: first.bindingId!,
      userId: firstHost.userId,
    })).toBe(true);
    expect(await store.findControllerOriginForOrdinaryRequest({
      installationId,
      userId: firstHost.userId,
      actorId: firstHost.actorId,
      serverInstanceId: firstHost.serverInstanceId,
      serverBindingGeneration: 1,
    })).not.toBeNull();

    expect(await store.revokeBindingForUser({
      bindingId: second.bindingId!,
      userId: firstHost.userId,
    })).toBe(true);
    expect(await store.findControllerOriginForOrdinaryRequest({
      installationId,
      userId: firstHost.userId,
      actorId: firstHost.actorId,
      serverInstanceId: firstHost.serverInstanceId,
      serverBindingGeneration: 1,
    })).toBeNull();
  });

  test("ordinary replay-receipt cleanup is bounded and leaves live receipts", async () => {
    const fixture = await createFixture();
    const committed = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(fixture, await insertChallenge(fixture)),
      );
    if (!committed.controllerInstallationId) throw new Error("missing controller installation");
    const store = getOrdinaryAdmissionStore();
    const base = {
      userId: fixture.userId,
      actorId: fixture.actorId,
      controllerInstallationId: committed.controllerInstallationId,
      installationGeneration: 1,
      bodySha256: "cd".repeat(32),
      admittedAt: new Date(Date.now() - 120_000),
    };
    for (let index = 0; index < 3; index += 1) {
      expect(await store.admitOnce({
        ...base,
        requestId: randomUUID(),
        expiresAt: new Date(Date.now() - 60_000),
      })).toBe(true);
    }
    const liveId = randomUUID();
    expect(await store.admitOnce({
      ...base,
      requestId: liveId,
      expiresAt: new Date(Date.now() + 60_000),
    })).toBe(true);
    expect(await store.cleanupExpired({ now: new Date(), limit: 2 })).toBe(2);
    expect(await store.cleanupExpired({ now: new Date(), limit: 2 })).toBe(1);
    expect(await store.admitOnce({
      ...base,
      requestId: liveId,
      expiresAt: new Date(Date.now() + 60_000),
    })).toBe(false);
  });

  test("a binding insert failure rolls back both challenge consume and newly-created controller installation", async () => {
    const fixture = await createFixture();
    const challenge = await insertChallenge(fixture);
    const existingInstallation = randomUUID();
    const existingController = randomUUID();
    await connection`
      INSERT INTO remote_controller_installations (
        id, user_id, actor_id, server_instance_id, server_binding_generation,
        installation_id, proof_key_algorithm, proof_key, proof_key_fingerprint
      ) VALUES (
        ${existingController}, ${fixture.userId}, ${fixture.actorId}, ${fixture.serverInstanceId}, 1,
        ${existingInstallation}, 'nautilo-public-key-v1', 'existing-public', 'existing-fingerprint'
      )
    `;
    // This intentionally violates the ceremony state machine only enough to
    // occupy the unique challenge id; the store's later insert must fail and
    // prove the preceding installation/challenge writes are transactional.
    await connection`
      INSERT INTO remote_controller_bindings (
        server_instance_id, server_binding_generation, controller_installation_id, installation_generation,
        user_id, actor_id, relay_token_id, host_installation_id, desktop_session_id, pairing_generation, challenge_id
      ) VALUES (
        ${fixture.serverInstanceId}, 1, ${existingController}, 1, ${fixture.userId}, ${fixture.actorId},
        ${fixture.relayTokenId}, ${fixture.hostInstallationId}, 'desktop-session', ${fixture.relayTokenId}, ${challenge}
      )
    `;
    const freshInstallation = randomUUID();
    let rejected = false;
    try {
      await (
      getRemotePairingStore().consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(fixture, challenge, freshInstallation),
      ));
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const [state] = await connection<{ consumed_at: Date | null; installations: string }[]>`
      SELECT challenge.consumed_at,
             COUNT(installation.id)::text AS installations
      FROM remote_pairing_challenges AS challenge
      LEFT JOIN remote_controller_installations AS installation
        ON installation.installation_id = ${freshInstallation}
      WHERE challenge.id = ${challenge}
      GROUP BY challenge.consumed_at
    `;
    expect(state).toMatchObject({ consumed_at: null, installations: "0" });
  });

  test("re-pair and explicit revoke atomically retire their relay generation authority", async () => {
    const fixture = await createFixture();
    const boundChallenge = await insertChallenge(fixture);
    const committed = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(fixture, boundChallenge));
    expect(committed.outcome).toBe("committed");
    const pendingChallenge = await insertChallenge(fixture);

    const replacement = await getRelayTokenStore().pairForInstallation({
      userId: fixture.userId,
      actorId: fixture.actorId,
      tokenHash: `replacement-${randomUUID()}`,
      label: "Replacement Mac",
      capabilities: {},
      installationId: fixture.hostInstallationId,
    });
    expect(replacement.revokedPairingGenerationIds).toEqual([fixture.relayTokenId]);
    const rePairState = await relayAuthorityState(fixture, pendingChallenge, committed.bindingId);
    expect(rePairState.relay?.revoked_at).toBeInstanceOf(Date);
    expect(rePairState.challenge?.consumed_at).toBeNull();
    expect(rePairState.challenge?.revoked_at).toBeInstanceOf(Date);
    expect(rePairState.binding?.revoked_at).toBeInstanceOf(Date);

    const explicit = await createFixture();
    const explicitChallenge = await insertChallenge(explicit);
    const explicitCommitted = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(explicit, explicitChallenge));
    expect(explicitCommitted.outcome).toBe("committed");
    const explicitPending = await insertChallenge(explicit);
    const revoked = await getRelayTokenStore().revokeWithGenerationsForUser?.({
      id: explicit.relayTokenId,
      userId: explicit.userId,
    });
    expect(revoked).toEqual({ revoked: true, revokedPairingGenerationIds: [explicit.relayTokenId] });
    const explicitState = await relayAuthorityState(explicit, explicitPending, explicitCommitted.bindingId);
    expect(explicitState.relay?.revoked_at).toBeInstanceOf(Date);
    expect(explicitState.challenge?.revoked_at).toBeInstanceOf(Date);
    expect(explicitState.binding?.revoked_at).toBeInstanceOf(Date);

    const silent = await createFixture();
    const silentChallenge = await insertChallenge(silent);
    const silentCommitted = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(silent, silentChallenge));
    expect(silentCommitted.outcome).toBe("committed");
    const silentPending = await insertChallenge(silent);
    expect(await getRelayTokenStore().revokeForUser({
      id: silent.relayTokenId,
      userId: silent.userId,
    })).toBe(true);
    const silentState = await relayAuthorityState(silent, silentPending, silentCommitted.bindingId);
    expect(silentState.relay?.revoked_at).toBeInstanceOf(Date);
    expect(silentState.challenge?.revoked_at).toBeInstanceOf(Date);
    expect(silentState.binding?.revoked_at).toBeInstanceOf(Date);
  });

  test("a challenge issued under a re-paired generation conflicts before it can bind", async () => {
    const fixture = await createFixture();
    const staleChallenge = await insertChallenge(fixture);
    await getRelayTokenStore().pairForInstallation({
      userId: fixture.userId,
      actorId: fixture.actorId,
      tokenHash: `replacement-${randomUUID()}`,
      label: "Replacement Mac",
      capabilities: {},
      installationId: fixture.hostInstallationId,
    });

    expect(await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(fixture, staleChallenge)))
      .toEqual({ outcome: "conflict" });
    const state = await relayAuthorityState(fixture, staleChallenge);
    expect(state.challenge?.consumed_at).toBeNull();
    expect(state.challenge?.revoked_at).toBeInstanceOf(Date);
    const [bindings] = await connection<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM remote_controller_bindings WHERE challenge_id = ${staleChallenge}
    `;
    expect(bindings?.count).toBe("0");
  });

  test("a failed replacement insert rolls back token and remote authority invalidation together", async () => {
    const fixture = await createFixture();
    const boundChallenge = await insertChallenge(fixture);
    const committed = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(fixture, boundChallenge));
    expect(committed.outcome).toBe("committed");
    const pendingChallenge = await insertChallenge(fixture);

    let rejected = false;
    try {
      await getRelayTokenStore().pairForInstallation({
        userId: fixture.userId,
        actorId: fixture.actorId,
        // relay_tokens.token_hash is globally unique, so this forces the
        // replacement insert to fail after the transaction has staged revokes.
        tokenHash: fixture.tokenHash,
        label: "Impossible replacement",
        capabilities: {},
        installationId: fixture.hostInstallationId,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    const state = await relayAuthorityState(fixture, pendingChallenge, committed.bindingId);
    expect(state.relay?.revoked_at).toBeNull();
    expect(state.challenge).toMatchObject({ consumed_at: null, revoked_at: null });
    expect(state.binding?.revoked_at).toBeNull();
  });

  test("a cross-user revoke leaves the authority generation untouched", async () => {
    const owner = await createFixture();
    const otherUser = await createFixture();
    const ownerChallenge = await insertChallenge(owner);
    const ownerCommitted = await getRemotePairingStore()
      .consumeChallengeEnsureInstallationAndCreateBinding(atomicInput(owner, ownerChallenge));
    expect(ownerCommitted.outcome).toBe("committed");
    const ownerPending = await insertChallenge(owner);

    expect(await getRelayTokenStore().revokeWithGenerationsForUser?.({
      id: owner.relayTokenId,
      userId: otherUser.userId,
    })).toEqual({ revoked: false, revokedPairingGenerationIds: [] });
    const ownerState = await relayAuthorityState(owner, ownerPending, ownerCommitted.bindingId);
    expect(ownerState.relay?.revoked_at).toBeNull();
    expect(ownerState.challenge?.revoked_at).toBeNull();
    expect(ownerState.binding?.revoked_at).toBeNull();
  });

  test("concurrent consume and relay revoke leave no active binding on a revoked relay", async () => {
    const fixture = await createFixture();
    const challenge = await insertChallenge(fixture);
    const [consume, revoked] = await Promise.all([
      getRemotePairingStore().consumeChallengeEnsureInstallationAndCreateBinding(
        atomicInput(fixture, challenge),
      ),
      getRelayTokenStore().revokeForUser({ id: fixture.relayTokenId, userId: fixture.userId }),
    ]);
    expect(revoked).toBe(true);
    expect(["committed", "conflict"]).toContain(consume.outcome);
    const [relay] = await connection<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM relay_tokens WHERE id = ${fixture.relayTokenId}
    `;
    const [activeBindings] = await connection<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM remote_controller_bindings
      WHERE relay_token_id = ${fixture.relayTokenId} AND revoked_at IS NULL
    `;
    expect(relay?.revoked_at).toBeInstanceOf(Date);
    expect(activeBindings?.count).toBe("0");
  });
});
