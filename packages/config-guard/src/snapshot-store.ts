import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigOperationType, SnapshotMeta, TransactionActor } from "./types";

function newSnapshotId(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

export async function createSnapshot(
  snapshotDir: string,
  envContent: string,
  meta: Omit<SnapshotMeta, "id" | "timestamp" | "result"> & {
    operations: Array<{ type: ConfigOperationType; key: string }>;
  },
): Promise<string> {
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await chmod(snapshotDir, 0o700);
  const id = newSnapshotId();
  const envFile = join(snapshotDir, `${id}.env`);
  const metaFile = join(snapshotDir, `${id}.meta.json`);
  const fullMeta: SnapshotMeta = {
    id,
    timestamp: new Date().toISOString(),
    result: "pending",
    ...meta,
  };
  await writeFile(envFile, envContent, { encoding: "utf-8", mode: 0o600 });
  await writeFile(metaFile, JSON.stringify(fullMeta, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await pruneSnapshots(snapshotDir, 20);
  return id;
}

export async function updateSnapshotMeta(
  snapshotDir: string,
  id: string,
  patch: Partial<Pick<SnapshotMeta, "result" | "error">>,
): Promise<void> {
  const metaFile = join(snapshotDir, `${id}.meta.json`);
  const raw = await readFile(metaFile, "utf-8");
  const meta = JSON.parse(raw) as SnapshotMeta;
  const next = { ...meta, ...patch };
  await writeFile(metaFile, JSON.stringify(next, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(metaFile, 0o600);
}

export async function readSnapshotEnv(snapshotDir: string, id: string): Promise<string> {
  const envFile = join(snapshotDir, `${id}.env`);
  return readFile(envFile, "utf-8");
}

export async function pruneSnapshots(snapshotDir: string, maxCount: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(snapshotDir);
  } catch {
    return 0;
  }
  const ids = new Set<string>();
  for (const n of names) {
    if (n.endsWith(".env")) {
      ids.add(n.replace(/\.env$/, ""));
    }
  }
  const sorted = [...ids].sort();
  if (sorted.length <= maxCount) {
    return 0;
  }
  const remove = sorted.slice(0, sorted.length - maxCount);
  let pruned = 0;
  for (const id of remove) {
    await rm(join(snapshotDir, `${id}.env`), { force: true });
    await rm(join(snapshotDir, `${id}.meta.json`), { force: true });
    pruned += 1;
  }
  return pruned;
}

export type SnapshotListItem = SnapshotMeta;

export async function listSnapshots(snapshotDir: string): Promise<SnapshotListItem[]> {
  let names: string[];
  try {
    names = await readdir(snapshotDir);
  } catch {
    return [];
  }
  const metas: SnapshotMeta[] = [];
  for (const n of names) {
    if (!n.endsWith(".meta.json")) {
      continue;
    }
    try {
      const raw = await readFile(join(snapshotDir, n), "utf-8");
      metas.push(JSON.parse(raw) as SnapshotMeta);
    } catch {
      /* skip */
    }
  }
  return metas.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function snapshotOperationsSummary(
  actor: TransactionActor,
  reason: string,
  operations: Array<{ type: ConfigOperationType; key: string }>,
): Omit<SnapshotMeta, "id" | "timestamp" | "result"> {
  return { actor, reason, operations };
}
