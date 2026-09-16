/**
 * M088B — `migrate-artifacts` operator command.
 *
 * Pass A relocates legacy `~/Documents/Nautilo/.artifacts/<uuid>` bytes
 * into `getArtifactsRoot()/<artifact row id>` and rewrites `storage_uri`.
 * Pass B ingests flat-tree files under `~/Documents/Nautilo/` into new
 * artifact rows + `artifact_namespaces` junction rows.
 *
 * The pure runner (`runMigrateArtifacts`) takes injected deps so unit
 * tests exercise every branch without Postgres or the real filesystem.
 * `migrateArtifacts` wires real deps + loads `~/.nautilo/instance.env`.
 */
import path, { dirname, join } from "node:path";
import {
  mkdir,
  rename,
  copyFile,
  rm,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID as randomUuid } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";
import { resolveSnapshotsDir } from "../lib/paths";
import { getArtifactsRoot } from "@nautilo/config";
import {
  and,
  attachArtifactToNamespace,
  createDirectDb,
  eq,
  isNull,
  sql,
  artifacts,
  artifactNamespaces,
  agents,
  namespaces,
} from "@nautilo/db";
import type { DirectDatabase } from "@nautilo/db";

// ---------------------------------------------------------------------------
// Types — public surface for tests + CLI wrapper
// ---------------------------------------------------------------------------

export interface MigrateArtifactsArgs {
  dryRun?: boolean | undefined;
  /** D202: explicit opt-in to migrate artifacts on the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
  /** When set, caps Pass A rows returned from the scan and Pass B files considered (in stable sort order). */
  limit?: number | undefined;
  configEnvPath?: string | undefined;
  /**
   * M088B — explicit Pass B target. Pass B is skipped (with a clear log
   * line) unless BOTH a namespace id and an agent id resolve. The agent
   * id falls back to `process.env.NAUTILO_DEFAULT_AGENT_ID`; the
   * namespace id has no default (no safe heuristic — `manage_memory`
   * forces operators to nominate a namespace too).
   */
  agentId?: string | undefined;
  namespaceId?: string | undefined;
}

export interface MigrateArtifactsReceiptPass {
  scanned: number;
  relocated?: number | undefined;
  ingested?: number | undefined;
  skipped?: number | undefined;
  errors: string[];
  artifactIds: string[];
}

export interface MigrateArtifactsReceipt {
  timestamp: string;
  dryRun: boolean;
  passA: MigrateArtifactsReceiptPass & { relocated: number };
  passB: MigrateArtifactsReceiptPass & { ingested: number; skipped: number };
}

export interface MigrateArtifactsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MigrateArtifactsPaths {
  userHome: string;
  documentsNautiloRoot: string;
  artifactsRoot: string;
  receiptsDir: string;
}

/**
 * Injected dependency bundle for `runMigrateArtifacts`.
 * Production wiring fills these with Drizzle + `node:fs/promises`;
 * unit tests substitute in-memory fakes.
 */
export interface MigrateArtifactsDeps {
  log: MigrateArtifactsLogger;
  paths: MigrateArtifactsPaths;
  /** ISO-8601 timestamp for the receipt filename + JSON body. */
  timestampIso: string;
  randomUUID: () => string;
  passAListRows(params: {
    legacyStorageUriPrefix: string;
    limit?: number | undefined;
  }): Promise<Array<{ id: string; storageUri: string }>>;
  /**
   * `mkdir -p` artifact root, rename-or-copy the bytes, then UPDATE
   * `artifacts.storage_uri` inside a DB transaction (file I/O itself is
   * not transactional with Postgres).
   */
  passARelocateRow(params: {
    artifactRowId: string;
    oldFsPath: string;
    newFsPath: string;
    newStorageUri: string;
  }): Promise<void>;
  passAHasJunction(artifactRowId: string): Promise<boolean>;
  resolveOperatorTarget(): Promise<{
    namespaceId: string;
    agentId: string;
  } | null>;
  listPassBFileEntries(): Promise<
    Array<{ absolutePath: string; relativePosix: string; size: number }>
  >;
  passBShouldSkip(params: {
    absolutePath: string;
    relativePosix: string;
    namespaceId: string;
    agentId: string;
  }): Promise<boolean>;
  passBIngest(params: {
    newArtifactRowId: string;
    externalArtifactId: string;
    agentId: string;
    namespaceId: string;
    relativePosix: string;
    sourceAbsolutePath: string;
    newFsPath: string;
    newStorageUri: string;
    size: number;
  }): Promise<void>;
  writeReceipt(path: string, contents: string): Promise<void>;
}

function normalizeFsPath(p: string): string {
  return path.normalize(p);
}

function legacyArtifactsUriPrefix(documentsNautiloRoot: string): string {
  const legacyDir = join(documentsNautiloRoot, ".artifacts") + path.sep;
  return pathToFileURL(legacyDir).href;
}

function posixRelative(fromDirAbs: string, fileAbs: string): string {
  const rel = path.relative(fromDirAbs, fileAbs);
  return rel.split(path.sep).join("/");
}

async function renameOrCopyDelete(
  from: string,
  to: string,
): Promise<void> {
  try {
    await rename(from, to);
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EXDEV") {
      await copyFile(from, to);
      await rm(from, { force: true });
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pure runner
// ---------------------------------------------------------------------------

export async function runMigrateArtifacts(
  args: MigrateArtifactsArgs,
  deps: MigrateArtifactsDeps,
): Promise<number> {
  const receipt: MigrateArtifactsReceipt = {
    timestamp: deps.timestampIso,
    dryRun: Boolean(args.dryRun),
    passA: {
      scanned: 0,
      relocated: 0,
      errors: [],
      artifactIds: [],
    },
    passB: {
      scanned: 0,
      ingested: 0,
      skipped: 0,
      errors: [],
      artifactIds: [],
    },
  };

  const { documentsNautiloRoot, artifactsRoot } = deps.paths;
  const legacyPrefix = legacyArtifactsUriPrefix(documentsNautiloRoot);

  const passARows = await deps.passAListRows({
    legacyStorageUriPrefix: legacyPrefix,
    limit: args.limit,
  });
  receipt.passA.scanned = passARows.length;

  for (const row of passARows) {
    let oldFsPath: string;
    try {
      oldFsPath = normalizeFsPath(fileURLToPath(row.storageUri));
    } catch (e) {
      const msg = `Pass A artifact ${row.id}: invalid storage_uri (${row.storageUri}): ${
        e instanceof Error ? e.message : String(e)
      }`;
      receipt.passA.errors.push(msg);
      deps.log.error(msg);
      continue;
    }
    const newFsPath = normalizeFsPath(join(artifactsRoot, row.id));
    const newStorageUri = pathToFileURL(newFsPath).href;

    if (oldFsPath === newFsPath) {
      deps.log.info(`Pass A artifact ${row.id}: already at artifact root — skipping FS.`);
      continue;
    }

    if (args.dryRun) {
      deps.log.info(
        `[dry-run] Pass A would relocate ${row.id}: ${oldFsPath} → ${newFsPath}`,
      );
      receipt.passA.relocated += 1;
      receipt.passA.artifactIds.push(row.id);
      continue;
    }

    try {
      await deps.passARelocateRow({
        artifactRowId: row.id,
        oldFsPath,
        newFsPath,
        newStorageUri,
      });
      const hasJunction = await deps.passAHasJunction(row.id);
      if (!hasJunction) {
        deps.log.warn(
          `Pass A artifact ${row.id}: no artifact_namespaces row — orphaned artifact row?`,
        );
      }
      receipt.passA.relocated += 1;
      receipt.passA.artifactIds.push(row.id);
    } catch (e) {
      const msg = `Pass A artifact ${row.id}: ${
        e instanceof Error ? e.message : String(e)
      }`;
      receipt.passA.errors.push(msg);
      deps.log.error(msg);
    }
  }

  const op = await deps.resolveOperatorTarget();
  let passBEntries = await deps.listPassBFileEntries();
  if (typeof args.limit === "number" && args.limit > 0) {
    passBEntries = passBEntries
      .slice()
      .sort((a, b) => a.relativePosix.localeCompare(b.relativePosix))
      .slice(0, args.limit);
  }
  receipt.passB.scanned = passBEntries.length;

  if (!op) {
    const msg =
      "Pass B skipped: --agent-id and --namespace-id (or NAUTILO_DEFAULT_AGENT_ID + --namespace-id) must point at existing rows. Pass A still ran.";
    receipt.passB.errors.push(msg);
    deps.log.error(msg);
  } else {
    for (const ent of passBEntries) {
      try {
        const skip = await deps.passBShouldSkip({
          absolutePath: ent.absolutePath,
          relativePosix: ent.relativePosix,
          namespaceId: op.namespaceId,
          agentId: op.agentId,
        });
        if (skip) {
          receipt.passB.skipped += 1;
          continue;
        }
        const newRowId = deps.randomUUID();
        const externalArtifactId = deps.randomUUID();
        const newFsPath = normalizeFsPath(join(artifactsRoot, newRowId));
        const newStorageUri = pathToFileURL(newFsPath).href;

        if (args.dryRun) {
          deps.log.info(
            `[dry-run] Pass B would ingest ${ent.relativePosix} → artifact row ${newRowId}`,
          );
          receipt.passB.ingested += 1;
          receipt.passB.artifactIds.push(newRowId);
          continue;
        }

        await deps.passBIngest({
          newArtifactRowId: newRowId,
          externalArtifactId,
          agentId: op.agentId,
          namespaceId: op.namespaceId,
          relativePosix: ent.relativePosix,
          sourceAbsolutePath: ent.absolutePath,
          newFsPath,
          newStorageUri,
          size: ent.size,
        });
        receipt.passB.ingested += 1;
        receipt.passB.artifactIds.push(newRowId);
      } catch (e) {
        const msg = `Pass B file ${ent.relativePosix}: ${
          e instanceof Error ? e.message : String(e)
        }`;
        receipt.passB.errors.push(msg);
        deps.log.error(msg);
      }
    }
  }

  deps.log.info(
    `Pass A: scanned=${receipt.passA.scanned} relocated=${receipt.passA.relocated} errors=${receipt.passA.errors.length}`,
  );
  deps.log.info(
    `Pass B: scanned=${receipt.passB.scanned} ingested=${receipt.passB.ingested} skipped=${receipt.passB.skipped} errors=${receipt.passB.errors.length}`,
  );

  if (!args.dryRun) {
    const safeTs = deps.timestampIso.replace(/[:.]/g, "-");
    const receiptPath = join(deps.paths.receiptsDir, `migrate-artifacts-${safeTs}.json`);
    await deps.writeReceipt(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    deps.log.info(`Receipt written to ${receiptPath}`);
  }

  const fatal =
    receipt.passA.errors.length > 0 || receipt.passB.errors.length > 0;
  return fatal ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Real dependency wiring
// ---------------------------------------------------------------------------

function consoleMigrateLogger(): MigrateArtifactsLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

async function walkDocumentsNautiloFiles(
  documentsNautiloRoot: string,
): Promise<Array<{ absolutePath: string; relativePosix: string; size: number }>> {
  const legacyDir = join(documentsNautiloRoot, ".artifacts");
  const out: Array<{ absolutePath: string; relativePosix: string; size: number }> = [];

  async function walk(dirAbs: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        const normLegacy = path.normalize(legacyDir);
        const normAbs = path.normalize(abs);
        if (normAbs === normLegacy || normAbs.startsWith(normLegacy + path.sep)) {
          continue;
        }
        await walk(abs);
      } else if (ent.isFile()) {
        const st = await stat(abs);
        out.push({
          absolutePath: normalizeFsPath(abs),
          relativePosix: posixRelative(documentsNautiloRoot, abs),
          size: st.size,
        });
      }
    }
  }

  await walk(documentsNautiloRoot);
  return out.sort((a, b) => a.relativePosix.localeCompare(b.relativePosix));
}

/**
 * Verify the operator-supplied (agentId, namespaceId) pair points at
 * real rows. We deliberately do NOT cross-check that the namespace is
 * "owned by" or "attached to" the agent — `share_artifact` lets a
 * single artifact attach to many namespaces across rooms, so any
 * agent-side validity check would either be wrong or duplicate the
 * runtime ACL. The CLI just confirms both UUIDs exist; the operator
 * is responsible for picking the right room.
 */
async function verifyOperatorTarget(
  db: DirectDatabase,
  agentId: string,
  namespaceId: string,
): Promise<{ namespaceId: string; agentId: string } | null> {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(agentId) || !UUID_RE.test(namespaceId)) return null;

  const [agentRow] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agentRow) return null;

  const [nsRow] = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(eq(namespaces.id, namespaceId))
    .limit(1);
  if (!nsRow) return null;

  return { namespaceId, agentId };
}

async function passBShouldSkipReal(
  db: DirectDatabase,
  params: {
    absolutePath: string;
    relativePosix: string;
    namespaceId: string;
    agentId: string;
  },
): Promise<boolean> {
  const absNorm = normalizeFsPath(params.absolutePath);
  const [byPath] = await db
    .selectDistinct({ storageUri: artifacts.storageUri })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        eq(artifacts.path, params.relativePosix),
        eq(artifactNamespaces.namespaceId, params.namespaceId),
        isNull(artifacts.deletedAt),
        isNull(artifacts.cryptoObjectId),
      ),
    )
    .limit(1);
  if (byPath?.storageUri) {
    try {
      if (normalizeFsPath(fileURLToPath(byPath.storageUri)) === absNorm) {
        return true;
      }
    } catch {
      /* fall through */
    }
    return true;
  }

  const rows = await db
    .select({ storageUri: artifacts.storageUri })
    .from(artifacts)
    .innerJoin(
      artifactNamespaces,
      eq(artifactNamespaces.artifactId, artifacts.id),
    )
    .where(
      and(
        eq(artifactNamespaces.namespaceId, params.namespaceId),
        isNull(artifacts.deletedAt),
        isNull(artifacts.cryptoObjectId),
      ),
    );

  for (const r of rows) {
    if (r.storageUri === null) continue;
    try {
      if (normalizeFsPath(fileURLToPath(r.storageUri)) === absNorm) {
        return true;
      }
    } catch {
      /* ignore bad uri */
    }
  }
  return false;
}

export async function migrateArtifacts(
  args: MigrateArtifactsArgs,
): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:migrate-artifacts",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.dryRun === true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  const db = createDirectDb(1);
  const log = consoleMigrateLogger();
  const userHome = process.env["HOME"]?.trim() || "";
  if (!userHome) {
    log.error("HOME is not set — cannot resolve ~/Documents/Nautilo.");
    await db.end();
    return 1;
  }
  const documentsNautiloRoot = join(userHome, "Documents", "Nautilo");
  const artifactsRoot = getArtifactsRoot();
  const receiptsDir = resolveSnapshotsDir();

  const timestampIso = new Date().toISOString();

  const deps: MigrateArtifactsDeps = {
    log,
    paths: {
      userHome,
      documentsNautiloRoot,
      artifactsRoot,
      receiptsDir,
    },
    timestampIso,
    randomUUID: () => randomUuid(),
    passAListRows: async ({ legacyStorageUriPrefix, limit }) => {
      const base = db
        .select({ id: artifacts.id, storageUri: artifacts.storageUri })
        .from(artifacts)
        .where(
          and(
            isNull(artifacts.deletedAt),
            isNull(artifacts.cryptoObjectId),
            sql`${artifacts.storageUri} LIKE ${legacyStorageUriPrefix + "%"}`,
          ),
        );
      const rows =
        typeof limit === "number" && limit > 0
          ? await base.limit(limit)
          : await base;
      return rows.flatMap((row) => row.storageUri === null ? [] : [{
        id: row.id,
        storageUri: row.storageUri,
      }]);
    },
    passARelocateRow: async (p) => {
      await mkdir(artifactsRoot, { recursive: true });
      await renameOrCopyDelete(p.oldFsPath, p.newFsPath);
      await db.transaction(async (tx) => {
        await tx
          .update(artifacts)
          .set({ storageUri: p.newStorageUri, updatedAt: new Date() })
          .where(eq(artifacts.id, p.artifactRowId));
      });
    },
    passAHasJunction: async (artifactRowId) => {
      const j = await db
        .select({ namespaceId: artifactNamespaces.namespaceId })
        .from(artifactNamespaces)
        .where(eq(artifactNamespaces.artifactId, artifactRowId))
        .limit(1);
      return j.length > 0;
    },
    resolveOperatorTarget: async () => {
      const agentId =
        args.agentId?.trim() ||
        process.env["NAUTILO_DEFAULT_AGENT_ID"]?.trim() ||
        "";
      const namespaceId = args.namespaceId?.trim() || "";
      if (!agentId || !namespaceId) return null;
      return verifyOperatorTarget(db, agentId, namespaceId);
    },
    listPassBFileEntries: () => walkDocumentsNautiloFiles(documentsNautiloRoot),
    passBShouldSkip: (p) => passBShouldSkipReal(db, p),
    passBIngest: async (p) => {
      await mkdir(artifactsRoot, { recursive: true });
      await copyFile(p.sourceAbsolutePath, p.newFsPath);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(artifacts).values({
            id: p.newArtifactRowId,
            artifactId: p.externalArtifactId,
            path: p.relativePosix,
            storageUri: p.newStorageUri,
            size: p.size,
            mimeType: "application/octet-stream",
          });
          await attachArtifactToNamespace(
            { artifactId: p.newArtifactRowId, namespaceId: p.namespaceId },
            // `createDirectDb` uses postgres-js; query helpers default to Neon `Database` typing.
            tx as never,
          );
        });
      } catch (e) {
        await rm(p.newFsPath, { force: true });
        throw e;
      }
    },
    writeReceipt: async (filePath, contents) => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf-8");
    },
  };

  try {
    return await runMigrateArtifacts(args, deps);
  } finally {
    await db.end();
  }
}
