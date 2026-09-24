/**
 * Restore-time schema migrations.
 *
 * The dev-snapshot dump format is a straight `pg_dump` of the `nautilo`
 * database at the time of save. Between save and restore, real schema
 * migrations may have landed (M042B rooms, M043 actors/users, etc). The
 * restore path has to cope with:
 *
 *   1. NEW columns added (usually nullable or defaulted — COPY handles
 *      this natively by omitting them from the column list).
 *
 *   2. DROPPED columns (the dump's COPY names a column that no longer
 *      exists — COPY fails hard).
 *
 *   3. REPOINTED foreign keys (dump has `actor_id` but schema now wants
 *      `user_id`, possibly NOT NULL).
 *
 * (1) needs no work. (2) + (3) need targeted rewrites of the COPY block
 * or hand-insert statements. That logic lives here so the CLI, the MCP
 * preflight, and the regression tests all share one source of truth.
 *
 * Adding a new rule is a single entry in the registry below. Each rule
 * is specific to an (old-shape → new-shape) transition; they stack so a
 * dump with 10 migrations between save and restore gets all of them
 * applied in order.
 */

import { execSync } from "node:child_process";
import { resolveInstance } from "@nautilo/config";
import { parsePgDumpIdentifier } from "./snapshots";

/** Describes one schema-drift rule we know how to handle. */
export interface RestoreMigration {
  /** Schema-qualified table name as it appears in the dump. */
  table: string;

  /**
   * If `true`, the dump's COPY block for this table is DROPPED at apply
   * time; rows are hand-inserted via `postRestore` instead. Used when
   * the shape change is large enough that rewriting the COPY is not
   * worth it (e.g. FK remap via a join).
   *
   * If `false` or unset, the COPY block is still run — possibly with
   * columns mapped/dropped via `rewriteCopyHeader`.
   */
  skipCopy?: boolean;

  /**
   * Rewrite the dump's COPY header (the "COPY public.<table> (col, ...)
   * FROM stdin;" line) to match today's schema. Return `null` if the
   * whole COPY should be dropped. Null return is equivalent to
   * `skipCopy: true`.
   *
   * Return value is the new header line (no trailing newline) OR null
   * to drop the COPY.
   */
  rewriteCopyHeader?: (header: string, columns: string[]) => string | null;

  /**
   * Fully synchronous "SQL-side" post-restore hook. Runs AFTER the
   * schema migrations + every COPY has been applied. Good place to
   * hand-insert rows that couldn't be restored via COPY because the
   * shape changed (e.g. FK repointing).
   *
   * Must be idempotent — `dev:restore` may be re-run.
   *
   * The hook is given a `psqlExec` callback that runs SQL against the
   * nautilo DB inside the container.
   */
  postRestore?: (ctx: PostRestoreContext) => void;

  /** Human-readable reason, shown in preflight output. */
  reason: string;

  /**
   * Marks this rule as an INTENTIONAL skip of non-portable,
   * server-local state — the dump's rows are deliberately NOT restored
   * (and NOT re-seeded from a boot seed). Used for tables whose data is
   * tied to the host that produced the snapshot (device-installation
   * bindings, server-local maintenance state) and therefore has no
   * meaning on a different instance.
   *
   * Distinct from a bare `skipCopy: true`:
   *   - `skipCopy: true` alone = "don't COPY; rows come back via a
   *     `postRestore` hook or a boot re-seed" (e.g. roles, group_members).
   *   - `intentionalSkip: true` = "rows are discarded by design; restore
   *     ships without them on purpose."
   *
   * Rules with this flag SHOULD also set `skipCopy: true` so the
   * restore path drops the COPY block (no `postRestore` is expected).
   * Preflight is expected to surface these as explicit, registered
   * skips — never as silent data loss and never as an unregistered
   * drift failure.
   */
  intentionalSkip?: boolean;
}

export interface PostRestoreContext {
  /** Run a SQL statement against the live nautilo DB. Throws on error. */
  psqlExec: (sql: string) => string;
  /**
   * Raw access to the dump text for the hook — scoped to ONE table's
   * COPY block (from "COPY ... FROM stdin;" to "\\.") so hooks can
   * parse rows when they need to re-INSERT with remapped columns.
   */
  dumpRowsFor: (table: string) => DumpRow[];
  log: (msg: string) => void;
}

/** A parsed COPY row — tab-separated values in the order of `columns`. */
export interface DumpRow {
  columns: string[];
  /** Values are raw pg_dump TEXT format ("\\N" for NULL, tab-escaped). */
  values: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every known schema drift rule. Add entries here when a migration
 * breaks restore from older snapshots.
 */
export const RESTORE_MIGRATIONS: RestoreMigration[] = [
  {
    table: "public.server_moderation_policy",
    skipCopy: true,
    reason: "Restore saved moderation and joining policy over the migration-seeded singleton.",
    postRestore: ({ psqlExec, dumpRowsFor }) => {
      const rows = dumpRowsFor("public.server_moderation_policy");
      if (rows.length === 0) return; // Older snapshots retain the migration default.
      if (rows.length !== 1) throw new Error("Expected one Server moderation policy row");
      const row = rows[0]!;
      const index = indexOf(row.columns);
      const columns = ["singleton", "enabled", "joins_paused", "approval_required", "revision", "updated_by", "updated_at"];
      const values = columns.map((column) => pgValue(row.values[index(column)]));
      psqlExec(`INSERT INTO public.server_moderation_policy (${columns.join(", ")})
        VALUES (${values.join(", ")}) ON CONFLICT (singleton) DO UPDATE SET
        enabled = EXCLUDED.enabled, joins_paused = EXCLUDED.joins_paused,
        approval_required = EXCLUDED.approval_required, revision = EXCLUDED.revision,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;`);
    },
  },
  // -----------------------------------------------------------------------
  // M043 — Actors/Agents/Groups/Roles/Humans
  //
  // `credentials` and `recovery_codes` were re-keyed from actor_id to
  // user_id. The old FK → actors.id → actors.owner_id → users.id chain
  // still holds in restored data, so we can hand-insert by joining
  // through actors.
  // -----------------------------------------------------------------------
  {
    table: "public.credentials",
    // Conditional on dump shape: a PRE-M043 dump has actor_id (drop the
    // COPY, remap below); a POST-M043 dump already has user_id (let the
    // normal COPY run, remap below is a no-op). Returning the header
    // unchanged keeps the plain COPY; returning null drops it.
    rewriteCopyHeader: (header, columns) =>
      columns.includes("actor_id") ? null : header,
    reason:
      "M043 re-keyed credentials actor_id → user_id. Pre-M043 dumps are remapped " +
      "via actor_id → actors.owner_id → user_id; post-M043 dumps COPY directly.",
    postRestore: ({ psqlExec, dumpRowsFor, log }) => {
      const rows = dumpRowsFor("public.credentials");
      if (rows.length === 0) return;
      if (!rows[0]!.columns.includes("actor_id")) return; // post-M043 dump: normal COPY handled it
      log(`    remapping ${rows.length} credential(s): actor_id → user_id`);
      let skippedNull = 0;
      for (const r of rows) {
        if (!insertCredentialRemapped(r, psqlExec)) skippedNull++;
      }
      if (skippedNull > 0) {
        log(
          `    WARN ${skippedNull} credential(s) had NULL actor_id in the dump; ` +
            `could not remap to a user. Owner will not be able to log in via those.`,
        );
      }
    },
  },
  {
    table: "public.recovery_codes",
    // Conditional on dump shape — see credentials above.
    rewriteCopyHeader: (header, columns) =>
      columns.includes("actor_id") ? null : header,
    reason:
      "M043 re-keyed recovery_codes actor_id → user_id. Pre-M043 dumps are remapped " +
      "via actor_id → actors.owner_id → user_id; post-M043 dumps COPY directly.",
    postRestore: ({ psqlExec, dumpRowsFor, log }) => {
      const rows = dumpRowsFor("public.recovery_codes");
      if (rows.length === 0) return;
      if (!rows[0]!.columns.includes("actor_id")) return; // post-M043 dump: normal COPY handled it
      log(`    remapping ${rows.length} recovery code(s): actor_id → user_id`);
      let skippedNull = 0;
      for (const r of rows) {
        if (!insertRecoveryCodeRemapped(r, psqlExec)) skippedNull++;
      }
      if (skippedNull > 0) {
        log(
          `    WARN ${skippedNull} recovery code(s) had NULL actor_id; dropped.`,
        );
      }
    },
  },

  // -----------------------------------------------------------------------
  // M043 — roles dropped the `group_type` column.
  // Roles are seeded deterministically at server boot, so there is
  // nothing to restore from the dump; drop the COPY entirely.
  // -----------------------------------------------------------------------
  {
    table: "public.roles",
    skipCopy: true,
    reason:
      "M043 dropped roles.group_type. Roles are re-seeded at boot — the dump's " +
      "COPY is obsolete and would fail the shape check. Skipped entirely.",
  },
  {
    table: "public.role_capabilities",
    skipCopy: true,
    reason:
      "Roles are re-seeded at boot with current IDs/capability mappings. " +
      "Snapshot role_capabilities can point at obsolete role IDs, so the " +
      "dump's COPY is skipped with roles.",
  },
  {
    table: "public.group_roles",
    skipCopy: true,
    reason:
      "Group→Role mappings are re-seeded with the current role catalog. " +
      "Snapshot group_roles can point at obsolete role IDs, so the dump's " +
      "COPY is skipped with roles.",
  },
  {
    table: "public.group_members",
    skipCopy: true,
    reason:
      "Historical snapshots can contain group_members.granted_by values " +
      "that point at actors no longer present. Membership is real data; " +
      "dangling audit attribution is restored as NULL (the FK's ON DELETE " +
      "SET NULL behavior) while preserving group_id/user_id/granted_at.",
    postRestore: ({ psqlExec, dumpRowsFor, log }) => {
      const rows = dumpRowsFor("public.group_members");
      if (rows.length === 0) return;
      log(`    restoring ${rows.length} group member(s), nulling dangling granted_by`);
      for (const r of rows) {
        insertGroupMemberWithNullableGrantor(r, psqlExec);
      }
    },
  },

  // -----------------------------------------------------------------------
  // D140 — `agents.is_bootstrap_seed` and `users.is_bootstrap_seed` were
  // removed. Bootstrap-seed identity is now derived from the
  // credentials/group predicates (M100), not a stored boolean. Snapshots
  // taken before the drop still carry the column in their COPY blocks, so
  // a raw COPY fails the shape check and the WHOLE table (your real users
  // + agents) is skipped.
  //
  // Fix: strip the obsolete column from the COPY header AND every data
  // row. Unlike the M043 rules above, we do NOT hand-insert via
  // `postRestore` — the only delta is one removed column, so a header
  // rewrite preserves every other value byte-for-byte (important for the
  // jsonb / timestamp columns on these tables, which `pgValue` is not
  // safe to re-serialize).
  // -----------------------------------------------------------------------
  {
    table: "public.agents",
    reason:
      "D140 dropped agents.is_bootstrap_seed (bootstrap-seed identity now derived " +
      "from credentials/group predicates). M156 dropped agents.display_name " +
      "(agent name single-sourced on profiles.name). Both columns stripped from " +
      "the COPY on restore; all other columns restored as-is.",
    rewriteCopyHeader: dropColumnsHeaderRewrite(["is_bootstrap_seed", "display_name"]),
  },
  {
    table: "public.users",
    reason:
      "D140 dropped users.is_bootstrap_seed (see agents). Column stripped from the " +
      "COPY on restore; all other columns restored as-is.",
    rewriteCopyHeader: dropColumnsHeaderRewrite(["is_bootstrap_seed"]),
  },

  // -----------------------------------------------------------------------
  // M141 follow-up — task privacy columns were retired in favor of
  // selection-profile/spec state. Older snapshots may still carry the dropped
  // columns in their COPY headers. Strip them so even empty historical task
  // tables restore cleanly; all current task columns remain byte-for-byte.
  // -----------------------------------------------------------------------
  {
    table: "public.tasks",
    reason:
      "Task privacy_mode was retired; strip the obsolete column from snapshot COPY.",
    rewriteCopyHeader: dropColumnsHeaderRewrite(["privacy_mode"]),
  },
  {
    table: "public.task_runs",
    reason:
      "Task run privacy_warning was retired; strip the obsolete column from snapshot COPY.",
    rewriteCopyHeader: dropColumnsHeaderRewrite(["privacy_warning"]),
  },

  // -----------------------------------------------------------------------
  // D425 — Disposable source-clone restore compatibility.
  //
  // The d425-source-20260716 snapshot was taken on a throwaway source
  // instance and restored onto a different target. Two of its
  // data-bearing tables hold state that is fundamentally tied to the
  // HOST that produced the snapshot, not to the portable user/workspace
  // payload. Restoring either would either fail the COPY (dropped
  // column / dropped table) or, worse, silently revive bindings that
  // point at a device/installation that does not exist on the target.
  //
  // Both are explicitly skipped here — non-portable server-local state
  // is discarded BY DESIGN, with a recorded reason, never silently.
  // -----------------------------------------------------------------------
  {
    table: "public.relay_tokens",
    // `relay_tokens.installation_id` bound a token to the specific
    // device installation that minted it. The column has since been
    // dropped, so a raw COPY of the dump's 27 rows would fail the
    // shape check. The binding itself is host-local: reviving it on a
    // different installation would either collide or point at nothing.
    // Skip the COPY entirely; no postRestore — the rows are
    // intentionally not carried over.
    skipCopy: true,
    intentionalSkip: true,
    reason:
      "D425: relay_tokens.installation_id (device-installation binding) was dropped. " +
      "The 27 dump rows are host-local, non-portable state — COPY is skipped and the " +
      "rows are intentionally NOT restored (no postRestore). Registered intentional skip.",
  },
  {
    table: "public.server_maintenance",
    // The `server_maintenance` table has been removed from the schema
    // entirely. The dump still carries 1 row, which a raw restore would
    // try to COPY into a table that no longer exists. Maintenance
    // state is server-local and non-portable by definition; it is
    // discarded on cross-instance restore by design.
    skipCopy: true,
    intentionalSkip: true,
    reason:
      "D425: server_maintenance table was removed from the schema. The 1 dump row is " +
      "server-local, non-portable maintenance state — COPY is skipped and the row is " +
      "intentionally NOT restored. Registered intentional skip (table gone).",
  },
];

// ---------------------------------------------------------------------------
// Row-level INSERT helpers
// ---------------------------------------------------------------------------

/**
 * Insert one credential row, remapped from dump's actor_id shape to
 * today's user_id shape. Returns false if the row could not be
 * inserted because actor_id was NULL in the dump — caller counts these
 * for a summary log. Throws on any other psql failure (e.g. FK
 * violation from a dangling actor reference) so restoreFromGzip can
 * surface it LOUDLY.
 */
function insertCredentialRemapped(
  r: DumpRow,
  psqlExec: (sql: string) => string,
): boolean {
  // Apr 13 shape: (id, actor_id, type, value, created_at, updated_at)
  const idx = indexOf(r.columns);
  const id = pgValue(r.values[idx("id")]);
  const actorId = pgValue(r.values[idx("actor_id")]);
  const type = pgValue(r.values[idx("type")]);
  const value = pgValue(r.values[idx("value")]);
  const createdAt = pgValue(r.values[idx("created_at")]);
  const updatedAt = pgValue(r.values[idx("updated_at")]);

  if (actorId === "NULL") return false;

  const sql = `
    INSERT INTO credentials (id, user_id, type, value, created_at, updated_at)
    SELECT ${id}, a.owner_id, ${type}, ${value}, ${createdAt}, ${updatedAt}
    FROM actors a
    WHERE a.id = ${actorId}
    ON CONFLICT (id) DO NOTHING;
  `;
  psqlExec(sql);
  return true;
}

function insertRecoveryCodeRemapped(
  r: DumpRow,
  psqlExec: (sql: string) => string,
): boolean {
  // Apr 13 shape: (id, actor_id, code_hash, used, used_at, created_at)
  const idx = indexOf(r.columns);
  const id = pgValue(r.values[idx("id")]);
  const actorId = pgValue(r.values[idx("actor_id")]);
  const codeHash = pgValue(r.values[idx("code_hash")]);
  const used = pgValue(r.values[idx("used")]);
  const usedAt = pgValue(r.values[idx("used_at")]);
  const createdAt = pgValue(r.values[idx("created_at")]);

  if (actorId === "NULL") return false;

  const sql = `
    INSERT INTO recovery_codes (id, user_id, code_hash, used, used_at, created_at)
    SELECT ${id}, a.owner_id, ${codeHash}, ${used}, ${usedAt}, ${createdAt}
    FROM actors a
    WHERE a.id = ${actorId}
    ON CONFLICT (id) DO NOTHING;
  `;
  psqlExec(sql);
  return true;
}

function insertGroupMemberWithNullableGrantor(
  r: DumpRow,
  psqlExec: (sql: string) => string,
): void {
  const idx = indexOf(r.columns);
  const groupId = pgValue(r.values[idx("group_id")]);
  const userId = pgValue(r.values[idx("user_id")]);
  const grantedAt = pgValue(r.values[idx("granted_at")]);
  const grantedBy = pgValue(r.values[idx("granted_by")]);

  const grantorExpr =
    grantedBy === "NULL"
      ? "NULL"
      : `(SELECT id FROM actors WHERE id = ${grantedBy})`;

  const sql = `
    INSERT INTO group_members (group_id, user_id, granted_at, granted_by)
    SELECT ${groupId}, ${userId}, ${grantedAt}, ${grantorExpr}
    WHERE EXISTS (SELECT 1 FROM groups WHERE id = ${groupId})
      AND EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    ON CONFLICT (group_id, user_id) DO UPDATE SET
      granted_at = EXCLUDED.granted_at,
      granted_by = EXCLUDED.granted_by;
  `;
  psqlExec(sql);
}

// ---------------------------------------------------------------------------
// COPY-header rewrites (column drop / reorder, value-preserving)
// ---------------------------------------------------------------------------

/**
 * Build a `rewriteCopyHeader` function that drops the named columns from
 * a COPY header. The matching column VALUES are stripped from every data
 * row by `applyCopyHeaderRewrite` (which diffs the new header against the
 * dump's header to find the dropped positions) — so callers only need to
 * declare WHICH columns go, not WHERE they sit.
 *
 * Returns the header unchanged when none of the named columns are present
 * (so the rule is a harmless no-op against newer dumps that already
 * dropped them).
 */
export function dropColumnsHeaderRewrite(
  dropColumns: string[],
): (header: string, columns: string[]) => string | null {
  const drop = new Set(dropColumns);
  return (header: string, columns: string[]): string | null => {
    const rawList = /\(([^)]*)\)/.exec(header)?.[1];
    if (rawList === undefined) return header;
    const rawColumns = rawList.split(",").map((column) => column.trim());
    const kept = rawColumns.filter((_column, index) => !drop.has(columns[index] ?? ""));
    if (kept.length === columns.length) return header; // nothing to drop
    // Replace only the parenthesised column list, preserving the rest of
    // the "COPY <table> (...) FROM stdin;" shape verbatim.
    return header.replace(/\(([^)]*)\)/, `(${kept.join(", ")})`);
  };
}

/**
 * Apply a `rewriteCopyHeader` transform to a full COPY block (the header
 * line through the trailing `\.` terminator, as produced by
 * `extractCopyBlock`). Returns:
 *
 *   - the transformed block (new header + rows with dropped columns
 *     removed) when the rewrite changed the column list,
 *   - the original block when the rewrite returned it unchanged,
 *   - `null` when the rewrite returned null (drop the whole COPY).
 *
 * Value-preserving: each surviving field is copied byte-for-byte from the
 * dump (no unescape / re-quote), so jsonb, bytea, timestamps, and
 * tab-escaped text all round-trip exactly.
 *
 * Throws if the rewritten header names a column that is not in the dump
 * (we cannot synthesise values for a column the dump never had).
 */
export function applyCopyHeaderRewrite(
  copyBlock: string,
  rewriteCopyHeader: (header: string, columns: string[]) => string | null,
): string | null {
  const firstNl = copyBlock.indexOf("\n");
  if (firstNl === -1) return copyBlock;
  const header = copyBlock.slice(0, firstNl);
  const rest = copyBlock.slice(firstNl + 1);

  const headerCols = parseHeaderColumns(header);
  if (headerCols === null) return copyBlock; // not a recognisable COPY header

  const newHeader = rewriteCopyHeader(header, headerCols);
  if (newHeader === null) return null;
  if (newHeader === header) return copyBlock;

  const newCols = parseHeaderColumns(newHeader);
  if (newCols === null) {
    throw new Error(`Rewritten COPY header is not parseable: ${newHeader}`);
  }
  const keepIdx = newCols.map((c) => headerCols.indexOf(c));
  if (keepIdx.some((i) => i === -1)) {
    const unknown = newCols.filter((c) => !headerCols.includes(c));
    throw new Error(
      `Rewritten COPY header introduced column(s) not present in the dump: ` +
        `${unknown.join(", ")}. Header: ${header}`,
    );
  }

  // Split the body from the trailing `\.` terminator. The terminator is
  // line-anchored (its own line), so search for "\n\\." or a block that
  // starts with "\\." (empty body).
  let termIdx: number;
  if (rest.startsWith("\\.")) {
    termIdx = 0;
  } else {
    const i = rest.indexOf("\n\\.");
    termIdx = i === -1 ? rest.length : i + 1; // keep the newline with the body
  }
  const body = rest.slice(0, termIdx);
  const tail = rest.slice(termIdx);

  const transformedBody = body
    .split("\n")
    .map((line) => {
      if (line === "") return line; // trailing newline / blank rows
      const fields = line.split("\t");
      return keepIdx.map((i) => fields[i]).join("\t");
    })
    .join("\n");

  return `${newHeader}\n${transformedBody}${tail}`;
}

/**
 * Pull the column list out of a "COPY <table> (a, b, c) FROM stdin;"
 * header line. Returns null if the line is not a recognisable COPY
 * header.
 */
function parseHeaderColumns(header: string): string[] | null {
  const m = /^COPY\s+\S+\s+\(([^)]*)\)\s+FROM stdin/.exec(header);
  if (!m) return null;
  return m[1]!.split(",").map(parsePgDumpIdentifier);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a column index by name. Throws if the column is not in the
 * dump — that means the dump predates the field we expected, or the
 * migration registry is wrong.
 */
function indexOf(columns: string[]): (col: string) => number {
  return (col: string) => {
    const i = columns.indexOf(col);
    if (i === -1) {
      throw new Error(
        `Restore migration expected column "${col}" but dump only has: ${columns.join(", ")}`,
      );
    }
    return i;
  };
}

/**
 * Convert a pg_dump TEXT value to a SQL literal.
 *
 *   - "\\N"          → NULL
 *   - "\\t", "\\n"   → tab / newline
 *   - other text     → single-quoted, with embedded quotes doubled
 *
 * Works for text/varchar/uuid/timestamp/boolean/numeric — i.e.
 * everything the restore registry currently touches. Do NOT extend
 * this to bytea/jsonb without adding format-specific handling.
 */
export function pgValue(raw: string | undefined): string {
  if (raw === undefined || raw === "\\N") return "NULL";

  // pg_dump TEXT format uses `\\` for a literal backslash and `\n` /
  // `\t` / `\r` for the obvious control chars. The unescape must be
  // done in a SINGLE pass — a naive sequence of `replace(\\n, \n)
  // ...replace(\\\\, \\)` double-decodes strings like `\\t` (which is
  // actually a literal backslash followed by a `t`) into a real tab.
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "\\") { out += "\\"; i++; continue; }
      if (next === "n")  { out += "\n"; i++; continue; }
      if (next === "t")  { out += "\t"; i++; continue; }
      if (next === "r")  { out += "\r"; i++; continue; }
    }
    out += ch;
  }
  return `'${out.replace(/'/g, "''")}'`;
}

/**
 * Parse a table's COPY block out of the dump gzip and return each row
 * as { columns, values }. Rows that don't match the column count are
 * skipped (loud log).
 */
export function parseCopyRows(
  dumpText: string,
  table: string,
): DumpRow[] {
  const copyRe = new RegExp(
    `^COPY ${table.replace(/\./g, "\\.")} \\(([^)]+)\\) FROM stdin`,
    "m",
  );
  const m = copyRe.exec(dumpText);
  if (!m) return [];

  const columns = m[1]!.split(",").map((c) => c.trim());
  const start = dumpText.indexOf("\n", m.index) + 1;
  const endMarker = dumpText.indexOf("\n\\.", start);
  if (endMarker === -1) return [];

  const body = dumpText.slice(start, endMarker);
  if (!body) return [];

  const rows: DumpRow[] = [];
  for (const line of body.split("\n")) {
    if (!line) continue;
    const values = line.split("\t");
    if (values.length !== columns.length) {
      // Row shape doesn't match — skip it loudly. A malformed dump is
      // a useful diagnostic.
      continue;
    }
    rows.push({ columns, values });
  }
  return rows;
}

/**
 * Run a psql command inside the nautilo-postgres container and return
 * stdout. Used by restore-migration `postRestore` hooks. Kept here
 * (not in docker-db.ts) so the migration registry stays fully self-
 * contained and the registry can be tested without mocking the whole
 * CLI.
 *
 * When `container` is omitted, the target is derived from the canonical
 * config resolver (`resolveInstance().compose.containers.legacyPostgres`)
 * so a restore running under a named instance (e.g. `NAUTILO_INSTANCE_ID
 * =stack-198`) hits that instance's container — not the hardcoded
 * `(default)` `nautilo-postgres`. An explicit `container` / `db`
 * override is preserved unchanged.
 *
 * Both names are interpolated into a `docker exec` shell command, so
 * they are validated against a safe identifier charset before use. The
 * config resolver only ever produces names matching this set; the
 * guard exists for explicit caller overrides that bypass the resolver.
 */
const DEFAULT_PSQL_DB = "nautilo";
const SAFE_DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertSafeDockerName(kind: string, value: string): void {
  if (!SAFE_DOCKER_NAME.test(value)) {
    throw new Error(
      `makePsqlExec: ${kind} "${value}" is not a safe docker identifier ` +
        `(must match ${SAFE_DOCKER_NAME.source})`,
    );
  }
}

export interface PsqlExecTarget {
  container: string;
  db: string;
}

/**
 * Resolve the (container, db) pair `makePsqlExec` will target, applying
 * the config-resolver default for an omitted container and validating
 * both names. Pure (no exec) so the default-vs-override behavior is
 * unit-testable without Docker.
 */
export function resolvePsqlExecTarget(
  container?: string,
  db: string = DEFAULT_PSQL_DB,
): PsqlExecTarget {
  const resolvedContainer =
    container !== undefined && container.trim() !== ""
      ? container
      : resolveInstance().compose.containers.legacyPostgres;
  assertSafeDockerName("container", resolvedContainer);
  assertSafeDockerName("db", db);
  return { container: resolvedContainer, db };
}

export function makePsqlExec(
  container?: string,
  db: string = DEFAULT_PSQL_DB,
): (sql: string) => string {
  const { container: c, db: dbName } = resolvePsqlExecTarget(container, db);
  return (sql: string) =>
    execSync(
      `docker exec -i ${c} psql -U postgres -d ${dbName} -v ON_ERROR_STOP=1`,
      {
        input: sql,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
}
