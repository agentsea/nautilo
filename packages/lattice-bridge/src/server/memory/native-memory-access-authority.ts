import {
  and, desc, eq, inArray, namespaceDomainKeyBindings, namespaceDomainKeyHeads,
} from "@nautilo/db";
import type {
  MemoryNativeNamespaceAccessEntryV1,
  MemoryNativeNamespaceAuthorityEntryV1,
} from "@nautilo/lattice-crypto/wire";

import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value as number;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${field} must be a 32-byte digest`);
  }
  return Uint8Array.from(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function memoryNativeAccessEntryMatchesBindingRow(
  entry: MemoryNativeNamespaceAuthorityEntryV1,
  row: DatabaseRow,
): boolean {
  const digest = rowBytes(row, "retained_authority_set_digest");
  return rowString(row, "namespace_id") === entry.namespaceId
    && rowCounter(row, "namespace_access_revision")
      === entry.namespaceAccessRevision
    && rowCounter(row, "namespace_current_generation") === entry.keyGeneration
    && equalBytes(digest, entry.headDigest)
    && equalBytes(digest, entry.publicationDigest)
    && equalBytes(digest, entry.publicationSetDigest)
    && equalBytes(digest, entry.audienceFingerprint);
}

/**
 * Revalidates public native Domain-V2 coordinates captured by a Memory access
 * preparation. Actor/signature authentication stays with the Human or Agent
 * protocol; this helper owns only the shared Namespace-head tuple.
 */
async function inspectMemoryNativeAccessEntries(input: Readonly<{
  executor: CryptoPostgresExecutor;
  entries: readonly MemoryNativeNamespaceAccessEntryV1[];
}>): Promise<boolean> {
  for (const entry of input.entries) {
    const query = cryptoTypedDb.select({
        namespace_id: namespaceDomainKeyBindings.namespaceId,
        namespace_access_revision:
          namespaceDomainKeyBindings.namespaceAccessRevision,
        namespace_current_generation:
          namespaceDomainKeyBindings.namespaceCurrentGeneration,
        retained_authority_set_digest:
          namespaceDomainKeyBindings.retainedAuthoritySetDigest,
      }).from(namespaceDomainKeyBindings).where(and(
        eq(namespaceDomainKeyBindings.namespaceId, entry.namespaceId),
        eq(namespaceDomainKeyBindings.keyClass, "ai"),
        eq(
          namespaceDomainKeyBindings.namespaceAccessRevision,
          entry.namespaceAccessRevision,
        ),
        eq(
          namespaceDomainKeyBindings.namespaceCurrentGeneration,
          entry.keyGeneration,
        ),
        inArray(namespaceDomainKeyBindings.state, ["active", "stale"]),
      )).orderBy(desc(namespaceDomainKeyBindings.bundleRevision)).limit(1);
    const rows = await executeTypedCryptoQuery(
      input.executor,
      query,
    );
    if (rows.length !== 1) return false;
    if (!memoryNativeAccessEntryMatchesBindingRow(entry, rows[0]!)) return false;
  }
  return true;
}

export function memoryNativeAccessEntriesAuthentic(input: Readonly<{
  executor: CryptoPostgresExecutor;
  entries: readonly MemoryNativeNamespaceAccessEntryV1[];
}>): Promise<boolean> {
  return inspectMemoryNativeAccessEntries(input);
}

export function lockMemoryNativeAccessEntries(input: Readonly<{
  executor: CryptoPostgresExecutor;
  entries: readonly MemoryNativeNamespaceAuthorityEntryV1[];
}>): Promise<boolean> {
  return lockCurrentMemoryNativeAccessEntries(input);
}

/** Locks and verifies entries that claim the exact current Namespace head.
 * Historical retained-envelope entries must use the unlocked authenticator
 * plus a separately supplied current-head authority inventory. */
export async function lockCurrentMemoryNativeAccessEntries(input: Readonly<{
  executor: CryptoPostgresExecutor;
  entries: readonly MemoryNativeNamespaceAuthorityEntryV1[];
}>): Promise<boolean> {
  for (const entry of input.entries) {
    const rows = await executeTypedCryptoQuery(input.executor,
      cryptoTypedDb.select({
        namespace_id: namespaceDomainKeyHeads.namespaceId,
        namespace_access_revision: namespaceDomainKeyHeads.namespaceAccessRevision,
        namespace_current_generation: namespaceDomainKeyHeads.namespaceCurrentGeneration,
        retained_authority_set_digest:
          namespaceDomainKeyHeads.retainedAuthoritySetDigest,
      }).from(namespaceDomainKeyHeads).where(and(
        eq(namespaceDomainKeyHeads.namespaceId, entry.namespaceId),
        eq(namespaceDomainKeyHeads.keyClass, "ai"),
      )).limit(2).for("share", { of: namespaceDomainKeyHeads }));
    if (rows.length !== 1
      || !memoryNativeAccessEntryMatchesBindingRow(entry, rows[0]!)) return false;
  }
  return true;
}
