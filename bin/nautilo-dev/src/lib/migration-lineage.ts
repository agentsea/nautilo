import approvedCommentRedactions from "../../../../dev/tools/db-migration-safety/comment-redactions.json";
import approvedAppliedRewrites from "./applied-migration-rewrites.json";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface MigrationLineageEntry {
  index: number;
  tag: string;
  createdAt: number;
  sha256: string;
}

export interface DatabaseMigrationEntry {
  createdAt: number;
  sha256: string;
}

export function parseDatabaseMigrationLedger(raw: string): DatabaseMigrationEntry[] {
  if (raw.trim() === "") return [];
  return raw.trim().split("\n").map((line, position) => {
    const separator = line.indexOf("|");
    const createdAt = Number(line.slice(0, separator));
    const sha256 = line.slice(separator + 1);
    if (
      separator < 1 ||
      !Number.isFinite(createdAt) ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error(`Invalid database migration row at position ${position}`);
    }
    return { createdAt, sha256 };
  });
}

export interface MigrationLineageReconciliationPlan {
  readonly kind: "exact-prefix" | "divergent";
  readonly commonPrefixLength: number;
  readonly alreadyAppliedCheckout: readonly MigrationLineageEntry[];
  readonly missingCheckout: readonly MigrationLineageEntry[];
  readonly sourceOnly: readonly MigrationLineageEntry[];
}

interface RawMigrationJournalEntry {
  idx?: unknown;
  when?: unknown;
  tag?: unknown;
}

interface MigrationJournal {
  entries?: RawMigrationJournalEntry[];
}

function assertJournalEntry(
  entry: RawMigrationJournalEntry | undefined,
  position: number,
): MigrationJournalEntry {
  if (
    entry === undefined ||
    !Number.isInteger(entry.idx) ||
    typeof entry.when !== "number" ||
    !Number.isFinite(entry.when) ||
    typeof entry.tag !== "string" ||
    entry.tag.trim() === ""
  ) {
    throw new Error(`Invalid Drizzle journal entry at position ${position}`);
  }
  return {
    idx: entry.idx as number,
    when: entry.when,
    tag: entry.tag,
  };
}

export async function readCheckoutMigrationLineage(
  migrationsDir: string,
): Promise<MigrationLineageEntry[]> {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const parsed = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`Invalid Drizzle journal at ${journalPath}: entries must be an array`);
  }

  const lineage: MigrationLineageEntry[] = [];
  for (let position = 0; position < parsed.entries.length; position++) {
    const journal = assertJournalEntry(parsed.entries[position], position);
    if (journal.idx !== position) {
      throw new Error(
        "Active branch migration numbering is invalid: " +
          `position ${position} declares index ${journal.idx}`,
      );
    }
    const sql = await readFile(join(migrationsDir, `${journal.tag}.sql`), "utf8");
    lineage.push({
      index: journal.idx,
      tag: journal.tag,
      createdAt: journal.when,
      sha256: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return lineage;
}

export function mapDatabaseLedgerToCheckout(
  database: readonly DatabaseMigrationEntry[],
  checkout: readonly MigrationLineageEntry[],
): MigrationLineageEntry[] {
  if (database.length > checkout.length) {
    const sourceLast = database.at(-1);
    const checkoutLast = checkout.at(-1);
    throw new Error(
      "Active branch migration journal is older than the running source: " +
        `source has ${database.length} migration(s)` +
        (sourceLast === undefined ? "" : ` through timestamp ${sourceLast.createdAt}`) +
        `, while the branch has ${checkout.length}` +
        (checkoutLast === undefined
          ? ""
          : ` through timestamp ${checkoutLast.createdAt}`),
    );
  }
  const mapped: MigrationLineageEntry[] = [];
  for (let index = 0; index < database.length; index++) {
    const actual = database[index]!;
    const expected = checkout[index];
    if (!Number.isFinite(actual.createdAt)) {
      throw new Error(`Database migration ledger has an invalid timestamp at index ${index}`);
    }
    if (
      expected === undefined ||
      expected.createdAt !== actual.createdAt ||
      expected.sha256 !== actual.sha256
    ) {
      const mismatch =
        expected === undefined
          ? "the branch entry is missing"
          : expected.createdAt !== actual.createdAt
            ? `source timestamp ${actual.createdAt}, branch timestamp ${expected.createdAt}`
            : `timestamp ${actual.createdAt} has a different migration hash`;
      throw new Error(
        "Active branch migration history is incompatible with the running " +
          `source at index ${index}: ${mismatch}`,
      );
    }
    mapped.push(expected);
  }
  return mapped;
}

function assertDatabaseMigrationEntry(
  entry: DatabaseMigrationEntry | undefined,
  position: number,
): DatabaseMigrationEntry {
  if (
    entry === undefined ||
    !Number.isFinite(entry.createdAt) ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    throw new Error(`Database migration ledger has an invalid entry at index ${position}`);
  }
  return entry;
}

/**
 * Capture the source ledger as manifest evidence without pretending it is an
 * exact prefix of the active checkout. SQL hashes retain their checkout tag
 * when one exists; source-only SQL receives a deterministic opaque tag.
 */
export function captureDatabaseMigrationLineage(
  database: readonly DatabaseMigrationEntry[],
  checkout: readonly MigrationLineageEntry[],
): MigrationLineageEntry[] {
  const checkoutTagByHash = new Map<string, string>();
  for (const entry of checkout) {
    if (!checkoutTagByHash.has(entry.sha256)) checkoutTagByHash.set(entry.sha256, entry.tag);
  }
  return database.map((raw, index) => {
    const entry = assertDatabaseMigrationEntry(raw, index);
    return {
      index,
      tag: checkoutTagByHash.get(entry.sha256) ??
        `source-opaque-${index.toString().padStart(4, "0")}-${entry.sha256.slice(0, 12)}`,
      createdAt: entry.createdAt,
      sha256: entry.sha256,
    };
  });
}

function sameLineageEntry(
  source: MigrationLineageEntry,
  checkout: MigrationLineageEntry,
): boolean {
  return source.index === checkout.index &&
    source.tag === checkout.tag &&
    source.createdAt === checkout.createdAt &&
    source.sha256 === checkout.sha256;
}

/** Only exact maintainer-recorded rewrites can alias an already applied hash. */
function isApprovedAppliedRewrite(
  source: MigrationLineageEntry,
  checkout: MigrationLineageEntry,
): boolean {
  if (source.createdAt !== checkout.createdAt) return false;
  return approvedCommentRedactions.redactions.some((redaction) =>
      redaction.path === `packages/db/src/migrations/${checkout.tag}.sql` &&
      redaction.beforeSha256 === source.sha256 &&
      redaction.afterSha256 === checkout.sha256,
    ) || approvedAppliedRewrites.rewrites.some((rewrite) =>
      rewrite.path === `packages/db/src/migrations/${checkout.tag}.sql` &&
      rewrite.createdAt === checkout.createdAt &&
      rewrite.beforeSha256 === source.sha256 &&
      rewrite.afterSha256 === checkout.sha256,
    );
}

/**
 * Reconcile captured source evidence with the active checkout. Divergent
 * histories are admitted only when their leading entries are exactly shared;
 * after that boundary, SQL hash is the migration identity, independent of the
 * source's historical index, timestamp, or opaque tag.
 */
export function planMigrationLineageReconciliation(
  source: readonly MigrationLineageEntry[],
  checkout: readonly MigrationLineageEntry[],
): MigrationLineageReconciliationPlan {
  let commonPrefixLength = 0;
  while (
    commonPrefixLength < source.length &&
    commonPrefixLength < checkout.length &&
    sameLineageEntry(source[commonPrefixLength]!, checkout[commonPrefixLength]!)
  ) {
    commonPrefixLength += 1;
  }

  if (source.length > 0 && commonPrefixLength === source.length) {
    return {
      kind: "exact-prefix",
      commonPrefixLength,
      alreadyAppliedCheckout: checkout.slice(0, commonPrefixLength),
      missingCheckout: checkout.slice(commonPrefixLength),
      sourceOnly: [],
    };
  }
  if (commonPrefixLength === 0) {
    throw new Error(
      "Source and active checkout migration ledgers are unrelated: no exact common prefix",
    );
  }

  const sourceHashes = new Set(source.map((entry) => entry.sha256));
  const checkoutHashes = new Set(checkout.map((entry) => entry.sha256));
  const isApplied = (entry: MigrationLineageEntry) => sourceHashes.has(entry.sha256) ||
    source.some((prior) => isApprovedAppliedRewrite(prior, entry));
  return {
    kind: "divergent",
    commonPrefixLength,
    alreadyAppliedCheckout: checkout.filter(isApplied),
    missingCheckout: checkout.filter((entry) => !isApplied(entry)),
    sourceOnly: source.filter((entry) => !checkoutHashes.has(entry.sha256) &&
      !checkout.some((current) => isApprovedAppliedRewrite(entry, current))),
  };
}

export function assertExactMigrationPrefix(
  source: readonly MigrationLineageEntry[],
  checkout: readonly MigrationLineageEntry[],
): void {
  if (source.length === 0) {
    throw new Error("Running source has no applied Drizzle migrations");
  }
  if (source.length > checkout.length) {
    const sourceLast = source.at(-1)!;
    const checkoutLast = checkout.at(-1);
    throw new Error(
      "Active branch migration journal is older than the running source: " +
        `source is at index ${sourceLast.index} (timestamp ${sourceLast.createdAt}), ` +
        (checkoutLast === undefined
          ? "but the branch has no migrations"
          : `but the branch ends at index ${checkoutLast.index} ` +
            `(timestamp ${checkoutLast.createdAt})`),
    );
  }
  for (let index = 0; index < source.length; index++) {
    const actual = source[index]!;
    const expected = checkout[index];
    if (expected === undefined) {
      throw new Error(`Active branch is missing source migration index ${index}`);
    }
    if (
      actual.index !== expected.index ||
      actual.createdAt !== expected.createdAt
    ) {
      throw new Error(
        "Active branch migration numbering/timestamps are incompatible with " +
          `the running source at index ${index}: source timestamp ` +
          `${actual.createdAt}, branch timestamp ${expected.createdAt}`,
      );
    }
    if (actual.sha256 !== expected.sha256 || actual.tag !== expected.tag) {
      throw new Error(
        "Active branch migration history diverges from the running source at " +
          `index ${index} (source timestamp ${actual.createdAt}, ` +
          `branch migration ${expected.tag})`,
      );
    }
  }
  let migrationTimestampFloor = source.reduce(
    (highest, entry) => Math.max(highest, entry.createdAt),
    Number.NEGATIVE_INFINITY,
  );
  for (let index = source.length; index < checkout.length; index++) {
    const pending = checkout[index]!;
    if (pending.createdAt <= migrationTimestampFloor) {
      throw new Error(
        "Active branch migration timestamp is too old to run after the " +
          `source ledger: ${pending.tag} at index ${pending.index} uses ` +
          `${pending.createdAt}, but it must be newer than ` +
          `${migrationTimestampFloor}`,
      );
    }
    migrationTimestampFloor = pending.createdAt;
  }
}
