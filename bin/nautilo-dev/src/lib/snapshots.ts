import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { resolveSnapshotsDir } from "./paths";
import {
  FULL_DEV_BACKUP_MANIFEST,
  parseFullBackupManifest,
} from "./full-dev-backup";

export interface SnapshotMeta {
  name: string;
  createdAt?: string;
  backupMode?: "dump" | "basebackup";
  dbSizeBytes?: number;
  logtoDbSizeBytes?: number | null;
  envKeyCount?: number;
  complete?: boolean;
  cloneEligible?: boolean;
  sourceInstanceId?: string;
  lastAppliedMigrationIndex?: number;
}

export interface SnapshotSummary extends SnapshotMeta {
  /** Absolute path to the snapshot directory. */
  dir: string;
  /** Number of data tables with at least one COPY row in the dump. */
  tableCount?: number;
  /** On-disk size of the gzipped dump. */
  dbSizeBytes: number;
  /** On-disk size of the Logto gzipped dump, or null if absent. */
  logtoDbSizeBytes: number | null;
}

export interface TableRowCount {
  table: string;
  columns: string[];
  rowCount: number;
}

/** Normalize one identifier from a pg_dump COPY column list. */
export function parsePgDumpIdentifier(raw: string): string {
  const identifier = raw.trim();
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replaceAll('""', '"');
  }
  return identifier;
}

/**
 * Shared snapshot discovery + parsing. Used by the CLI `list`/`inspect`
 * commands AND the nautilo-backup MCP. Keep it side-effect free.
 */
export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const dir = resolveSnapshotsDir();
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir);
  const out: SnapshotSummary[] = [];

  for (const entry of entries) {
    // Hidden / special safety-backup files are not snapshots.
    if (entry.startsWith("_") || entry.startsWith(".")) continue;

    const snapDir = join(dir, entry);
    const s = await stat(snapDir);
    if (!s.isDirectory()) continue;

    const summary = await summarizeSnapshot(entry);
    if (summary) out.push(summary);
  }

  out.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return a.name.localeCompare(b.name);
  });

  return out;
}

export async function summarizeSnapshot(name: string): Promise<SnapshotSummary | null> {
  const dir = join(resolveSnapshotsDir(), name);
  if (!existsSync(dir)) return null;

  const metaPath = join(dir, "meta.json");
  let meta: SnapshotMeta = { name };
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8")) as SnapshotMeta;
    } catch {
      // Corrupted meta — keep the bare name and move on.
    }
  }
  const manifestPath = join(dir, FULL_DEV_BACKUP_MANIFEST);
  if (existsSync(manifestPath)) {
    try {
      const manifest = parseFullBackupManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      );
      meta = {
        ...meta,
        name: manifest.name,
        createdAt: manifest.createdAt,
        backupMode: manifest.backupMode,
        dbSizeBytes: manifest.artifacts.nautiloDatabase.bytes,
        logtoDbSizeBytes: manifest.artifacts.logtoDatabase.bytes,
        complete: manifest.complete,
        cloneEligible: manifest.cloneEligible,
        sourceInstanceId: manifest.sourceInstanceId,
        lastAppliedMigrationIndex: manifest.drizzle.lastAppliedIndex,
      };
    } catch {
      // Invalid manifest stays visibly non-full/non-cloneable.
    }
  }

  const dbPath = join(dir, "database.sql.gz");
  const basebackupPath = join(dir, "basebackup.tar.gz");
  let dbSize = meta.dbSizeBytes ?? 0;
  if (existsSync(dbPath)) {
    dbSize = (await stat(dbPath)).size;
  } else if (existsSync(basebackupPath)) {
    dbSize = (await stat(basebackupPath)).size;
  }
  const logtoDbPath = join(dir, "logto_nautilo.sql.gz");
  const logtoDbSize = existsSync(logtoDbPath)
    ? (await stat(logtoDbPath)).size
    : (meta.logtoDbSizeBytes ?? null);

  return {
    ...meta,
    name,
    dir,
    backupMode: meta.backupMode ?? (existsSync(basebackupPath) ? "basebackup" : "dump"),
    dbSizeBytes: dbSize,
    logtoDbSizeBytes: logtoDbSize,
  };
}

/**
 * Parse the gzipped dump's COPY blocks and return row counts per table.
 * Streams the file — the dump can be hundreds of MB when the DB is busy.
 * Never loads the whole file into memory.
 */
export async function inspectSnapshotTables(name: string): Promise<TableRowCount[]> {
  const dir = join(resolveSnapshotsDir(), name);
  const dbPath = join(dir, "database.sql.gz");
  if (!existsSync(dbPath)) {
    throw new Error(`Snapshot "${name}" has no database.sql.gz`);
  }

  interface InFlight {
    table: string;
    columns: string[];
    count: number;
  }
  const tables: TableRowCount[] = [];
  let current: InFlight | null = null;
  let buffer = "";

  const copyRe = /^COPY (public\.[a-zA-Z0-9_]+) \(([^)]+)\) FROM stdin/;

  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        if (current) {
          if (line === "\\.") {
            tables.push({
              table: current.table.replace(/^public\./, ""),
              columns: current.columns,
              rowCount: current.count,
            });
            current = null;
          } else if (line.length > 0) {
            current.count++;
          }
        } else {
          const m = copyRe.exec(line);
          if (m) {
            current = {
              table: m[1]!,
              columns: (m[2] ?? "").split(",").map(parsePgDumpIdentifier),
              count: 0,
            };
          }
        }

        idx = buffer.indexOf("\n");
      }
      cb();
    },
  });

  await pipeline(createReadStream(dbPath), createGunzip(), sink);

  // TS's control-flow narrowing wrongly concludes that `current` is
  // `never` after the await — it does not see that the closure may
  // leave it non-null. Force-cast through unknown so we can safely
  // finalize an in-flight COPY block when the dump is truncated.
  const trailing = current as unknown as InFlight | null;
  if (trailing !== null) {
    tables.push({
      table: trailing.table.replace(/^public\./, ""),
      columns: trailing.columns,
      rowCount: trailing.count,
    });
  }

  return tables.sort((a, b) => a.table.localeCompare(b.table));
}
