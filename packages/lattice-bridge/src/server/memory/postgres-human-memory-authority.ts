import {
  and,
  eq,
  humanCryptoCustodies,
  humanCryptoDevices,
  namespaceDomainKeyHeads,
  sql,
} from "@nautilo/db";

import type {
  HistoricalHumanMemoryDeviceAuthority,
  HumanMemoryPreparedAuthorityContext,
  ResolveHistoricalHumanMemoryDeviceAuthority,
} from "./human-memory-prepared-update.ts";
import type {
  CurrentHumanMemoryWriteAuthorization,
  CurrentHumanMemoryWriteAuthorizationContext,
  ResolveCurrentHumanMemoryWriteAuthorization,
  ResolveStoredHumanMemorySignerAuthority,
  StoredHumanMemorySignerAuthority,
  StoredHumanMemorySignerContext,
} from "./postgres-human-memory-crypto-completion.ts";
import type { HumanMemoryExactAccessPublicationAuthority } from
  "./postgres-human-memory-exact-access-product.ts";
import type {
  HumanMemoryExactAccessAuthorityContext,
} from "@nautilo/lattice-crypto";
import type {
  MemoryNativeNamespaceAuthorityEntryV1,
} from "@nautilo/lattice-crypto/wire";
import { lockMemoryNativeAccessEntries } from "./native-memory-access-authority.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import { withCurrentHumanDeviceSigningAuthorityExecutor } from
  "../device/postgres-current-human-device-signing-authority.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import { humanMemoryPreparedAuthorizationError } from "./human-memory-prepared-route-error.ts";

function oneOrNull(rows: readonly DatabaseRow[], label: string): DatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function text(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function counter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)
    ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value as number;
}

function bytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return value.slice();
}

export class PostgresHumanMemoryAuthorityResolver {
  readonly #handle: CryptoPostgresHandle;

  constructor(input: Readonly<{
    handle: CryptoPostgresHandle;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
  }

  async resolveHumanId(userId: string): Promise<string | null> {
    const row = oneOrNull(await executeTypedCryptoQuery(
      this.#handle,
      cryptoTypedDb.select({
        human_id: humanCryptoCustodies.humanId,
      }).from(humanCryptoCustodies).where(and(
        eq(humanCryptoCustodies.userId, userId),
        eq(humanCryptoCustodies.state, "active"),
      )).limit(2),
    ), "Human Memory custody");
    return row === null ? null : text(row, "human_id");
  }

  /** Resolves only a currently active device/custody key. The signed request's
   * native Namespace tuples are authenticated separately before publication. */
  async resolveCurrentAccessSigningKey(
    context: HumanMemoryExactAccessAuthorityContext,
  ): Promise<Uint8Array | null> {
    const row = oneOrNull(await executeTypedCryptoQuery(
      this.#handle,
      cryptoTypedDb.select({
        human_id: humanCryptoDevices.humanId,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        state: humanCryptoDevices.state,
        revision: humanCryptoDevices.revision,
        custody_state: sql`${humanCryptoCustodies.state}`.as("custody_state"),
      }).from(humanCryptoDevices).innerJoin(
        humanCryptoCustodies,
        eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId),
      ).where(eq(humanCryptoDevices.deviceId, context.committerDeviceId)).limit(2),
    ), "Current Human Memory access signer");
    if (row === null
      || text(row, "human_id") !== context.subjectHumanId
      || text(row, "state") !== "active"
      || text(row, "custody_state") !== "active"
      || counter(row, "revision") !== context.hostAuthorizationRevision) return null;
    return bytes(row, "signing_public_key");
  }

  readonly resolveHistoricalDeviceAuthority:
    ResolveHistoricalHumanMemoryDeviceAuthority = async (
      context: HumanMemoryPreparedAuthorityContext,
    ): Promise<HistoricalHumanMemoryDeviceAuthority | null> => {
      const row = oneOrNull(await executeTypedCryptoQuery(
        this.#handle,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          state: humanCryptoDevices.state,
          revision: humanCryptoDevices.revision,
        }).from(humanCryptoDevices).where(eq(
          humanCryptoDevices.deviceId,
          context.committerDeviceId,
        )).limit(2),
      ), "Historical Human Memory signer");
      if (
        row === null
        || text(row, "human_id") !== context.expectedHumanId
        || !["active", "revoked"].includes(text(row, "state"))
        || counter(row, "revision") < context.hostAuthorizationRevision
      ) return null;
      return Object.freeze({
        ...context,
        committerSigningPublicKey: bytes(row, "signing_public_key"),
      });
    };

  /** The ordinary signed intent has no object/ciphertext coordinates. Its
   * retained signer is the same admitted Human-device identity, not an Agent. */
  readonly resolveHistoricalOrdinaryDeviceAuthority = async (context: Readonly<{
    subjectHumanId: string;
    committerDeviceId: string;
    committerDeviceSigningKeyGeneration: number;
    hostAuthorizationRevision: number;
    issuedAt: number;
  }>): Promise<Readonly<{ committerSigningPublicKey: Uint8Array }> | null> => {
    const row = oneOrNull(await executeTypedCryptoQuery(this.#handle,
      cryptoTypedDb.select({ human_id: humanCryptoDevices.humanId,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        device_generation: humanCryptoDevices.deviceGeneration,
        revision: humanCryptoDevices.revision, state: humanCryptoDevices.state,
        created_at: humanCryptoDevices.createdAt,
      }).from(humanCryptoDevices).where(eq(humanCryptoDevices.deviceId,
        context.committerDeviceId)).limit(2)), "Historical ordinary Memory signer");
    if (row === null || text(row, "human_id") !== context.subjectHumanId
      || !["active", "revoked"].includes(text(row, "state"))
      || counter(row, "device_generation") !== context.committerDeviceSigningKeyGeneration
      || counter(row, "revision") < context.hostAuthorizationRevision) return null;
    const created = row["created_at"];
    const createdAt = created instanceof Date ? created.getTime()
      : typeof created === "string" ? Date.parse(created) : Number.NaN;
    if (!Number.isFinite(createdAt)) {
      throw new TypeError("Historical ordinary Memory signer timestamp is invalid");
    }
    if (!Number.isSafeInteger(context.issuedAt) || context.issuedAt < createdAt) return null;
    return { committerSigningPublicKey: bytes(row, "signing_public_key") };
  };

  readonly resolveStoredSignerAuthority:
    ResolveStoredHumanMemorySignerAuthority = async (
      context: StoredHumanMemorySignerContext,
    ): Promise<StoredHumanMemorySignerAuthority | null> => {
      const row = oneOrNull(await executeTypedCryptoQuery(
        this.#handle,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          state: humanCryptoDevices.state,
          revision: humanCryptoDevices.revision,
        }).from(humanCryptoDevices).where(eq(
          humanCryptoDevices.deviceId,
          context.committerDeviceId,
        )).limit(2),
      ), "Stored Human Memory signer");
      if (
        row === null
        || !["active", "revoked"].includes(text(row, "state"))
        || counter(row, "revision") < context.hostAuthorizationRevision
      ) return null;
      return Object.freeze({
        ...context,
        humanId: text(row, "human_id"),
        committerSigningPublicKey: bytes(row, "signing_public_key"),
      });
    };

  readonly resolveCurrentWriteAuthorization:
    ResolveCurrentHumanMemoryWriteAuthorization = async (
      context: CurrentHumanMemoryWriteAuthorizationContext,
    ): Promise<CurrentHumanMemoryWriteAuthorization | null> => {
      const device = oneOrNull(await executeTypedCryptoQuery(
        this.#handle,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          state: humanCryptoDevices.state,
          revision: humanCryptoDevices.revision,
          custody_state: sql`${humanCryptoCustodies.state}`
            .as("custody_state"),
        }).from(humanCryptoDevices).innerJoin(
          humanCryptoCustodies,
          eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId),
        ).where(eq(
          humanCryptoDevices.deviceId,
          context.committerDeviceId,
        )).limit(2),
      ), "Current Human Memory signer");
      if (
        device === null
        || text(device, "human_id") !== context.expectedHumanId
        || text(device, "state") !== "active"
        || text(device, "custody_state") !== "active"
        || counter(device, "revision") !== context.hostAuthorizationRevision
      ) return null;
      if (!await this.#namespaceHeadsCurrent(this.#handle, context, false)) return null;
      return Object.freeze({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: bytes(device, "signing_public_key"),
      });
    };

  async #namespaceHeadsCurrent(
    executor: CryptoPostgresExecutor,
    context: Readonly<{ envelopes: readonly Readonly<{
      namespaceId: string;
      keyGeneration: number;
      bindingRevisionAtWrap: number;
    }>[] }>,
    lock: boolean,
  ): Promise<boolean> {
    // Memory uses the same AI Namespace generation on Human and Agent devices.
    // The obsolete MLS-era namespace_crypto_heads is not current authority.
    for (const expected of [...context.envelopes].sort((a, b) =>
      a.namespaceId.localeCompare(b.namespaceId))) {
      const query = cryptoTypedDb.select({
        namespace_access_revision: namespaceDomainKeyHeads.namespaceAccessRevision,
        namespace_current_generation: namespaceDomainKeyHeads.namespaceCurrentGeneration,
      }).from(namespaceDomainKeyHeads).where(and(
        eq(namespaceDomainKeyHeads.namespaceId, expected.namespaceId),
        eq(namespaceDomainKeyHeads.keyClass, "ai"),
      ));
      const rows = await executeTypedCryptoQuery(executor,
        lock ? query.for("share") : query);
      if (rows.length !== 1
        || counter(rows[0]!, "namespace_access_revision") !== expected.bindingRevisionAtWrap
        || counter(rows[0]!, "namespace_current_generation") !== expected.keyGeneration) return false;
    }
    return true;
  }

  /** Held across the caller's entire canonical product transaction/commit.
   * The caller acquires its policy fence before invoking lockCryptoAuthority.
   * Product permission is checked by that caller; crypto custody is not a grant
   * to mutate arbitrary Memories. */
  async withCurrentWriteAuthority<Result>(input: Readonly<{
    subjectUserId: string;
    humanActorId: string;
    context: CurrentHumanMemoryWriteAuthorizationContext;
  }>, publish: (lockCryptoAuthority: () => Promise<void>) => Promise<Result>): Promise<Result> {
    // The continuation commits in the product DB transaction, so this outer
    // lock owner must never retry it after an ambiguous restricted commit.
    return this.#handle.transactionOnce(async (transaction) => {
      let acquired = false;
      const lockCryptoAuthority = async () => {
        if (acquired) throw new Error("Human Memory publication authority was already locked");
        const devices = await executeTypedCryptoQuery(transaction,
        cryptoTypedDb.select({ device_generation: humanCryptoDevices.deviceGeneration })
          .from(humanCryptoDevices)
          .where(eq(humanCryptoDevices.deviceId, input.context.committerDeviceId)));
      if (devices.length !== 1) throw new Error("Human Memory device authority is unavailable");
        const result = await withCurrentHumanDeviceSigningAuthorityExecutor(transaction, {
        subjectUserId: input.subjectUserId,
        subjectHumanId: input.context.expectedHumanId,
        humanActorId: input.humanActorId,
        deviceId: input.context.committerDeviceId,
        deviceSigningKeyGeneration: counter(devices[0]!, "device_generation"),
        hostAuthorizationRevision: input.context.hostAuthorizationRevision,
      }, async () => {
        if (!await this.#namespaceHeadsCurrent(transaction, input.context, true)) {
          throw new Error("Human Memory Namespace authority is stale");
        }
        return true;
      });
      if (result === null) throw new Error("Human Memory device authority is unavailable");
        acquired = true;
      };
      const result = await publish(lockCryptoAuthority);
      if (!acquired) throw new Error("Human Memory publication did not acquire crypto authority");
      return result;
    });
  }

  /** Ordinary fallback needs an admitted signer, not unavailable Namespace
   * keys. Acquire that signer after the caller's policy fence and retain its
   * lock through the canonical product commit, just like protected writes. */
  async withCurrentOrdinaryWriteAuthority<Result>(input: Readonly<{
    subjectUserId: string;
    humanActorId: string;
    context: Readonly<{
      subjectHumanId: string;
      committerDeviceId: string;
      committerDeviceSigningKeyGeneration: number;
      hostAuthorizationRevision: number;
    }>;
  }>, publish: (lockDeviceAuthority: () => Promise<void>) => Promise<Result>): Promise<Result> {
    return this.#handle.transactionOnce(async (transaction) => {
      let acquired = false;
      const lockDeviceAuthority = async () => {
        if (acquired) throw new Error("Human Memory device authority was already locked");
        const result = await withCurrentHumanDeviceSigningAuthorityExecutor(transaction, {
          subjectUserId: input.subjectUserId,
          subjectHumanId: input.context.subjectHumanId,
          humanActorId: input.humanActorId,
          deviceId: input.context.committerDeviceId,
          deviceSigningKeyGeneration: input.context.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: input.context.hostAuthorizationRevision,
        }, () => Promise.resolve(true));
        if (result === null) throw humanMemoryPreparedAuthorizationError(
          "Human Memory device authority is unavailable",
        );
        acquired = true;
      };
      const result = await publish(lockDeviceAuthority);
      if (!acquired) throw new Error("Human Memory publication did not acquire device authority");
      return result;
    });
  }

  /** Holds the exact current Human device and native AI Namespace heads used
   * by a signed access update until the caller's canonical product commit has
   * resolved. This is deliberately distinct from content allocation authority. */
  async withCurrentAccessAuthority<Result>(input: Readonly<{
    subjectUserId: string;
    humanActorId: string;
    context: HumanMemoryExactAccessPublicationAuthority;
  }>, publish: (lockCryptoAuthority: () => Promise<void>) => Promise<Result>): Promise<Result> {
    return this.#handle.transactionOnce(async (transaction) => {
      let acquired = false;
      const lockCryptoAuthority = async () => {
        if (acquired) throw new Error("Human Memory access authority was already locked");
        const devices = await executeTypedCryptoQuery(transaction,
          cryptoTypedDb.select({ device_generation: humanCryptoDevices.deviceGeneration })
            .from(humanCryptoDevices)
            .where(eq(humanCryptoDevices.deviceId, input.context.committerDeviceId)));
        if (devices.length !== 1) {
          throw new Error("Human Memory access device authority is unavailable");
        }
        const result = await withCurrentHumanDeviceSigningAuthorityExecutor(transaction, {
          subjectUserId: input.subjectUserId,
          subjectHumanId: input.context.subjectHumanId,
          humanActorId: input.humanActorId,
          deviceId: input.context.committerDeviceId,
          deviceSigningKeyGeneration: counter(devices[0]!, "device_generation"),
          hostAuthorizationRevision: input.context.hostAuthorizationRevision,
        }, async () => {
          const entries = [...input.context.currentAuthorityEntries];
          for (const targetEntry of input.context.targetAuthorityEntries) {
            const retained = entries.find((entry) =>
              entry.namespaceId === targetEntry.namespaceId);
            if (retained === undefined) {
              entries.push(targetEntry);
            } else if (retained.keyGeneration !== targetEntry.keyGeneration
              || retained.namespaceAccessRevision !== targetEntry.namespaceAccessRevision
              || ![retained.headDigest, retained.publicationDigest,
                retained.publicationSetDigest, retained.audienceFingerprint]
                .every((value, index) => {
                  const expected = [targetEntry.headDigest,
                    targetEntry.publicationDigest, targetEntry.publicationSetDigest,
                    targetEntry.audienceFingerprint][index]!;
                  return value.length === expected.length
                    && value.every((byte, byteIndex) => byte === expected[byteIndex]);
                })) {
              throw new Error("Human Memory access retained Namespace authority conflicts");
            }
          }
          entries.sort((left, right) => left.namespaceId.localeCompare(right.namespaceId));
          if (!await lockMemoryNativeAccessEntries({ executor: transaction, entries })) {
            throw new Error("Human Memory access Namespace authority is stale");
          }
          return true;
        });
        if (result === null) {
          throw new Error("Human Memory access device authority is unavailable");
        }
        acquired = true;
      };
      const result = await publish(lockCryptoAuthority);
      if (!acquired) throw new Error("Human Memory access publication did not acquire crypto authority");
      return result;
    });
  }

  /** Neutral Human-device/native-Namespace lease used by authenticated Memory
   * repair and access publication. The outer restricted transaction owns the
   * locks until the nested canonical product commit promise resolves. */
  async withCurrentNativeMemoryAuthority<Result>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    humanActorId: string;
    deviceId: string;
    deviceSigningKeyGeneration: number;
    hostAuthorizationRevision: number;
    namespaces: readonly MemoryNativeNamespaceAuthorityEntryV1[];
  }>, publish: () => Promise<Result>): Promise<Result | null> {
    return this.#handle.transactionOnce(async (transaction) =>
      withCurrentHumanDeviceSigningAuthorityExecutor(transaction, {
        subjectUserId: input.subjectUserId,
        subjectHumanId: input.subjectHumanId,
        humanActorId: input.humanActorId,
        deviceId: input.deviceId,
        deviceSigningKeyGeneration: input.deviceSigningKeyGeneration,
        hostAuthorizationRevision: input.hostAuthorizationRevision,
      }, async () => {
        if (!await lockMemoryNativeAccessEntries({
          executor: transaction,
          entries: input.namespaces,
        })) return null;
        return publish();
      }));
  }

}
