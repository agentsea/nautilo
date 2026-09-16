import {
  and,
  count,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryOperations,
  cryptoDeviceEpochOperations,
  eq,
  exists,
  gt,
  humanCryptoDeviceKeyPackages,
  humanCryptoDevices,
  inArray,
  isNull,
  notInArray,
  sql,
} from "@nautilo/db";
import type {
  VerifiedDeviceJoinPackage,
} from "../../delivery/device-join-package.ts";
import {
  assertVerifiedDeviceJoinPackage,
} from "../../delivery/device-join-package.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
} from "../storage/postgres-record-codecs.ts";

const MAX_PUBLISH_BATCH = 12;

export type PublishDeviceJoinPackagesResult =
  | {
    readonly status: "published" | "duplicate";
    readonly publishedCount: number;
  }
  | { readonly status: "bound_reached" | "conflicting_state" | "stale_state" };

export type ClaimDeviceJoinPackageResult =
  | {
    readonly status: "claimed";
    readonly package: {
      readonly packageId: string;
      readonly packageHash: Uint8Array;
      readonly packageBytes: Uint8Array;
      readonly formatVersion: 1;
      readonly expectedProviderHeadHash: Uint8Array;
    };
  }
  | { readonly status: "missing" | "stale_state" };

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Crypto delivery column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto delivery column ${name} must be bytea`);
  }
  return value;
}

function requiredCounter(row: DatabaseRow, name: string): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError(`Crypto delivery column ${name} must be a safe counter`);
  }
  return normalized;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Crypto delivery timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function timestampSql(milliseconds: number) {
  return sql`${isoTime(milliseconds)}::timestamptz`;
}

function assertBatch(packages: readonly VerifiedDeviceJoinPackage[]): void {
  if (packages.length < 1 || packages.length > MAX_PUBLISH_BATCH) {
    throw new RangeError("Device join package batch is out of bounds");
  }
  const first = packages[0]!;
  const ids = new Set<string>();
  for (const item of packages) {
    assertVerifiedDeviceJoinPackage(item);
    if (
      item.deviceId !== first.deviceId
      || item.humanId !== first.humanId
      || item.generation !== first.generation
      || ids.has(item.packageId)
      || item.packageHash.length !== 32
      || item.expectedProviderHeadHash.length !== 32
      || item.keyPackageBytes.length < 1
    ) {
      throw new TypeError("Device join package batch is inconsistent");
    }
    ids.add(item.packageId);
  }
}

export class PostgresDeviceJoinPackageRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  publish(
    packages: readonly VerifiedDeviceJoinPackage[],
  ): Promise<PublishDeviceJoinPackagesResult> {
    assertBatch(packages);
    return this.handle.transaction(async (transaction) => {
      const first = packages[0]!;
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`device-key-packages/${first.deviceId}`],
      );
      const devices = await transaction.query(
        `SELECT device_id, human_id, state, key_package_generation,
                key_package_count, revision AS device_revision
           FROM human_crypto_devices
          WHERE device_id = $1
          LIMIT 2
          FOR UPDATE`,
        [first.deviceId],
      );
      if (devices.length !== 1) return { status: "stale_state" };
      const device = devices[0]!;
      const currentGeneration = requiredCounter(
        device,
        "key_package_generation",
      );
      const currentCount = requiredCounter(device, "key_package_count");
      const currentDeviceRevision = requiredCounter(
        device,
        "device_revision",
      );
      if (
        requiredString(device, "human_id") !== first.humanId
        || !["pending", "active"].includes(requiredString(device, "state"))
        || (
          currentGeneration === 0
            ? first.generation !== 1
            : first.generation !== currentGeneration
        )
      ) return { status: "stale_state" };

      const heads = await transaction.query(
        `SELECT h.domain_id, h.provider_id, h.epoch, h.state_hash
           FROM crypto_domain_provider_heads h
          WHERE h.domain_id = ANY($1::text[])
          ORDER BY h.domain_id
          FOR UPDATE`,
        [[...new Set(packages.map((item) => item.domainId))].sort()],
      );
      const headByDomain = new Map(
        heads.map((row) => [requiredString(row, "domain_id"), row]),
      );
      if (packages.some((item) => {
        const head = headByDomain.get(item.domainId);
        return head === undefined
          || requiredString(head, "provider_id") !== item.providerId
          || requiredCounter(head, "epoch") !== item.expectedEpoch
          || !equalBytes(
            requiredBytes(head, "state_hash"),
            item.expectedProviderHeadHash,
          );
      })) return { status: "stale_state" };

      const existing = await transaction.query(
        `SELECT device_id, domain_id, generation, package_id, package_hash,
                expected_provider_head_hash, package_bytes
           FROM human_crypto_device_key_packages
          WHERE device_id = $1
            AND generation = $2
            AND package_id = ANY($3::text[])
          ORDER BY package_id
          FOR UPDATE`,
        [
          first.deviceId,
          first.generation,
          packages.map((item) => item.packageId),
        ],
      );
      if (existing.length > 0) {
        const expected = [...packages].sort((left, right) =>
          left.packageId.localeCompare(right.packageId)
        );
        if (
          existing.length === expected.length
          && existing.every((row, index) => {
            const item = expected[index]!;
            return requiredString(row, "domain_id") === item.domainId
              && equalBytes(
                requiredBytes(row, "package_hash"),
                item.packageHash,
              )
              && equalBytes(
                requiredBytes(row, "expected_provider_head_hash"),
                item.expectedProviderHeadHash,
              )
              && equalBytes(
                requiredBytes(row, "package_bytes"),
                item.keyPackageBytes,
              );
          })
        ) {
          return {
            status: "duplicate",
            publishedCount: packages.length,
          };
        }
        return { status: "conflicting_state" };
      }

      const bounds = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          unconsumed_count: count().as("unconsumed_count"),
        }).from(humanCryptoDeviceKeyPackages).where(and(
          eq(humanCryptoDeviceKeyPackages.deviceId, first.deviceId),
          isNull(humanCryptoDeviceKeyPackages.consumedAt),
        )),
      );
      if (bounds.length !== 1) {
        throw new Error("Device join package bounds lookup failed");
      }
      const unconsumed = requiredCounter(bounds[0]!, "unconsumed_count");
      if (
        unconsumed !== currentCount
        || unconsumed + packages.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.keyPackagesPerDevice
      ) return { status: "bound_reached" };

      for (const item of packages) {
        const inserted = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(humanCryptoDeviceKeyPackages).values({
            deviceId: item.deviceId,
            domainId: item.domainId,
            expectedProviderHeadHash: item.expectedProviderHeadHash,
            generation: item.generation,
            packageId: item.packageId,
            packageHash: item.packageHash,
            formatVersion: 1,
            packageBytes: item.keyPackageBytes,
            createdAt: timestampSql(item.createdAt),
            expiresAt: timestampSql(item.expiresAt),
            consumedAt: null,
            consumingOperationId: null,
          }).returning({
            package_id: humanCryptoDeviceKeyPackages.packageId,
          }),
        );
        if (inserted.length !== 1) {
          throw new Error("Device join package insert failed");
        }
      }
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          keyPackageGeneration: first.generation,
          keyPackageCount: currentCount + packages.length,
          revision: currentDeviceRevision + 1,
        }).where(and(
          eq(humanCryptoDevices.deviceId, first.deviceId),
          eq(humanCryptoDevices.keyPackageGeneration, currentGeneration),
          eq(humanCryptoDevices.keyPackageCount, currentCount),
          eq(humanCryptoDevices.revision, currentDeviceRevision),
          inArray(humanCryptoDevices.state, ["pending", "active"]),
        )).returning({ device_id: humanCryptoDevices.deviceId }),
      );
      if (updated.length !== 1) {
        throw new Error("Device join package registry CAS failed");
      }
      if (requiredString(device, "state") === "pending") {
        const gate = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeviceEpochOperations).set({
            expectedDeviceRevision: currentDeviceRevision + 1,
          }).from(cryptoDeliveryOperations).where(and(
            eq(
              cryptoDeviceEpochOperations.operationId,
              cryptoDeliveryOperations.operationId,
            ),
            eq(cryptoDeviceEpochOperations.targetDeviceId, first.deviceId),
            eq(
              cryptoDeviceEpochOperations.expectedDeviceRevision,
              currentDeviceRevision,
            ),
            notInArray(
              cryptoDeliveryOperations.state,
              ["active", "failed", "cancelled"],
            ),
          )).returning({
            operation_id: cryptoDeviceEpochOperations.operationId,
          }),
        );
        if (gate.length !== 1) {
          throw new Error("Device join package activation-gate CAS failed");
        }
      }
      return {
        status: "published",
        publishedCount: packages.length,
      };
    });
  }

  claim(input: {
    readonly deviceId: string;
    readonly domainId: string;
    readonly generation: number;
    readonly operationId: string;
    readonly now: number;
  }): Promise<ClaimDeviceJoinPackageResult> {
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`device-key-packages/${input.deviceId}`],
      );
      const rows = await transaction.query(
        `SELECT p.device_id, d.state AS device_state,
                d.revision AS device_revision, p.generation,
                p.package_id, p.domain_id, p.expected_provider_head_hash,
                p.package_hash, p.format_version, p.package_bytes,
                floor(extract(epoch from p.expires_at) * 1000)::bigint
                  AS expires_at_ms,
                p.consumed_at, p.consuming_operation_id,
                h.state_hash AS provider_head_hash
           FROM human_crypto_device_key_packages p
           JOIN human_crypto_devices d ON d.device_id = p.device_id
           JOIN crypto_domain_provider_heads h ON h.domain_id = p.domain_id
          WHERE p.device_id = $1
            AND p.domain_id = $2
            AND p.generation = $3
            AND p.consumed_at IS NULL
          ORDER BY p.created_at, p.package_id
          LIMIT 1
          FOR UPDATE OF p, d, h`,
        [input.deviceId, input.domainId, input.generation],
      );
      if (rows.length === 0) return { status: "missing" };
      if (rows.length !== 1) {
        throw new Error("Device join package claim returned multiple rows");
      }
      const row = rows[0]!;
      if (
        !["pending", "active"].includes(
          requiredString(row, "device_state"),
        )
        || requiredCounter(row, "expires_at_ms") <= input.now
        || row["consumed_at"] !== null
        || nullableString(row, "consuming_operation_id") !== null
        || !equalBytes(
          requiredBytes(row, "expected_provider_head_hash"),
          requiredBytes(row, "provider_head_hash"),
        )
      ) return { status: "stale_state" };

      const packageId = requiredString(row, "package_id");
      const currentDeviceRevision = requiredCounter(row, "device_revision");
      const claimed = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDeviceKeyPackages).set({
          consumedAt: timestampSql(input.now),
          consumingOperationId: input.operationId,
        }).where(and(
          eq(humanCryptoDeviceKeyPackages.deviceId, input.deviceId),
          eq(humanCryptoDeviceKeyPackages.domainId, input.domainId),
          eq(humanCryptoDeviceKeyPackages.generation, input.generation),
          eq(humanCryptoDeviceKeyPackages.packageId, packageId),
          isNull(humanCryptoDeviceKeyPackages.consumedAt),
          exists(
            cryptoTypedDb.select({ value: sql`1` })
              .from(cryptoDeliveryOperations)
              .where(and(
                eq(
                  cryptoDeliveryOperations.operationId,
                  input.operationId,
                ),
                notInArray(
                  cryptoDeliveryOperations.state,
                  ["active", "failed", "cancelled"],
                ),
              )),
          ),
        )).returning({
          package_id: humanCryptoDeviceKeyPackages.packageId,
        }),
      );
      if (claimed.length !== 1) return { status: "stale_state" };
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          keyPackageCount: sql`${humanCryptoDevices.keyPackageCount} - 1`,
          revision: currentDeviceRevision + 1,
        }).where(and(
          eq(humanCryptoDevices.deviceId, input.deviceId),
          eq(humanCryptoDevices.keyPackageGeneration, input.generation),
          gt(humanCryptoDevices.keyPackageCount, 0),
          eq(humanCryptoDevices.revision, currentDeviceRevision),
        )).returning({ device_id: humanCryptoDevices.deviceId }),
      );
      if (updated.length !== 1) {
        throw new Error("Device join package count CAS failed");
      }
      if (requiredString(row, "device_state") === "pending") {
        const gate = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeviceEpochOperations).set({
            expectedDeviceRevision: currentDeviceRevision + 1,
          }).where(and(
            eq(cryptoDeviceEpochOperations.operationId, input.operationId),
            eq(cryptoDeviceEpochOperations.targetDeviceId, input.deviceId),
            eq(
              cryptoDeviceEpochOperations.expectedDeviceRevision,
              currentDeviceRevision,
            ),
          )).returning({
            operation_id: cryptoDeviceEpochOperations.operationId,
          }),
        );
        if (gate.length !== 1) {
          throw new Error("Device join package claim gate CAS failed");
        }
      }
      return {
        status: "claimed",
        package: Object.freeze({
          packageId,
          packageHash: Uint8Array.from(requiredBytes(row, "package_hash")),
          packageBytes: Uint8Array.from(requiredBytes(row, "package_bytes")),
          formatVersion: 1 as const,
          expectedProviderHeadHash: Uint8Array.from(
            requiredBytes(row, "expected_provider_head_hash"),
          ),
        }),
      };
    });
  }

  /**
   * Claims a package or returns the byte-identical package already consumed by
   * this operation. Client-driven Domain transitions need this narrow replay
   * seam because an HTTP response can be lost after the durable claim.
   */
  async claimOrReplay(input: {
    readonly deviceId: string;
    readonly domainId: string;
    readonly generation: number;
    readonly operationId: string;
    readonly now: number;
  }): Promise<ClaimDeviceJoinPackageResult> {
    const replay = async (): Promise<ClaimDeviceJoinPackageResult | null> => {
      const rows = await this.handle.query(
        `SELECT package_id, package_hash, package_bytes, format_version,
                expected_provider_head_hash
           FROM human_crypto_device_key_packages
          WHERE device_id = $1
            AND domain_id = $2
            AND generation = $3
            AND consuming_operation_id = $4
            AND consumed_at IS NOT NULL
          LIMIT 2`,
        [input.deviceId, input.domainId, input.generation, input.operationId],
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1 || requiredCounter(rows[0]!, "format_version") !== 1) {
        throw new Error("Device join package replay is inconsistent");
      }
      const row = rows[0]!;
      return {
        status: "claimed",
        package: Object.freeze({
          packageId: requiredString(row, "package_id"),
          packageHash: Uint8Array.from(requiredBytes(row, "package_hash")),
          packageBytes: Uint8Array.from(requiredBytes(row, "package_bytes")),
          formatVersion: 1 as const,
          expectedProviderHeadHash: Uint8Array.from(
            requiredBytes(row, "expected_provider_head_hash"),
          ),
        }),
      };
    };
    const existing = await replay();
    if (existing !== null) return existing;
    const claimed = await this.claim(input);
    if (claimed.status !== "missing") return claimed;
    return (await replay()) ?? claimed;
  }
}
