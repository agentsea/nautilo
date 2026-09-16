import { describe, expect, test } from "bun:test";
import type { HumanMemoryExactAccessPublicationAuthority } from
  "../../src/server/memory/postgres-human-memory-exact-access-product.ts";
import type {
  HumanMemoryPreparedAuthorityContext,
} from "../../src/server/memory/human-memory-prepared-update.ts";
import type {
  CurrentHumanMemoryWriteAuthorizationContext,
  StoredHumanMemorySignerContext,
} from "../../src/server/memory/postgres-human-memory-crypto-completion.ts";
import {
  PostgresHumanMemoryAuthorityResolver,
} from "../../src/server/memory/postgres-human-memory-authority.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  inTransaction = false;
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.inTransaction = true;
    return callback(this).finally(() => { this.inTransaction = false; });
  }
}

function preparedAuthority(): HumanMemoryPreparedAuthorityContext {
  return {
    purpose: "authenticate-human-memory-prepared-update",
    expectedHumanId: "human_alice",
    operationId: "operation_memory_update",
    memoryId: "memory_1",
    expectedContentRevision: 1,
    nextContentRevision: 2,
    objectId: "memory_object_2",
    payloadHash: new Uint8Array(32).fill(0x31),
    envelopes: [],
    committerDeviceId: "device_alice",
    hostAuthorizationRevision: 5,
  };
}

function writeContext(): CurrentHumanMemoryWriteAuthorizationContext {
  const prepared = preparedAuthority();
  return { ...prepared, purpose: "authorize-current-human-memory-update-persistence",
    productAllocation: { operationId: prepared.operationId, memoryId: prepared.memoryId,
      expectedContentRevision: 1, nextContentRevision: 2, objectId: prepared.objectId,
      anchorNamespaceId: "namespace-a", expectedAccessRevision: 0,
      requiredNamespaceFingerprint: new Uint8Array(32),
      operationRequestDigest: new Uint8Array(32), allocationRequestDigest: new Uint8Array(32),
    },
    envelopes: [{ objectId: prepared.objectId, namespaceId: "namespace-a", keyClass: "ai",
      keyGeneration: 3, bindingRevisionAtWrap: 8, envelopeHash: new Uint8Array(32) }],
  };
}

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim()
    .toLowerCase();
}

function accessContext(): HumanMemoryExactAccessPublicationAuthority {
  const entry = (namespaceId: string, keyGeneration: number) => ({
    namespaceId: namespaceId as never, keyGeneration, namespaceAccessRevision: 8,
    headDigest: new Uint8Array(32), publicationDigest: new Uint8Array(32),
    publicationSetDigest: new Uint8Array(32), audienceFingerprint: new Uint8Array(32),
    envelopeHash: new Uint8Array(32),
  });
  const authorityEntry = (namespaceId: string, keyGeneration: number) => {
    const { envelopeHash: _envelopeHash, ...authority } = entry(namespaceId, keyGeneration);
    return authority;
  };
  return {
    purpose: "persist-human-memory-native-access-update",
    operationId: "access-1", objectId: "memory-object", payloadHash: new Uint8Array(32),
    expectedContentRevision: 1, currentAccessRevision: 0,
    currentManifestHash: new Uint8Array(32), nextAccessRevision: 1,
    nextManifestHash: new Uint8Array(32),
    currentEntries: [entry("namespace-a", 3)],
    targetEntries: [entry("namespace-a", 3), entry("namespace-b", 4)],
    currentAuthorityEntries: [authorityEntry("namespace-a", 3)],
    targetAuthorityEntries: [
      authorityEntry("namespace-a", 3), authorityEntry("namespace-b", 4),
    ],
    subjectHumanId: "human_alice", committerDeviceId: "device_alice",
    hostAuthorizationRevision: 5,
  };
}

describe("Postgres Human Memory authority resolver", () => {
  test("ordinary signed retries resolve only their retained Human and device generation", async () => {
    const issuedAt = Date.parse("2026-09-07T00:00:00Z");
    for (const changed of [{}, { state: "revoked" }, { human_id: "other" },
      { device_generation: 3 }, { revision: 4 }, { state: "pending" },
      { created_at: new Date(issuedAt + 1) }]) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
        [{ human_id: "human_alice", signing_public_key: new Uint8Array(32).fill(7),
          device_generation: 2, revision: 5, state: "active",
          created_at: new Date(issuedAt - 1000).toISOString(), ...changed }],
      ]);
      const resolver = new PostgresHumanMemoryAuthorityResolver({
        handle: await verifyCryptoPostgresHandle(connection),
      });
      const result = await resolver.resolveHistoricalOrdinaryDeviceAuthority({
        subjectHumanId: "human_alice", committerDeviceId: "device_alice",
        committerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 5, issuedAt,
      });
      const valid = Object.keys(changed).length === 0
        || ("state" in changed && changed.state === "revoked");
      if (valid) expect(result?.committerSigningPublicKey).toEqual(new Uint8Array(32).fill(7));
      else expect(result).toBeNull();
      expect(normalizedSql(connection.statements.join("\n"))).not.toContain("namespace");
    }
  });

  test("ordinary fallback locks the exact admitted device after policy and through commit without Namespace keys", async () => {
    for (const active of [true, false]) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
        active ? [{ signing_public_key: new Uint8Array(65) }] : [],
      ]);
      const resolver = new PostgresHumanMemoryAuthorityResolver({
        handle: await verifyCryptoPostgresHandle(connection),
      });
      let committed = false;
      const result = await resolver.withCurrentOrdinaryWriteAuthority({
        subjectUserId: "user-alice", humanActorId: "human_alice",
        context: { subjectHumanId: "human_alice", committerDeviceId: "device_alice",
          committerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 5 },
      }, async (lockDeviceAuthority) => {
        expect(connection.statements).toHaveLength(1);
        await lockDeviceAuthority();
        expect(connection.inTransaction).toBe(true);
        committed = true;
        return "committed";
      }).catch((error: unknown) => error);
      if (active) expect(result).toBe("committed");
      else expect(result).toMatchObject({ reason: "authorization_required" });
      expect(committed).toBe(active);
      expect(connection.inTransaction).toBe(false);
      const statements = normalizedSql(connection.statements.join("\n"));
      expect(statements).toContain("for share of human_crypto_devices, human_crypto_custodies");
      expect(statements).toContain("device_generation");
      expect(statements).not.toContain("namespace_domain_key_heads");
    }
  });

  test("ordinary fallback cannot skip its device lock or retry an ambiguous product commit", async () => {
    for (const skipLock of [true, false]) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
        [{ signing_public_key: new Uint8Array(65) }],
      ]);
      const resolver = new PostgresHumanMemoryAuthorityResolver({
        handle: await verifyCryptoPostgresHandle(connection),
      });
      const failure = new Error("ambiguous canonical commit");
      let calls = 0;
      const result = await resolver.withCurrentOrdinaryWriteAuthority({
        subjectUserId: "user-alice", humanActorId: "human_alice",
        context: { subjectHumanId: "human_alice", committerDeviceId: "device_alice",
          committerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 5 },
      }, async (lockDeviceAuthority) => {
        calls += 1;
        if (skipLock) return "not committed";
        await lockDeviceAuthority();
        throw failure;
      }).catch((error: unknown) => error);
      if (skipLock) expect(result).toMatchObject({
        message: "Human Memory publication did not acquire device authority",
      });
      else expect(result).toBe(failure);
      expect(calls).toBe(1);
      expect(connection.inTransaction).toBe(false);
    }
  });

  test("current Human writes use the same native AI Namespace heads as Agents, not old MLS heads", async () => {
    for (const generation of [3, 4]) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
        [{ device_id: "device_alice", human_id: "human_alice",
          signing_public_key: new Uint8Array(65), state: "active",
          revision: 5, custody_state: "active" }],
        [{ namespace_access_revision: 8, namespace_current_generation: generation }],
      ]);
      const resolver = new PostgresHumanMemoryAuthorityResolver({
        handle: await verifyCryptoPostgresHandle(connection),
      });
      const context = writeContext();
      const result = await resolver.resolveCurrentWriteAuthorization(context);
      if (generation === 3) expect(result).toMatchObject({ targetAuthorized: true });
      else expect(result).toBeNull();
      const statements = normalizedSql(connection.statements.join("\n"));
      expect(statements).toContain("namespace_domain_key_heads");
      expect(statements).not.toContain("namespace_crypto_heads");
    }
  });

  test("holds exact device and Namespace locks through canonical publication and rejects stale coordinates", async () => {
    for (const stale of [false, true]) {
      const connection = new ScriptedConnection([
        [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
        [{ device_generation: 2 }],
        [{ signing_public_key: new Uint8Array(65) }],
        [{ namespace_access_revision: stale ? 9 : 8, namespace_current_generation: 3 }],
      ]);
      const resolver = new PostgresHumanMemoryAuthorityResolver({
        handle: await verifyCryptoPostgresHandle(connection),
      });
      let published = false;
      const pending = resolver.withCurrentWriteAuthority({
        subjectUserId: "user-alice", humanActorId: "human_alice",
        context: writeContext(),
      }, async (lockCryptoAuthority) => {
        // The product transaction starts and fences policy before asking the
        // already-open restricted transaction to take its authority locks.
        expect(connection.statements).toHaveLength(1);
        await lockCryptoAuthority();
        expect(connection.inTransaction).toBe(true);
        published = true;
        return "committed";
      });
      if (stale) expect(await pending.catch((error: unknown) => error))
        .toMatchObject({ message: "Human Memory Namespace authority is stale" });
      else expect(await pending).toBe("committed");
      expect(published).toBe(!stale);
      expect(connection.inTransaction).toBe(false);
      const statements = normalizedSql(connection.statements.join("\n"));
      expect(statements).toContain("for share of human_crypto_devices, human_crypto_custodies");
      expect(statements).toContain("namespace_domain_key_heads");
    }
  });

  test("holds the signed access device and exact native Domain heads through product commit", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [{ device_generation: 2 }],
      [{ signing_public_key: new Uint8Array(65) }],
      [{ namespace_id: "namespace-a", namespace_access_revision: 8,
        namespace_current_generation: 3,
        retained_authority_set_digest: new Uint8Array(32) }],
      [{ namespace_id: "namespace-b", namespace_access_revision: 8,
        namespace_current_generation: 4,
        retained_authority_set_digest: new Uint8Array(32) }],
    ]);
    const resolver = new PostgresHumanMemoryAuthorityResolver({
      handle: await verifyCryptoPostgresHandle(connection),
    });
    let committed = false;
    const result = await resolver.withCurrentAccessAuthority({
      subjectUserId: "user-alice", humanActorId: "human_alice",
      context: accessContext(),
    }, async (lockCryptoAuthority) => {
      expect(connection.statements).toHaveLength(1);
      await lockCryptoAuthority();
      expect(connection.inTransaction).toBe(true);
      committed = true;
      return "committed";
    });
    expect(result).toBe("committed");
    expect(committed).toBe(true);
    expect(connection.inTransaction).toBe(false);
    const statements = normalizedSql(connection.statements.join("\n"));
    expect(connection.statements.filter((statement) =>
      normalizedSql(statement).includes("namespace_domain_key_heads"))).toHaveLength(2);
    expect(statements).not.toContain("namespace_crypto_heads");
  });

  test("holds neutral repair device and native digest authority through publication", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [{ signing_public_key: new Uint8Array(65) }],
      [{ namespace_id: "namespace-a", namespace_access_revision: 8,
        namespace_current_generation: 3,
        retained_authority_set_digest: new Uint8Array(32) }],
    ]);
    const resolver = new PostgresHumanMemoryAuthorityResolver({
      handle: await verifyCryptoPostgresHandle(connection),
    });
    let held = false;
    const result = await resolver.withCurrentNativeMemoryAuthority({
      subjectUserId: "user-alice", subjectHumanId: "human_alice",
      humanActorId: "human_alice", deviceId: "device_alice",
      deviceSigningKeyGeneration: 2, hostAuthorizationRevision: 5,
      namespaces: accessContext().currentAuthorityEntries,
    }, async () => {
      held = connection.inTransaction;
      return "published";
    });
    expect(result).toBe("published");
    expect(held).toBe(true);
    expect(connection.inTransaction).toBe(false);
    expect(normalizedSql(connection.statements.join("\n")))
      .toContain("for share of namespace_domain_key_heads");
  });
  test("uses typed bounded custody and device projections", async () => {
    const signingPublicKey = new Uint8Array(65).fill(0x41);
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [{ human_id: "human_alice" }],
      [{
        device_id: "device_alice",
        human_id: "human_alice",
        signing_public_key: signingPublicKey,
        state: "active",
        revision: 7,
      }],
      [{
        device_id: "device_alice",
        human_id: "human_alice",
        signing_public_key: signingPublicKey,
        state: "revoked",
        revision: 7,
      }],
      [{
        device_id: "device_alice",
        human_id: "human_alice",
        signing_public_key: signingPublicKey,
        state: "revoked",
        revision: 7,
        custody_state: "active",
      }],
    ]);
    const handle = await verifyCryptoPostgresHandle(connection);
    const resolver = new PostgresHumanMemoryAuthorityResolver({
      handle,
    });

    expect(await resolver.resolveHumanId(
      "00000000-0000-4000-8000-000000000001",
    )).toBe("human_alice");
    expect(await resolver.resolveHistoricalDeviceAuthority(
      preparedAuthority(),
    )).toMatchObject({
      expectedHumanId: "human_alice",
      committerDeviceId: "device_alice",
    });
    const stored: StoredHumanMemorySignerContext = {
      purpose: "verify-stored-human-memory-revision",
      memoryId: "memory_1",
      contentRevision: 2,
      objectId: "memory_object_2",
      payloadHash: new Uint8Array(32).fill(0x31),
      envelopes: [],
      committerDeviceId: "device_alice",
      hostAuthorizationRevision: 5,
    };
    expect(await resolver.resolveStoredSignerAuthority(stored)).toMatchObject({
      humanId: "human_alice",
      committerDeviceId: "device_alice",
    });
    const current = {
      ...preparedAuthority(),
      purpose: "authorize-current-human-memory-update-persistence",
      productAllocation: {},
    } as CurrentHumanMemoryWriteAuthorizationContext;
    expect(await resolver.resolveCurrentWriteAuthorization(current)).toBeNull();

    const sql = normalizedSql(connection.statements.join("\n"));
    expect(sql).toContain("from human_crypto_custodies");
    expect(sql).toContain("from human_crypto_devices");
    expect(sql).toContain("inner join human_crypto_custodies");
    expect(sql).not.toContain("select *");
  });
});
