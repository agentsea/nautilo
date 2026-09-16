/**
 * Image-resident portable-recovery execution.
 *
 * This is intentionally the only layer that can turn local server state into
 * recovery members.  It accepts opaque operation/object IDs, never a secret
 * in argv, and leaves object-store/Railway orchestration to its caller.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  LOGTO_TENANT_PASSWORD_RESYNC_SQL,
  buildAgentRoleGrantsSql,
  buildAppRoleOwnershipRepairSql,
  buildFullCryptoTablePrivilegeReconcileSql,
} from "@nautilo/db";
import {
  PORTABLE_RECOVERY_MEMBERS,
  readPortableRecovery,
  writePortableRecovery,
  type PortableRecoveryMemberName,
  type PortableRecoveryReceipt,
} from "./portable-recovery-container";
import {
  createS3CompatiblePortableRecoveryObjectStore,
  type PortableRecoveryCompletionDescriptor,
  type PortableRecoveryObjectIdentity,
} from "./portable-recovery-object-store";

export { PORTABLE_RECOVERY_MEMBERS } from "./portable-recovery-container";

const ROOTS = ["artifacts", "media", "apps"] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SOURCE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
const LOGTO_TENANT_REGRANT_SQL =
  "DO $$ DECLARE r record; BEGIN " +
  "FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'logto_tenant_%' LOOP " +
  "EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r.rolname); " +
  "EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r.rolname); " +
  "EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r.rolname); " +
  "EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', r.rolname); " +
  "END LOOP; END $$;";
const REQUIRED_ENV = [
  "NAUTILO_RECOVERY_S3_ENDPOINT",
  "NAUTILO_RECOVERY_S3_REGION",
  "NAUTILO_RECOVERY_S3_BUCKET",
  "NAUTILO_RECOVERY_S3_ACCESS_KEY_ID",
  "NAUTILO_RECOVERY_S3_SECRET_ACCESS_KEY",
  "NAUTILO_RECOVERY_KEY",
  "NAUTILO_RECOVERY_SOURCE_RELEASE_ID",
  "NAUTILO_RECOVERY_APP_DATABASE_URL",
  "NAUTILO_RECOVERY_LOGTO_DATABASE_URL",
] as const;

export type PortableRecoveryDirection = "export" | "restore";
export type PortableRecoveryRootName = (typeof ROOTS)[number];

export class PortableRecoveryJobError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "INVALID_ENVIRONMENT"
      | "PRECONDITION_FAILED"
      | "SUBPROCESS_FAILED"
      | "UNSAFE_VOLUME"
      | "VERIFICATION_FAILED"
      | "PROMOTION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PortableRecoveryJobError";
  }
}

export interface PortableRecoveryJobEnvironment {
  readonly s3Endpoint: string;
  readonly s3Region: string;
  readonly s3Bucket: string;
  readonly s3Prefix?: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly s3SessionToken?: string;
  readonly key: Uint8Array;
  readonly sourceReleaseId: string;
  /** Restore-only external receipt binding. Never written to a child argv. */
  readonly expectedCiphertextSha256?: string;
  readonly appDatabaseUrl: string;
  readonly logtoDatabaseUrl: string;
}

export interface PortableRecoveryChild {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly completed: Promise<void>;
}

/** No URL or password is permitted in `args`; connection authority is env/pgpass only. */
export interface PortableRecoveryProcessRunner {
  start(input: { readonly command: "pg_dump" | "pg_dump16" | "pg_restore" | "pg_restore16" | "psql" | "psql16" | "tar"; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd?: string }): Promise<PortableRecoveryChild>;
}

export interface PortableRecoveryFilesystem {
  readonly root: string;
  exists(path: string): Promise<boolean>;
  lstat(path: string): Promise<{ readonly isDirectory: boolean; readonly isFile: boolean; readonly isSymbolicLink: boolean; readonly isSocket: boolean; readonly isBlockDevice: boolean; readonly isCharacterDevice: boolean; readonly isFIFO: boolean }>;
  readdir(path: string): Promise<readonly string[]>;
  mkdir(path: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  appendFile(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

export interface PortableRecoveryObjectStore {
  publish(input: { readonly identity: PortableRecoveryObjectIdentity; readonly bundle: AsyncIterable<Uint8Array>; readonly receipt: Promise<PortableRecoveryReceipt>; readonly sourceReleaseId: string; readonly completedAt: Date }): Promise<PortableRecoveryCompletionDescriptor>;
  download(identity: PortableRecoveryObjectIdentity): Promise<{ readonly descriptor: PortableRecoveryCompletionDescriptor; readonly body: AsyncIterable<Uint8Array> }>;
  /** Resume probing is descriptor-only; it must not open an unused bundle body. */
  observe?(identity: PortableRecoveryObjectIdentity): Promise<{ readonly state: "not-found" | "inconsistent" | "complete"; readonly descriptor?: PortableRecoveryCompletionDescriptor }>;
}

export interface PortableRecoveryFreshTargetPrecondition {
  assertFresh(input: { readonly database: "app" | "logto"; readonly root: string }): Promise<void>;
}

export interface RunPortableRecoveryJobInput {
  readonly direction: PortableRecoveryDirection;
  readonly operationId: string;
  readonly objectId: string;
  readonly environment: PortableRecoveryJobEnvironment;
  readonly runner: PortableRecoveryProcessRunner;
  readonly fs: PortableRecoveryFilesystem;
  readonly storage: PortableRecoveryObjectStore;
  readonly assertFreshTarget: PortableRecoveryFreshTargetPrecondition;
  readonly random?: (size: number) => Uint8Array;
  readonly now?: () => Date;
}

export type PortableRecoveryJobResult =
  | { readonly direction: "export"; readonly descriptor: PortableRecoveryCompletionDescriptor }
  | { readonly direction: "restore"; readonly descriptor: PortableRecoveryCompletionDescriptor; readonly retainedStagingPath?: string };

function fail(code: PortableRecoveryJobError["code"], message: string): never {
  throw new PortableRecoveryJobError(code, message);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && value !== "." && value !== "..";
}

function assertInput(input: RunPortableRecoveryJobInput): void {
  if ((input.direction !== "export" && input.direction !== "restore") || !safeId(input.operationId) || !safeId(input.objectId)) {
    fail("INVALID_INPUT", "portable recovery job arguments are invalid");
  }
  if (!(input.environment.key instanceof Uint8Array) || input.environment.key.byteLength !== 32) {
    fail("INVALID_ENVIRONMENT", "portable recovery environment is invalid");
  }
  for (const key of ["s3Endpoint", "s3Region", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey", "sourceReleaseId", "appDatabaseUrl", "logtoDatabaseUrl"] as const) {
    if (typeof input.environment[key] !== "string" || input.environment[key].trim() === "") fail("INVALID_ENVIRONMENT", "portable recovery environment is incomplete");
  }
  if (!SAFE_SOURCE_RELEASE_ID.test(input.environment.sourceReleaseId)) fail("INVALID_ENVIRONMENT", "portable recovery environment is invalid");
  if (input.direction === "restore" && !/^[a-f0-9]{64}$/.test(input.environment.expectedCiphertextSha256 ?? "")) fail("INVALID_ENVIRONMENT", "portable recovery expected receipt is invalid");
  if (input.direction === "export" && input.environment.expectedCiphertextSha256 !== undefined) fail("INVALID_ENVIRONMENT", "portable recovery expected receipt is invalid");
}

function parsePostgresUrl(value: string): { readonly host: string; readonly port: string; readonly user: string; readonly database: string; readonly password: string } {
  let url: URL;
  try { url = new URL(value); } catch { fail("INVALID_ENVIRONMENT", "portable recovery database authority is invalid"); }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname || !url.username || !url.pathname || url.search || url.hash) {
    fail("INVALID_ENVIRONMENT", "portable recovery database authority is invalid");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(database)) fail("INVALID_ENVIRONMENT", "portable recovery database authority is invalid");
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    database,
    password: decodeURIComponent(url.password),
  };
}

function pgpassField(value: string): string {
  if (value.includes(String.fromCharCode(0)) || value.includes("\r") || value.includes("\n")) fail("INVALID_ENVIRONMENT", "portable recovery database authority is invalid");
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function pgpassLine(authority: ReturnType<typeof parsePostgresUrl>): Uint8Array {
  return new TextEncoder().encode(`${pgpassField(authority.host)}:${pgpassField(authority.port)}:${pgpassField(authority.database)}:${pgpassField(authority.user)}:${pgpassField(authority.password)}\n`);
}

function childEnvironment(authority: ReturnType<typeof parsePostgresUrl>, pgpass: string): Record<string, string> {
  return {
    PGHOST: authority.host,
    PGPORT: authority.port,
    PGUSER: authority.user,
    PGPASSFILE: pgpass,
    PGDATABASE: authority.database,
    // Deliberately omit the inherited environment: it can carry platform
    // credentials unrelated to this one-shot job.
    PATH: CHILD_PATH,
    LANG: "C",
  };
}

async function withPgpass<T>(fs: PortableRecoveryFilesystem, authority: ReturnType<typeof parsePostgresUrl>, action: (path: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(join(tmpdir(), "nautilo-recovery-pgpass-"));
  const path = join(directory, "pgpass");
  try {
    await fs.writeFile(path, pgpassLine(authority), 0o600);
    await fs.chmod(path, 0o600);
    return await action(path);
  } finally {
    await fs.remove(directory);
  }
}

async function* childStream(child: PortableRecoveryChild): AsyncIterable<Uint8Array> {
  for await (const chunk of child.stdout) yield chunk;
  try { await child.completed; } catch { fail("SUBPROCESS_FAILED", "portable recovery subprocess failed"); }
}

async function* dumpSource(input: { readonly fs: PortableRecoveryFilesystem; readonly runner: PortableRecoveryProcessRunner; readonly databaseUrl: string; readonly command: "pg_dump" | "pg_dump16" }): AsyncIterable<Uint8Array> {
  const authority = parsePostgresUrl(input.databaseUrl);
  // Keep the pgpass file alive until pg_dump has exited, including while the
  // container writer exercises streaming backpressure.
  const directory = await input.fs.mkdtemp(join(tmpdir(), "nautilo-recovery-pgpass-"));
  const pgpass = join(directory, "pgpass");
  try {
    await input.fs.writeFile(pgpass, pgpassLine(authority), 0o600);
    await input.fs.chmod(pgpass, 0o600);
    // pg_dump writes to stdout when --file is omitted. `--file=-` is not a
    // stdout alias: it creates a file literally named `-`, yielding an
    // authenticated but empty recovery member.
    const child = await input.runner.start({ command: input.command, args: ["--format=custom", "--no-owner", "--no-privileges"], env: childEnvironment(authority, pgpass) });
    yield* childStream(child);
  } finally {
    await input.fs.remove(directory);
  }
}

function safeArchiveName(name: string): boolean {
  // GNU tar's literal C-locale listing is parseable with spaces in the final
  // pathname remainder. Newlines/backslashes/control characters are rejected
  // because a human/log parser cannot distinguish them safely.
  return name.length > 0 && !Array.from(name).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\";
  }) && name !== "." && name !== "..";
}

async function assertSafeTree(fs: PortableRecoveryFilesystem, root: string): Promise<void> {
  if (!(await fs.exists(root))) return;
  const walk = async (path: string): Promise<void> => {
    const node = await fs.lstat(path);
    if (node.isSymbolicLink || node.isSocket || node.isBlockDevice || node.isCharacterDevice || node.isFIFO || (!node.isDirectory && !node.isFile)) fail("UNSAFE_VOLUME", "portable recovery volume contains an unsafe entry");
    if (node.isDirectory) for (const name of await fs.readdir(path)) {
      if (!safeArchiveName(name)) fail("UNSAFE_VOLUME", "portable recovery volume contains an unsafe entry");
      await walk(join(path, name));
    }
  };
  await walk(root);
}

async function* tarSource(input: { readonly fs: PortableRecoveryFilesystem; readonly runner: PortableRecoveryProcessRunner; readonly root: string; readonly name: PortableRecoveryRootName }): AsyncIterable<Uint8Array> {
  const absolute = join(input.root, input.name);
  await assertSafeTree(input.fs, absolute);
  const exists = await input.fs.exists(absolute);
  const args = exists
    ? ["--create", "--format=posix", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--pax-option=delete=atime,delete=ctime", "--file=-", "-C", input.root, input.name]
    : ["--create", "--format=posix", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--pax-option=delete=atime,delete=ctime", "--files-from=/dev/null", "--file=-"];
  yield* childStream(await input.runner.start({ command: "tar", args, env: { PATH: CHILD_PATH, LANG: "C" } }));
}

function memberRoot(name: PortableRecoveryMemberName): PortableRecoveryRootName | undefined {
  if (name === "artifacts.tar") return "artifacts";
  if (name === "media.tar") return "media";
  if (name === "apps.tar") return "apps";
  return undefined;
}

function stagingPath(fs: PortableRecoveryFilesystem, operationId: string): string {
  return join(fs.root, ".portable-recovery", operationId);
}

function stageMarker(identity: PortableRecoveryObjectIdentity, descriptor: PortableRecoveryCompletionDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: "nautilo-recovery-stage-v1",
    operationId: identity.operationId,
    objectId: identity.objectId,
    ciphertextSha256: descriptor.ciphertextSha256,
    ciphertextBytes: descriptor.ciphertextBytes,
    sourceReleaseId: descriptor.sourceReleaseId,
  }));
}

function successMarkerPath(fs: PortableRecoveryFilesystem, identity: PortableRecoveryObjectIdentity): string {
  return join(fs.root, ".portable-recovery-success", identity.operationId, `${identity.objectId}.json`);
}

function successMarker(identity: PortableRecoveryObjectIdentity, descriptor: PortableRecoveryCompletionDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: "nautilo-recovery-success-v1",
    operationId: identity.operationId,
    objectId: identity.objectId,
    ciphertextSha256: descriptor.ciphertextSha256,
    ciphertextBytes: descriptor.ciphertextBytes,
    sourceReleaseId: descriptor.sourceReleaseId,
  }));
}

async function hasMatchingSuccessMarker(fs: PortableRecoveryFilesystem, identity: PortableRecoveryObjectIdentity, descriptor: PortableRecoveryCompletionDescriptor): Promise<boolean> {
  const path = successMarkerPath(fs, identity);
  if (!(await fs.exists(path))) return false;
  const actual = await fs.readFile(path);
  const expected = successMarker(identity, descriptor);
  return actual.byteLength === expected.byteLength && actual.every((byte, index) => byte === expected[index]);
}

async function writeSuccessMarker(fs: PortableRecoveryFilesystem, identity: PortableRecoveryObjectIdentity, descriptor: PortableRecoveryCompletionDescriptor): Promise<void> {
  const path = successMarkerPath(fs, identity);
  const operationDirectory = dirname(path);
  const rootDirectory = dirname(operationDirectory);
  await fs.mkdir(rootDirectory, 0o700);
  await fs.chmod(rootDirectory, 0o700);
  await fs.syncDirectory(fs.root);
  await fs.mkdir(operationDirectory, 0o700);
  await fs.chmod(operationDirectory, 0o700);
  await fs.syncDirectory(rootDirectory);
  const next = `${path}.next`;
  await fs.writeFile(next, successMarker(identity, descriptor), 0o600);
  await fs.chmod(next, 0o600);
  await fs.syncFile(next);
  await fs.rename(next, path);
  await fs.syncDirectory(operationDirectory);
}

function assertDescriptorAuthority(identity: PortableRecoveryObjectIdentity, environment: PortableRecoveryJobEnvironment, descriptor: PortableRecoveryCompletionDescriptor): void {
  if (
    descriptor.operationId !== identity.operationId
    || descriptor.objectId !== identity.objectId
    || descriptor.sourceReleaseId !== environment.sourceReleaseId
  ) fail("VERIFICATION_FAILED", "portable recovery descriptor does not match target authority");
}

async function hasMatchingStage(fs: PortableRecoveryFilesystem, path: string, identity: PortableRecoveryObjectIdentity, descriptor: PortableRecoveryCompletionDescriptor): Promise<boolean> {
  if (!(await fs.exists(join(path, "verified.json")))) return false;
  for (const name of PORTABLE_RECOVERY_MEMBERS) if (!(await fs.exists(join(path, name)))) return false;
  const actual = await fs.readFile(join(path, "verified.json"));
  const expected = stageMarker(identity, descriptor);
  if (actual.byteLength !== expected.byteLength) return false;
  return actual.every((byte, index) => byte === expected[index]);
}

async function assertFresh(input: RunPortableRecoveryJobInput): Promise<void> {
  for (const database of ["app", "logto"] as const) await input.assertFreshTarget.assertFresh({ database, root: input.fs.root });
  for (const root of ROOTS) {
    const target = join(input.fs.root, root);
    if (await input.fs.exists(target)) {
      const node = await input.fs.lstat(target);
      if (!node.isDirectory || node.isSymbolicLink) fail("PRECONDITION_FAILED", "portable recovery target is not fresh");
      if ((await input.fs.readdir(target)).length !== 0) fail("PRECONDITION_FAILED", "portable recovery target is not fresh");
    }
  }
}

/**
 * Fresh-target guard used by the image entry point.  The database test checks
 * for user tables via the same non-secret env/pgpass channel used for restore;
 * it intentionally refuses an existing populated target before one mutation.
 */
export function createPortableRecoveryFreshTargetPrecondition(input: {
  readonly fs: PortableRecoveryFilesystem;
  readonly runner: PortableRecoveryProcessRunner;
  readonly environment: Pick<PortableRecoveryJobEnvironment, "appDatabaseUrl" | "logtoDatabaseUrl">;
}): PortableRecoveryFreshTargetPrecondition {
  return {
    async assertFresh({ database }): Promise<void> {
      const authority = parsePostgresUrl(database === "app" ? input.environment.appDatabaseUrl : input.environment.logtoDatabaseUrl);
      await withPgpass(input.fs, authority, async (pgpass) => {
        const child = await input.runner.start({
          command: database === "app" ? "psql" : "psql16",
          args: ["--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"],
          env: childEnvironment(authority, pgpass),
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of child.stdout) chunks.push(chunk);
        try { await child.completed; } catch { fail("PRECONDITION_FAILED", "portable recovery target is not fresh"); }
        if (new TextDecoder().decode(concat(chunks)).trim() !== "0") fail("PRECONDITION_FAILED", "portable recovery target is not fresh");
      });
    },
  };
}

async function runRestoreCommand(input: { readonly fs: PortableRecoveryFilesystem; readonly runner: PortableRecoveryProcessRunner; readonly databaseUrl: string; readonly dumpPath: string; readonly command: "pg_restore" | "pg_restore16"; readonly ownerRole: "nautilo" | "logto"; readonly useListPath?: string }): Promise<void> {
  const authority = parsePostgresUrl(input.databaseUrl);
  await withPgpass(input.fs, authority, async (pgpass) => {
    // The recovery connection uses the cluster administrator so it can replace
    // an empty target atomically.  Restore objects under the durable runtime
    // role, however, or --no-owner would leave every table owned by the admin
    // and the long-lived service could neither migrate nor query its data.
    const child = await input.runner.start({ command: input.command, args: ["--single-transaction", "--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-privileges", `--role=${input.ownerRole}`, ...(input.useListPath === undefined ? [] : ["--use-list", input.useListPath]), "--dbname", authority.database, input.dumpPath], env: childEnvironment(authority, pgpass) });
    for await (const _chunk of child.stdout) { /* pg_restore stdout is intentionally ignored. */ }
    try { await child.completed; } catch { fail("SUBPROCESS_FAILED", "portable recovery subprocess failed"); }
  });
}

const APP_EXTENSION_REPAIR_SQL = [
  "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
  "CREATE EXTENSION IF NOT EXISTS vector;",
].join("\n");
const APP_RETAINED_EXTENSIONS = new Set(["pg_trgm", "vector"]);

/**
 * Preserve the two reviewed app extensions while restoring every application
 * object as the durable runtime role. `pg_restore --clean --role=nautilo`
 * cannot recreate pgvector because extension installation is superuser-only.
 * The authenticated dump may name only this exact extension set; all matching
 * extension and extension-comment TOC entries are omitted from the role-scoped
 * restore after the administrator has ensured them idempotently.
 */
async function prepareAppRestoreList(input: {
  readonly fs: PortableRecoveryFilesystem;
  readonly runner: PortableRecoveryProcessRunner;
  readonly dumpPath: string;
  readonly listPath: string;
}): Promise<void> {
  const child = await input.runner.start({
    command: "pg_restore",
    args: ["--list", input.dumpPath],
    env: { PATH: CHILD_PATH, LANG: "C" },
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  try { await child.completed; } catch { fail("SUBPROCESS_FAILED", "portable recovery restore list failed"); }
  const retained: string[] = [];
  const observed = new Set<string>();
  for (const rawLine of new TextDecoder().decode(concat(chunks)).split("\n")) {
    const line = rawLine.trimEnd();
    const extension = /(?: EXTENSION - | COMMENT - EXTENSION )([^ ]+)$/.exec(line)?.[1];
    if (extension !== undefined) {
      if (!APP_RETAINED_EXTENSIONS.has(extension)) fail("VERIFICATION_FAILED", "portable recovery app extension is unsupported");
      observed.add(extension);
      continue;
    }
    if (line.includes(" EXTENSION ")) fail("VERIFICATION_FAILED", "portable recovery app extension entry is invalid");
    retained.push(rawLine);
  }
  if ([...APP_RETAINED_EXTENSIONS].some((extension) => !observed.has(extension))) {
    fail("VERIFICATION_FAILED", "portable recovery app extension set is incomplete");
  }
  await input.fs.writeFile(input.listPath, new TextEncoder().encode(retained.join("\n")), 0o600);
  await input.fs.chmod(input.listPath, 0o600);
  await input.fs.syncFile(input.listPath);
}

async function runSqlRepair(input: { readonly fs: PortableRecoveryFilesystem; readonly runner: PortableRecoveryProcessRunner; readonly databaseUrl: string; readonly sql: string; readonly command: "psql" | "psql16" }): Promise<void> {
  const authority = parsePostgresUrl(input.databaseUrl);
  await withPgpass(input.fs, authority, async (pgpass) => {
    const child = await input.runner.start({
      command: input.command,
      args: ["--set", "ON_ERROR_STOP=1", "--single-transaction", "--command", input.sql],
      env: childEnvironment(authority, pgpass),
    });
    for await (const _chunk of child.stdout) { /* psql has no output protocol. */ }
    try { await child.completed; } catch { fail("SUBPROCESS_FAILED", "portable recovery role repair failed"); }
  });
}

const APP_REPAIR_SQL = [
  buildAppRoleOwnershipRepairSql(),
  buildAgentRoleGrantsSql(),
  buildFullCryptoTablePrivilegeReconcileSql(),
].join("\n\n");

async function validateAndExtractTar(input: { readonly runner: PortableRecoveryProcessRunner; readonly fs: PortableRecoveryFilesystem; readonly archivePath: string; readonly destination: string; readonly root: PortableRecoveryRootName }): Promise<void> {
  const listed = await input.runner.start({ command: "tar", args: ["--list", "--verbose", "--numeric-owner", "--full-time", "--quoting-style=literal", "--file", input.archivePath], env: { PATH: CHILD_PATH, LANG: "C" } });
  const lines: Uint8Array[] = [];
  for await (const chunk of listed.stdout) lines.push(chunk);
  try { await listed.completed; } catch { fail("UNSAFE_VOLUME", "portable recovery archive is unsafe"); }
  const output = new TextDecoder().decode(concat(lines));
  for (const line of output.split("\n").filter(Boolean)) {
    const match = /^([d-][rwxStTs-]{9})\s+0\/0\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(.+)$/.exec(line);
    const type = match?.[1]?.[0];
    const rawEntry = match?.[2];
    const entry = type === "d" && rawEntry?.endsWith("/") ? rawEntry.slice(0, -1) : rawEntry;
    if ((type !== "-" && type !== "d") || entry === undefined || entry.length === 0 || !entry.split("/").every(safeArchiveName) || (entry !== input.root && !entry.startsWith(`${input.root}/`))) fail("UNSAFE_VOLUME", "portable recovery archive is unsafe");
  }
  await input.fs.mkdir(input.destination, 0o700);
  const extract = await input.runner.start({ command: "tar", args: ["--extract", "--file", input.archivePath, "--directory", input.destination, "--no-same-owner", "--no-same-permissions"], env: { PATH: CHILD_PATH, LANG: "C" } });
  for await (const _chunk of extract.stdout) { /* no protocol on stdout */ }
  try { await extract.completed; } catch { fail("UNSAFE_VOLUME", "portable recovery archive is unsafe"); }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

export async function runPortableRecoveryJob(input: RunPortableRecoveryJobInput): Promise<PortableRecoveryJobResult> {
  assertInput(input);
  // Snapshot mutable caller-owned authority before the first await.  The job
  // never lets an orchestrator swap target identity, root, or key mid-run.
  const stable = {
    direction: input.direction,
    operationId: input.operationId,
    objectId: input.objectId,
    environment: { ...input.environment, key: input.environment.key.slice() },
    runner: input.runner,
    fs: input.fs,
    storage: input.storage,
    assertFreshTarget: input.assertFreshTarget,
    ...(input.random === undefined ? {} : { random: input.random }),
    ...(input.now === undefined ? {} : { now: input.now }),
  } satisfies RunPortableRecoveryJobInput;
  const identity = { operationId: stable.operationId, objectId: stable.objectId } as const;
  const now = stable.now ?? (() => new Date());
  if (stable.direction === "export") {
    // Validate every volume root before opening the remote upload. This keeps
    // unsafe source topology from becoming a partial object-store operation.
    for (const root of ROOTS) await assertSafeTree(stable.fs, join(stable.fs.root, root));
    const members = PORTABLE_RECOVERY_MEMBERS.map((name) => {
      if (name === "app-postgres.dump") return { name, chunks: dumpSource({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.appDatabaseUrl, command: "pg_dump" }) };
      if (name === "logto-postgres.dump") return { name, chunks: dumpSource({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.logtoDatabaseUrl, command: "pg_dump16" }) };
      const root = memberRoot(name)!;
      return { name, chunks: tarSource({ fs: stable.fs, runner: stable.runner, root: stable.fs.root, name: root }) };
    });
    const writer = writePortableRecovery({ key: stable.environment.key, nonceSeed: (stable.random ?? randomBytes)(32), sourceRelease: stable.environment.sourceReleaseId, members });
    const descriptor = await stable.storage.publish({ identity, bundle: writer.stream, receipt: writer.completion, sourceReleaseId: stable.environment.sourceReleaseId, completedAt: now() });
    return { direction: "export", descriptor };
  }

  const base = stagingPath(stable.fs, stable.operationId);
  const staging = join(base, stable.objectId);
  let verified = false;
  let discardStaging = false;
  try {
    const observation = stable.storage.observe === undefined ? undefined : await stable.storage.observe(identity);
    const observedDescriptor = observation?.state === "complete" ? observation.descriptor : undefined;
    const expectedSha = stable.environment.expectedCiphertextSha256!;
    if (observedDescriptor !== undefined) {
      assertDescriptorAuthority(identity, stable.environment, observedDescriptor);
      if (observedDescriptor.ciphertextSha256 !== expectedSha) fail("VERIFICATION_FAILED", "portable recovery receipt does not match expected authority");
    }
    if (observedDescriptor !== undefined && await hasMatchingSuccessMarker(stable.fs, identity, observedDescriptor)) {
      if (await stable.fs.exists(staging)) {
        await stable.fs.remove(staging);
        await stable.fs.syncDirectory(base);
      }
      return { direction: "restore", descriptor: observedDescriptor };
    }
    const resume = observedDescriptor !== undefined && observedDescriptor.sourceReleaseId === stable.environment.sourceReleaseId && await hasMatchingStage(stable.fs, staging, identity, observedDescriptor);
    if (observedDescriptor !== undefined && observedDescriptor.sourceReleaseId !== stable.environment.sourceReleaseId) fail("VERIFICATION_FAILED", "portable recovery source release does not match target authority");
    let download: { readonly descriptor: PortableRecoveryCompletionDescriptor; readonly body: AsyncIterable<Uint8Array> } | undefined;
    let descriptor = observedDescriptor;
    if (!resume) {
      await assertFresh(stable);
      // A failed fresh preflight has now returned without ever opening the
      // bundle body. Only a target that is authorized to mutate may download.
      download = await stable.storage.download(identity);
      descriptor = download.descriptor;
      assertDescriptorAuthority(identity, stable.environment, descriptor);
      if (descriptor.ciphertextSha256 !== expectedSha) fail("VERIFICATION_FAILED", "portable recovery receipt does not match expected authority");
      if (observedDescriptor !== undefined && (
        descriptor.ciphertextSha256 !== observedDescriptor.ciphertextSha256
        || descriptor.ciphertextBytes !== observedDescriptor.ciphertextBytes
        || descriptor.sourceReleaseId !== observedDescriptor.sourceReleaseId
        || descriptor.operationId !== observedDescriptor.operationId
        || descriptor.objectId !== observedDescriptor.objectId
      )) fail("VERIFICATION_FAILED", "portable recovery descriptor changed during recovery preflight");
      if (await stable.fs.exists(staging)) await stable.fs.remove(staging);
      await stable.fs.mkdir(dirname(base), 0o700);
      await stable.fs.chmod(dirname(base), 0o700);
      await stable.fs.syncDirectory(stable.fs.root);
      await stable.fs.mkdir(base, 0o700);
      await stable.fs.chmod(base, 0o700);
      await stable.fs.syncDirectory(dirname(base));
      await stable.fs.mkdir(staging, 0o700);
      await stable.fs.syncDirectory(base);
      discardStaging = true;
    }
    if (descriptor === undefined) fail("VERIFICATION_FAILED", "portable recovery descriptor is unavailable");
    await stable.fs.chmod(staging, 0o700);
    const memberPaths = new Map<PortableRecoveryMemberName, string>();
    for (const name of PORTABLE_RECOVERY_MEMBERS) {
      const path = join(staging, name);
      memberPaths.set(name, path);
      if (!resume) {
        await stable.fs.writeFile(path, new Uint8Array(), 0o600);
        await stable.fs.chmod(path, 0o600);
      }
    }
    if (!resume) {
      await readPortableRecovery({ source: download!.body, key: stable.environment.key, expectedReceipt: { ciphertextSha256: descriptor.ciphertextSha256, ciphertextBytes: descriptor.ciphertextBytes }, onChunk: async ({ member, plaintext }) => { await stable.fs.appendFile(memberPaths.get(member)!, plaintext); } });
      for (const path of memberPaths.values()) await stable.fs.syncFile(path);
      const markerNext = join(staging, "verified.json.next");
      await stable.fs.writeFile(markerNext, stageMarker(identity, descriptor), 0o600);
      await stable.fs.chmod(markerNext, 0o600);
      await stable.fs.syncFile(markerNext);
      await stable.fs.rename(markerNext, join(staging, "verified.json"));
      await stable.fs.syncDirectory(staging);
    }
    verified = true;
    discardStaging = false;
    await runSqlRepair({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.appDatabaseUrl, sql: APP_EXTENSION_REPAIR_SQL, command: "psql" });
    const appRestoreListPath = join(staging, "app-postgres.list");
    await prepareAppRestoreList({ fs: stable.fs, runner: stable.runner, dumpPath: memberPaths.get("app-postgres.dump")!, listPath: appRestoreListPath });
    await runRestoreCommand({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.appDatabaseUrl, dumpPath: memberPaths.get("app-postgres.dump")!, command: "pg_restore", ownerRole: "nautilo", useListPath: appRestoreListPath });
    await runSqlRepair({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.appDatabaseUrl, sql: APP_REPAIR_SQL, command: "psql" });
    await runRestoreCommand({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.logtoDatabaseUrl, dumpPath: memberPaths.get("logto-postgres.dump")!, command: "pg_restore16", ownerRole: "logto" });
    await runSqlRepair({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.logtoDatabaseUrl, sql: LOGTO_TENANT_PASSWORD_RESYNC_SQL, command: "psql16" });
    await runSqlRepair({ fs: stable.fs, runner: stable.runner, databaseUrl: stable.environment.logtoDatabaseUrl, sql: LOGTO_TENANT_REGRANT_SQL, command: "psql16" });
    // A process can die between root renames. The verified tar members are the
    // authority, so normalize every resume back to exact empty targets and a
    // clean extraction tree before attempting promotion again.
    if (resume) for (const root of ROOTS) {
      const target = join(stable.fs.root, root);
      if (await stable.fs.exists(target)) await stable.fs.remove(target);
      await stable.fs.mkdir(target, 0o700);
    }
    const rootsStaging = join(staging, "roots");
    if (await stable.fs.exists(rootsStaging)) await stable.fs.remove(rootsStaging);
    await stable.fs.mkdir(rootsStaging, 0o700);
    const promoted: PortableRecoveryRootName[] = [];
    try {
      for (const root of ROOTS) {
        const extracted = join(staging, "roots", root);
        await validateAndExtractTar({ fs: stable.fs, runner: stable.runner, archivePath: memberPaths.get(`${root}.tar` as PortableRecoveryMemberName)!, destination: extracted, root });
        // An absent source root is represented by the deterministic empty tar;
        // materialize a real empty root so promotion remains exact.
        await stable.fs.mkdir(join(extracted, root), 0o700);
      }
      for (const root of ROOTS) {
        const contentRoot = join(staging, "roots", root, root);
        const target = join(stable.fs.root, root);
        if (await stable.fs.exists(target)) await stable.fs.removeEmptyDirectory(target);
        await stable.fs.rename(contentRoot, target);
        promoted.push(root);
      }
    } catch {
      // Move successfully promoted roots back to their retained verified stage
      // in reverse order, then recreate the prior empty targets. This leaves
      // a retryable all-empty target, never a mixed root set.
      for (const root of [...promoted].reverse()) {
        const target = join(stable.fs.root, root);
        await stable.fs.rename(target, join(staging, "roots", root, root));
        await stable.fs.mkdir(target, 0o700);
      }
      fail("PROMOTION_FAILED", "portable recovery promotion failed; staging was retained for recovery");
    }
    for (const root of ROOTS) await stable.fs.syncDirectory(join(stable.fs.root, root));
    await stable.fs.syncDirectory(stable.fs.root);
    await writeSuccessMarker(stable.fs, identity, descriptor);
    await stable.fs.remove(staging);
    await stable.fs.syncDirectory(base);
    return { direction: "restore", descriptor };
  } catch (cause) {
    if (!verified && discardStaging) await stable.fs.remove(staging);
    if (cause instanceof PortableRecoveryJobError) throw cause;
    fail(verified ? "SUBPROCESS_FAILED" : "VERIFICATION_FAILED", verified ? "portable recovery restore failed; staging was retained for recovery" : "portable recovery verification failed");
  }
}

/** Read exact recovery authority from an explicit environment object, never ambient fallback discovery. */
export function readPortableRecoveryJobEnvironment(env: Readonly<Record<string, string | undefined>>): PortableRecoveryJobEnvironment {
  for (const name of REQUIRED_ENV) if (!env[name]?.trim()) fail("INVALID_ENVIRONMENT", "portable recovery environment is incomplete");
  const keyText = env["NAUTILO_RECOVERY_KEY"]!;
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyText)) fail("INVALID_ENVIRONMENT", "portable recovery environment is invalid");
  const key = Uint8Array.from(Buffer.from(keyText, "base64url"));
  if (key.byteLength !== 32 || Buffer.from(key).toString("base64url") !== keyText) fail("INVALID_ENVIRONMENT", "portable recovery environment is invalid");
  return {
    s3Endpoint: env["NAUTILO_RECOVERY_S3_ENDPOINT"]!, s3Region: env["NAUTILO_RECOVERY_S3_REGION"]!, s3Bucket: env["NAUTILO_RECOVERY_S3_BUCKET"]!,
    ...(env["NAUTILO_RECOVERY_S3_PREFIX"]?.trim() ? { s3Prefix: env["NAUTILO_RECOVERY_S3_PREFIX"] } : {}),
    s3AccessKeyId: env["NAUTILO_RECOVERY_S3_ACCESS_KEY_ID"]!, s3SecretAccessKey: env["NAUTILO_RECOVERY_S3_SECRET_ACCESS_KEY"]!,
    ...(env["NAUTILO_RECOVERY_S3_SESSION_TOKEN"]?.trim() ? { s3SessionToken: env["NAUTILO_RECOVERY_S3_SESSION_TOKEN"] } : {}),
    key, sourceReleaseId: env["NAUTILO_RECOVERY_SOURCE_RELEASE_ID"]!,
    ...(env["NAUTILO_RECOVERY_EXPECTED_SHA256"]?.trim() ? { expectedCiphertextSha256: env["NAUTILO_RECOVERY_EXPECTED_SHA256"] } : {}),
    appDatabaseUrl: env["NAUTILO_RECOVERY_APP_DATABASE_URL"]!, logtoDatabaseUrl: env["NAUTILO_RECOVERY_LOGTO_DATABASE_URL"]!,
  };
}

export function createDefaultPortableRecoveryObjectStore(environment: PortableRecoveryJobEnvironment): PortableRecoveryObjectStore {
  return createS3CompatiblePortableRecoveryObjectStore({
    endpoint: environment.s3Endpoint, region: environment.s3Region, bucket: environment.s3Bucket,
    ...(environment.s3Prefix === undefined ? {} : { prefix: environment.s3Prefix }),
    accessKeyId: environment.s3AccessKeyId, secretAccessKey: environment.s3SecretAccessKey,
    ...(environment.s3SessionToken === undefined ? {} : { sessionToken: environment.s3SessionToken }),
  });
}

export function createNodePortableRecoveryFilesystem(root = "/var/lib/nautilo"): PortableRecoveryFilesystem {
  return {
    root: resolve(root),
    exists: (path) => Promise.resolve(existsSync(path)),
    lstat: async (path) => { const node = await lstat(path); return { isDirectory: node.isDirectory(), isFile: node.isFile(), isSymbolicLink: node.isSymbolicLink(), isSocket: node.isSocket(), isBlockDevice: node.isBlockDevice(), isCharacterDevice: node.isCharacterDevice(), isFIFO: node.isFIFO() }; },
    readdir: (path) => Promise.resolve(readdirSync(path)),
    mkdir: async (path, mode) => { await mkdir(path, { recursive: true, mode }); },
    mkdtemp: async (prefix) => mkdtemp(prefix),
    chmod: async (path, mode) => { await chmod(path, mode); },
    writeFile: async (path, bytes, mode) => { await writeFile(path, bytes, { mode }); },
    appendFile: async (path, bytes) => { await appendFile(path, bytes); },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    rename: async (from, to) => { await rename(from, to); },
    remove: async (path) => { await rm(path, { recursive: true, force: true }); },
    removeEmptyDirectory: async (path) => { await rmdir(path); },
    syncFile: async (path) => { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } },
    syncDirectory: async (path) => { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } },
  };
}

export function createNodePortableRecoveryRunner(): PortableRecoveryProcessRunner {
  return {
    start({ command, args, env, cwd }) {
      const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
      if (child.stdout === null) fail("SUBPROCESS_FAILED", "portable recovery subprocess could not start");
      const completed = new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => { if (code === 0) resolvePromise(); else reject(new Error("subprocess failed")); });
      });
      return Promise.resolve({ stdout: child.stdout, completed });
    },
  };
}
