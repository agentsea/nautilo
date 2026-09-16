import { execSync } from "node:child_process";
import { resolveInstance } from "@nautilo/config";
import { inspectSnapshotTables } from "./snapshots";
import { DATA_TABLES } from "./docker-db";
import { RESTORE_MIGRATIONS } from "./restore-migrations";
import type { TableRowCount } from "./snapshots";
import type { RestoreMigration } from "./restore-migrations";

/**
 * Preflight — dry-run a restore and report what would happen, without
 * touching the database.
 *
 * For each table present in the dump, we look at:
 *
 *   1. Does the table still exist today? (DROP TABLE at some migration)
 *   2. Do the dump's COPY columns match today's column list?
 *        a. Extra columns today → OK, COPY will default/null them
 *        b. Missing columns today → COPY would fail (column dropped)
 *        c. Mismatch → attempt to match via the restore-migration registry
 *   3. Is there a restore-migration registered for this table? Then
 *      classify as REMAP (custom INSERT hook) or SKIP-COPY (drop the
 *      COPY, hook handles it all).
 *
 * The output is safe to print verbatim — each entry is human-readable.
 */

export type TableStatus =
  | "OK"
  | "OK_ADDITIVE"      // new columns today; COPY still works
  | "REMAP"            // registry hook handles it
  | "SKIP_NOT_IN_TARGETS" // dump has data but DATA_TABLES doesn't list it
  | "SKIP_INTENTIONAL" // registered non-portable state is deliberately discarded
  | "SKIP_TABLE_MISSING"
  | "SKIP_COLUMN_DROPPED"
  | "SKIP_COLUMN_REQUIRED";

export interface TablePreflight {
  table: string;
  rowCount: number;
  dumpColumns: string[];
  currentColumns: string[] | null;
  addedColumns: string[];
  removedColumns: string[];
  nonNullableAdded: string[];
  status: TableStatus;
  note: string;
}

export interface PreflightReport {
  snapshot: string;
  /**
   * Always `true` in a successful return — we require Docker to be
   * running for a meaningful diff (otherwise every table would report
   * OK by default). Field retained so future non-blocking variants
   * of preflight can return `false` here without breaking callers.
   */
  dockerRunning: boolean;
  tables: TablePreflight[];
  totalRowsDump: number;
  totalRowsEstimatedRestored: number;
}

/** Mirrors restoreFromGzip's canonical data table allowlist. */
export const RESTORE_DATA_TABLES: ReadonlySet<string> = new Set(DATA_TABLES);

/**
 * Classify a table that exists in the snapshot but no longer exists in the
 * current schema. The intentional-skip registry is consulted FIRST: a
 * registered non-portable table is an explicit, successful discard rather
 * than unhandled data loss. Every other dropped table retains the blocking
 * SKIP_TABLE_MISSING status.
 */
export function classifyDroppedTable(
  table: TableRowCount,
  registryEntry: RestoreMigration | undefined,
): TablePreflight {
  if (registryEntry?.intentionalSkip === true) {
    return {
      table: table.table,
      rowCount: table.rowCount,
      dumpColumns: table.columns,
      currentColumns: null,
      addedColumns: [],
      removedColumns: [],
      nonNullableAdded: [],
      status: "SKIP_INTENTIONAL",
      note: `Intentional registered skip — ${registryEntry.reason}`,
    };
  }

  return {
    table: table.table,
    rowCount: table.rowCount,
    dumpColumns: table.columns,
    currentColumns: null,
    addedColumns: [],
    removedColumns: [],
    nonNullableAdded: [],
    status: "SKIP_TABLE_MISSING",
    note: "Table dropped since snapshot — rows discarded.",
  };
}

/** True only when data-bearing schema drift has no registered restore path. */
export function isUnhandledDataBearingDrift(table: TablePreflight): boolean {
  return (
    table.rowCount > 0 &&
    (table.status === "SKIP_TABLE_MISSING" ||
      table.status === "SKIP_COLUMN_DROPPED" ||
      table.status === "SKIP_COLUMN_REQUIRED")
  );
}

export async function preflight(name: string, options?: {
  container?: string;
  db?: string;
}): Promise<PreflightReport> {
  const container =
    options?.container ?? resolveInstance().compose.containers.legacyPostgres;
  const db = options?.db ?? "nautilo";

  const dockerRunning = isContainerUp(container);
  if (!dockerRunning) {
    // Without the live schema to diff against, preflight's output
    // would be misleading (every table would fall through to "OK").
    // Fail fast with a clear error so the operator starts the
    // container before relying on the verdict.
    throw new Error(
      `Docker container "${container}" is not running. Preflight needs ` +
        `the live schema to diff against the dump. Start it with \`bun run db:dev\` ` +
        `and re-run preflight. (If you only want to see the dump's contents, use \`dev:inspect <name>\`.)`,
    );
  }
  const dumpTables = await inspectSnapshotTables(name);

  const current = getCurrentSchema(container, db);

  const registryByTable = new Map(RESTORE_MIGRATIONS.map((m) => [m.table, m]));

  const tables: TablePreflight[] = dumpTables.map((t: TableRowCount) => {
    const qualified = `public.${t.table}`;
    const currentCols = current.get(qualified) ?? null;
    const registryEntry = registryByTable.get(qualified);

    // 1. Table dropped entirely. Intentional registered skips must win
    // before the generic dropped-table failure, otherwise a removed
    // non-portable table (e.g. D425 server_maintenance) is incorrectly
    // reported as unhandled data loss.
    if (dockerRunning && currentCols === null) {
      return classifyDroppedTable(t, registryEntry);
    }

    // 2. Table not in the restore targets at all (e.g. channel_identities).
    if (!RESTORE_DATA_TABLES.has(qualified)) {
      return {
        table: t.table,
        rowCount: t.rowCount,
        dumpColumns: t.columns,
        currentColumns: currentCols,
        addedColumns: [],
        removedColumns: [],
        nonNullableAdded: [],
        status: "SKIP_NOT_IN_TARGETS",
        note: "Table not in DATA_TABLES allowlist — rows discarded.",
      };
    }

    // 3. Registry rule covers it.
    if (registryEntry) {
      return {
        table: t.table,
        rowCount: t.rowCount,
        dumpColumns: t.columns,
        currentColumns: currentCols,
        addedColumns: currentCols ? diff(currentCols, t.columns) : [],
        removedColumns: currentCols ? diff(t.columns, currentCols) : [],
        nonNullableAdded: [],
        status: "REMAP",
        note: registryEntry.reason,
      };
    }

    // 4. Column drift.
    if (currentCols) {
      const removedFromCurrent = diff(t.columns, currentCols); // dump has, current missing
      const addedInCurrent = diff(currentCols, t.columns);     // current has, dump missing

      if (removedFromCurrent.length > 0) {
        return {
          table: t.table,
          rowCount: t.rowCount,
          dumpColumns: t.columns,
          currentColumns: currentCols,
          addedColumns: addedInCurrent,
          removedColumns: removedFromCurrent,
          nonNullableAdded: [],
          status: "SKIP_COLUMN_DROPPED",
          note:
            `Dump references column(s) that no longer exist: ${removedFromCurrent.join(", ")}. ` +
            `Add a restore-migration rule to remap.`,
        };
      }

      if (addedInCurrent.length > 0) {
        // Check if any of the added columns are NOT NULL without a default.
        const blocking = addedInCurrent.filter((col) =>
          !isColumnNullableOrDefaulted(container, db, qualified, col),
        );
        if (blocking.length > 0) {
          return {
            table: t.table,
            rowCount: t.rowCount,
            dumpColumns: t.columns,
            currentColumns: currentCols,
            addedColumns: addedInCurrent,
            removedColumns: [],
            nonNullableAdded: blocking,
            status: "SKIP_COLUMN_REQUIRED",
            note:
              `Current schema added NOT NULL columns with no default: ${blocking.join(", ")}. ` +
              `Add a restore-migration rule to supply values.`,
          };
        }

        return {
          table: t.table,
          rowCount: t.rowCount,
          dumpColumns: t.columns,
          currentColumns: currentCols,
          addedColumns: addedInCurrent,
          removedColumns: [],
          nonNullableAdded: [],
          status: "OK_ADDITIVE",
          note:
            `Current schema added ${addedInCurrent.length} nullable/defaulted column(s); ` +
            `COPY omits them cleanly.`,
        };
      }
    }

    return {
      table: t.table,
      rowCount: t.rowCount,
      dumpColumns: t.columns,
      currentColumns: currentCols,
      addedColumns: [],
      removedColumns: [],
      nonNullableAdded: [],
      status: "OK",
      note: "Exact column match.",
    };
  });

  const totalDump = tables.reduce((n, t) => n + t.rowCount, 0);
  const totalRestored = tables
    .filter((t) => t.status === "OK" || t.status === "OK_ADDITIVE" || t.status === "REMAP")
    .reduce((n, t) => n + t.rowCount, 0);

  return {
    snapshot: name,
    dockerRunning,
    tables,
    totalRowsDump: totalDump,
    totalRowsEstimatedRestored: totalRestored,
  };
}

// ---------------------------------------------------------------------------
// Docker / schema probing
// ---------------------------------------------------------------------------

function isContainerUp(container: string): boolean {
  try {
    const out = execSync(
      `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null`,
      { encoding: "utf8" },
    ).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Snapshot the live nautilo DB schema — one column list per table in
 * `public`. Returns a Map; missing tables are absent from the map
 * (caller distinguishes "not in public" vs "exists with these
 * columns").
 */
function getCurrentSchema(container: string, db: string): Map<string, string[] | null> {
  const sql = `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `;
  let out: string;
  try {
    out = execSync(
      `docker exec -i ${container} psql -U postgres -d ${db} -t -A -F '|' -v ON_ERROR_STOP=1`,
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    return new Map();
  }

  const map = new Map<string, string[] | null>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [table, col] = line.split("|");
    if (!table || !col) continue;
    const key = `public.${table}`;
    const existing = map.get(key);
    if (existing) existing.push(col);
    else map.set(key, [col]);
  }
  return map;
}

function isColumnNullableOrDefaulted(
  container: string,
  db: string,
  qualified: string,
  col: string,
): boolean {
  const unq = qualified.replace(/^public\./, "");
  const sql = `
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${unq.replace(/'/g, "''")}'
      AND column_name = '${col.replace(/'/g, "''")}';
  `;
  try {
    const out = execSync(
      `docker exec -i ${container} psql -U postgres -d ${db} -t -A -F '|' -v ON_ERROR_STOP=1`,
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!out) return true; // unknown column — let it through
    const [nullable, defaultValue] = out.split("|");
    return nullable === "YES" || Boolean(defaultValue);
  } catch {
    return true;
  }
}

function diff(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => !setB.has(x));
}
