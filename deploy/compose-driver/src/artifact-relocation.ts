import type { RelocationSourceProof } from "./artifact-relocation-backup.ts";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { PHYSICAL_FILE_URI_COLUMNS, physicalFileUriBase, rebindPhysicalFileUri } from "@nautilo/db";

export type StorageRow = Record<string, unknown> & { id: string };
export type StorageTable = typeof PHYSICAL_FILE_URI_COLUMNS[number][0];
export interface StorageSnapshot {
  identity: Record<string, unknown>;
  artifacts: StorageRow[];
  message_attachments: StorageRow[];
  workspace_document_mutation_entries: StorageRow[];
}
export interface RelocationTarget {
  instanceId: string;
  project: string;
  serverContainer: string;
  databaseContainer: string;
  imageId: string;
  artifactsRoot: string;
}
export interface RelocationFile {
  path: string;
  size: number;
  sha256: string;
}
export interface ArtifactRelocationPlan {
  schemaVersion: 1;
  target: RelocationTarget;
  sourceRoot: string;
  targetRoot: string;
  before: StorageSnapshot;
  files: RelocationFile[];
  source: RelocationSourceProof;
}
export interface ArtifactRelocationDeps {
  target(): Promise<RelocationTarget>;
  sql(input: string): Promise<string>;
  files(root: string, paths: string[], configuredRoot?: string): Promise<RelocationFile[]>;
  sourceFiles(root: string, paths: string[]): Promise<RelocationSourceProof>;
}
const tables = [...new Set(PHYSICAL_FILE_URI_COLUMNS.map(([table]) => table))];
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown): string => `${literal(JSON.stringify(value))}::jsonb`;

/** Full metadata snapshot also detects concurrent history/content/identity changes. */
const ARTIFACT_STORAGE_SNAPSHOT_SQL = `jsonb_build_object(
  'identity', (SELECT to_jsonb(t) FROM public.nautilo_instance_identity t WHERE id = 'self'),
  ${tables.map(table => `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM public."${table}" t)`).join(",\n")}
)`;

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Artifact relocation refused: ${message}`);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function relocationPlanSha256(plan: ArtifactRelocationPlan): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }

function validateSnapshot(value: unknown, instanceId: string): asserts value is StorageSnapshot {
  requireCondition(value !== null && typeof value === "object", "missing snapshot");
  const snapshot = value as StorageSnapshot;
  requireCondition(snapshot.identity?.["instance_id"] === instanceId, "database instance identity differs");
  requireCondition(typeof snapshot.identity["server_instance_id"] === "string", "missing durable server identity");
  for (const table of tables) {
    requireCondition(Array.isArray(snapshot[table]), "missing physical-reference table");
    const ids = new Set<string>();
    for (const row of snapshot[table]) {
      requireCondition(row !== null && typeof row === "object" && typeof row.id === "string" && /^[a-f0-9-]{36}$/.test(row.id) && !ids.has(row.id), "invalid or duplicate row identity");
      ids.add(row.id);
    }
  }
}

export function relocationReferences(plan: Pick<ArtifactRelocationPlan, "sourceRoot" | "targetRoot" | "before">): Array<{ table: StorageTable; row: StorageRow; column: string; oldUri: string; newUri: string; path: string; size: number; sha256?: string }> {
  physicalFileUriBase(plan.sourceRoot); physicalFileUriBase(plan.targetRoot);
  requireCondition(plan.sourceRoot !== plan.targetRoot, "roots must differ");
  const references = [];
  for (const [table, column] of PHYSICAL_FILE_URI_COLUMNS) {
    for (const row of plan.before[table]) {
      const uri = row[column];
      if (uri === null) continue;
      requireCondition(typeof uri === "string", "invalid stored file URI");
      const newUri = rebindPhysicalFileUri(uri, plan.sourceRoot, plan.targetRoot);
      if (newUri === uri) continue;
      const suffix = uri.slice(physicalFileUriBase(plan.sourceRoot).length + 1);
      requireCondition(suffix !== "" && !suffix.split("/").some(part => !part || part === "." || part === "..") && !/[\0\r\n%\\]/.test(suffix), "non-canonical descendant path");
      const path = posix.join(plan.targetRoot, suffix);
      requireCondition(path.startsWith(plan.targetRoot + "/") && newUri === `file://${path}`, "path escaped destination");
      if (table === "artifacts") requireCondition(row["crypto_object_id"] == null, "encrypted artifact requires its own storage contract");
      const stem = column.replace(/storage_uri$/, "");
      const rawSize = row[table === "message_attachments" ? "size_bytes" : `${stem}size`];
      requireCondition(rawSize !== null && rawSize !== undefined, "missing retained byte size");
      const size = typeof rawSize === "number" ? rawSize : Number(rawSize);
      requireCondition(Number.isSafeInteger(size) && size >= 0, "invalid retained byte size");
      const rawHash = table === "workspace_document_mutation_entries" ? row[`${stem}sha256`] : undefined;
      requireCondition(rawHash === undefined || typeof rawHash === "string" && /^[a-f0-9]{64}$/.test(rawHash), "invalid history hash");
      references.push({ table, row, column, oldUri: uri, newUri, path, size, ...(typeof rawHash === "string" ? { sha256: rawHash } : {}) });
    }
  }
  return references;
}

export function relocatedSnapshot(plan: ArtifactRelocationPlan): StorageSnapshot {
  const result = structuredClone(plan.before);
  for (const ref of relocationReferences(plan)) {
    result[ref.table].find(row => row.id === ref.row.id)![ref.column] = ref.newUri;
  }
  return result;
}

function validateFiles(plan: Pick<ArtifactRelocationPlan, "sourceRoot" | "targetRoot" | "before">, observed: RelocationFile[]): void {
  const refs = relocationReferences(plan);
  const paths = [...new Set(refs.map(ref => ref.path))].sort();
  requireCondition(same(observed.map(file => file.path).sort(), paths), "incomplete or extra byte proof");
  for (const file of observed) {
    requireCondition(Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), "invalid file proof");
    for (const ref of refs.filter(ref => ref.path === file.path)) {
      requireCondition(ref.size === file.size, "preserved byte size differs");
      requireCondition(ref.sha256 === undefined || ref.sha256 === file.sha256, "document-history hash differs");
    }
  }
}

export async function planArtifactRelocation(sourceRoot: string, deps: ArtifactRelocationDeps): Promise<ArtifactRelocationPlan> {
  const target = await deps.target();
  physicalFileUriBase(target.artifactsRoot);
  const before: unknown = JSON.parse(await deps.sql(`BEGIN TRANSACTION READ ONLY; SELECT ${ARTIFACT_STORAGE_SNAPSHOT_SQL}; COMMIT;`));
  validateSnapshot(before, target.instanceId);
  const base = { schemaVersion: 1 as const, target: structuredClone(target), sourceRoot, targetRoot: target.artifactsRoot, before };
  const refs = relocationReferences(base);
  requireCondition(refs.length > 0, "no matching physical references");
  const files = await deps.files(base.targetRoot, [...new Set(refs.map(ref => ref.path))].sort());
  validateFiles(base, files);
  const source = await deps.sourceFiles(base.targetRoot, files.map(file => file.path));
  requireCondition(same(source.files, files), "target bytes differ from verified original backup");
  return { ...base, files, source };
}

/** Atomic CAS: no authority, timestamps, revisions or content proofs are rewritten. */
export function artifactRelocationMutationSql(plan: ArtifactRelocationPlan, rollback = false): string {
  validateSnapshot(plan.before, plan.target.instanceId);
  const after = relocatedSnapshot(plan);
  const expected = rollback ? after : plan.before;
  const desired = rollback ? plan.before : after;
  const updates = relocationReferences(plan).map(ref => `UPDATE public."${ref.table}" SET "${ref.column}" = ${literal(rollback ? ref.oldUri : ref.newUri)} WHERE id = ${literal(ref.row.id)}::uuid;`).join("\n");
  const body = `BEGIN
IF (${ARTIFACT_STORAGE_SNAPSHOT_SQL}) IS DISTINCT FROM ${json(expected)} THEN RAISE EXCEPTION 'Relocation state changed; no writes committed'; END IF;
${updates}
IF (${ARTIFACT_STORAGE_SNAPSHOT_SQL}) IS DISTINCT FROM ${json(desired)} THEN RAISE EXCEPTION 'Relocation changed non-storage state; no writes committed'; END IF;
END;`;
  return `BEGIN;
LOCK TABLE public.nautilo_instance_identity IN SHARE MODE NOWAIT;
LOCK TABLE ${tables.map(table => `public."${table}"`).join(", ")} IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO ${literal(body)};
COMMIT;`;
}

export async function applyArtifactRelocation(plan: ArtifactRelocationPlan, expectedHash: string, deps: ArtifactRelocationDeps, rollback = false): Promise<{ outcome: "applied" | "rolled-back" | "already-applied" | "already-rolled-back"; planSha256: string }> {
  requireCondition(plan.schemaVersion === 1 && relocationPlanSha256(plan) === expectedHash, "plan digest differs");
  validateSnapshot(plan.before, plan.target.instanceId);
  requireCondition(plan.targetRoot === plan.target.artifactsRoot, "destination is not the configured artifact root");
  requireCondition(same(await deps.target(), plan.target), "target container, image, mount or identity changed");
  validateFiles(plan, plan.files);
  requireCondition(same(await deps.sourceFiles(plan.targetRoot, plan.files.map(file => file.path)), plan.source), "original backup evidence changed");
  requireCondition(same(plan.source.files, plan.files), "target bytes lack matching original evidence");
  if (rollback) {
    const originals = await deps.files(plan.sourceRoot, plan.files.map(file => plan.sourceRoot + file.path.slice(plan.targetRoot.length)), plan.targetRoot);
    requireCondition(same(originals, plan.files.map(file => ({ ...file, path: plan.sourceRoot + file.path.slice(plan.targetRoot.length) }))), "original-root bytes unavailable or changed; rollback refused");
  }
  const observedFiles = await deps.files(plan.targetRoot, plan.files.map(file => file.path));
  validateFiles(plan, observedFiles);
  requireCondition(same(observedFiles, plan.files), "bytes changed after planning");
  const observed: unknown = JSON.parse(await deps.sql(`BEGIN TRANSACTION READ ONLY; SELECT ${ARTIFACT_STORAGE_SNAPSHOT_SQL}; COMMIT;`));
  const desired = rollback ? plan.before : relocatedSnapshot(plan);
  if (same(observed, desired)) return { outcome: rollback ? "already-rolled-back" : "already-applied", planSha256: expectedHash };
  requireCondition(same(observed, rollback ? relocatedSnapshot(plan) : plan.before), "metadata changed after planning");
  await deps.sql(artifactRelocationMutationSql(plan, rollback));
  const result: unknown = JSON.parse(await deps.sql(`BEGIN TRANSACTION READ ONLY; SELECT ${ARTIFACT_STORAGE_SNAPSHOT_SQL}; COMMIT;`));
  requireCondition(same(result, desired), "commit readback differs; retain plan and inspect before retry");
  requireCondition(same(await deps.files(plan.targetRoot, plan.files.map(file => file.path)), plan.files), "bytes changed during repair; retain plan and inspect before retry");
  return { outcome: rollback ? "rolled-back" : "applied", planSha256: expectedHash };
}

/** Executed inside the existing server as its unprivileged runtime user. */
export const ARTIFACT_RELOCATION_FILE_PROBE = String.raw`
const fs = require('node:fs/promises'); const path = require('node:path'); const crypto = require('node:crypto');
const input = JSON.parse(await Bun.stdin.text());
if (process.env.NAUTILO_ARTIFACTS_ROOT !== (input.configuredRoot ?? input.root) || await fs.realpath(input.root) !== input.root) throw Error('Configured artifact root differs');
const result = [];
for (const file of input.paths) {
 if (!file.startsWith(input.root + '/') || path.resolve(file) !== file) throw Error('Unsafe path');
 for (let current = file; current !== input.root; current = path.dirname(current)) { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('Symlink refused'); }
 const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
 try {
  const before = await handle.stat(); if (!before.isFile()) throw Error('Nonregular artifact');
  const hash = crypto.createHash('sha256'); const stream = handle.createReadStream({ autoClose: false });
  for await (const chunk of stream) hash.update(chunk);
  const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('Artifact changed while hashing');
  result.push({ path: file, size: after.size, sha256: hash.digest('hex') });
 } finally { await handle.close(); }
}
console.log(JSON.stringify(result));`;
