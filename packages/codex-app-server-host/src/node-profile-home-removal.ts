import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open, opendir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { CodexHostError, type ProfileHomeRemovalFilesystem, type ProfileHomeRemovalSpec } from "./contracts";

const MAX_TREE_ENTRIES = 1_024;
const MAX_TREE_DEPTH = 16;
const MAX_REGULAR_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const QUARANTINE_PREFIX = ".nautilo-codex-removal-";

interface PlannedEntry { readonly path: string; readonly kind: "file" | "directory"; readonly dev: number; readonly ino: number; }

/** Node-only, deliberately narrow final deletion adapter. */
export const nodeProfileHomeRemovalFilesystem: ProfileHomeRemovalFilesystem = {
  async removeOwnedProfileHome(input) {
    const path = resolve(input.path);
    const root = resolve(input.containmentRoot);
    let quarantine: string | undefined;
    let moved = false;
    try {
      await assertRoot(root);
      if (!within(root, path) || path === root || dirname(path) !== root) throw invalid();
      await input.assertAuthorized();
      await assertExactHome(path, input);
      input.assertAuthorizedNow();
      quarantine = await nextQuarantinePath(root);
      // Rename moves the exact directory entry atomically. Everything after
      // this point acts only on the unguessable quarantine sibling.
      await rename(path, quarantine);
      moved = true;
      await input.assertAuthorized();
      await assertExactHome(quarantine, input);
      input.assertAuthorizedNow();
      const plan = await walkQuarantine(quarantine);
      await deletePlan(quarantine, plan, input);
    } catch (error) {
      if (moved && quarantine) await restoreExactQuarantine(quarantine, path, input);
      if (error instanceof CodexHostError) throw error;
      throw invalid();
    }
  },
};

async function assertRoot(root: string): Promise<void> {
  const directory = await lstat(root);
  if (directory.isSymbolicLink() || !directory.isDirectory() || (await realpath(root)) !== root) throw invalid();
}

async function assertExactHome(path: string, input: ProfileHomeRemovalSpec): Promise<void> {
  const directory = await lstat(path);
  if (directory.isSymbolicLink() || !directory.isDirectory() || Number(directory.dev) !== input.expectedDevice || Number(directory.ino) !== input.expectedInode || (await realpath(path)) !== path) throw invalid();
  const markerPath = join(path, input.markerName);
  const marker = await lstat(markerPath);
  if (marker.isSymbolicLink() || !marker.isFile() || !sameMarker(await readExactMarker(markerPath), input)) throw invalid();
}

async function nextQuarantinePath(root: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(root, `${QUARANTINE_PREFIX}${randomUUID()}`);
    try { await lstat(candidate); }
    catch (error) { if (isMissing(error)) return candidate; throw error; }
  }
  throw invalid();
}

/** Bounded no-follow walk that pins every later deletion to dev+inode. */
async function walkQuarantine(root: string): Promise<readonly PlannedEntry[]> {
  let entries = 0;
  let regularBytes = 0;
  const plan: PlannedEntry[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw invalid();
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        entries += 1;
        if (entries > MAX_TREE_ENTRIES) throw invalid();
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw invalid();
        if (stat.isDirectory()) {
          await visit(path, depth + 1);
          plan.push({ path, kind: "directory", dev: Number(stat.dev), ino: Number(stat.ino) });
        } else if (stat.isFile()) {
          regularBytes += Number(stat.size);
          if (!Number.isSafeInteger(regularBytes) || regularBytes > MAX_REGULAR_FILE_BYTES) throw invalid();
          plan.push({ path, kind: "file", dev: Number(stat.dev), ino: Number(stat.ino) });
        } else throw invalid();
      }
    } finally { try { await handle.close(); } catch { /* iterator may close it */ } }
  };
  await visit(root, 0);
  return plan;
}

/** No recursive syscall: each exact entry is revalidated immediately before it is removed. */
async function deletePlan(quarantine: string, plan: readonly PlannedEntry[], input: ProfileHomeRemovalSpec): Promise<void> {
  const markerPath = join(quarantine, input.markerName);
  const regular = plan.filter((entry) => entry.path !== markerPath && entry.kind === "file");
  const directories = plan.filter((entry) => entry.kind === "directory");
  const marker = plan.find((entry) => entry.path === markerPath);
  if (!marker || marker.kind !== "file") throw invalid();
  for (const entry of [...regular, ...directories, marker]) {
    // Async authority is part of the bounded reversible phase. Revalidate the
    // exact directory/entry after it settles, then use only the synchronous
    // check directly adjacent to the destructive syscall.
    await input.assertAuthorized();
    await assertExactDirectory(quarantine, input);
    await assertPlannedEntry(entry);
    // The synchronous assertion and syscall issuance are deliberately
    // adjacent: an async gate cannot authorize an unlink after it resolves.
    input.assertAuthorizedNow();
    if (entry === marker) input.commitDestruction();
    if (entry.kind === "file") {
      const deleting = unlink(entry.path);
      await deleting;
    } else {
      const deleting = rmdir(entry.path);
      await deleting;
    }
  }
  // The marker is necessarily gone now; prove only the exact quarantined
  // directory identity and remove it empty-only. A swap can never recurse.
  // The marker unlink committed this attempt, so do not await another
  // third-party authority hook here; it could otherwise hang after commit.
  await assertExactDirectory(quarantine, input);
  input.assertAuthorizedNow();
  const removing = rmdir(quarantine);
  await removing;
}

async function assertPlannedEntry(entry: PlannedEntry): Promise<void> {
  const stat = await lstat(entry.path);
  if (stat.isSymbolicLink() || (entry.kind === "file" ? !stat.isFile() : !stat.isDirectory()) || Number(stat.dev) !== entry.dev || Number(stat.ino) !== entry.ino) throw invalid();
}
async function assertExactDirectory(path: string, input: ProfileHomeRemovalSpec): Promise<void> {
  const directory = await lstat(path);
  // The root was realpath-pinned before its atomic rename. After that rename
  // every destructive edge lstat-pins the exact quarantine inode; a symlink
  // or replacement inode fails closed without paying a recursive realpath walk.
  if (directory.isSymbolicLink() || !directory.isDirectory() || Number(directory.dev) !== input.expectedDevice || Number(directory.ino) !== input.expectedInode) throw invalid();
}

/** Never overwrite a newly-created target and never restore a swapped inode. */
async function restoreExactQuarantine(quarantine: string, path: string, input: ProfileHomeRemovalSpec): Promise<void> {
  try {
    const moved = await lstat(quarantine);
    if (moved.isSymbolicLink() || !moved.isDirectory() || Number(moved.dev) !== input.expectedDevice || Number(moved.ino) !== input.expectedInode) return;
    // A failed final root removal happens after the marker has been unlinked.
    // Restore the exact marker before restoring the home, otherwise a retry
    // would be permanently bricked despite the home still being ours.
    await restoreExactMarker(quarantine, input);
    try { await lstat(path); return; }
    catch (error) { if (!isMissing(error)) return; }
    await rename(quarantine, path);
  } catch { /* preserve uncertain quarantine; it is never a deletion target */ }
}

async function restoreExactMarker(quarantine: string, input: ProfileHomeRemovalSpec): Promise<void> {
  await assertExactDirectory(quarantine, input);
  const markerPath = join(quarantine, input.markerName);
  try {
    await lstat(markerPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // Exclusive creation cannot overwrite a racing replacement entry.
    await writeFile(markerPath, JSON.stringify(input.expectedMarker), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  await assertExactHome(quarantine, input);
}

function sameMarker(value: unknown, input: ProfileHomeRemovalSpec): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return Object.keys(marker).length === 5 && marker["schemaVersion"] === input.expectedMarker.schemaVersion &&
    marker["actorId"] === input.expectedMarker.actorId && marker["profileHandle"] === input.expectedMarker.profileHandle &&
    marker["profileGeneration"] === input.expectedMarker.profileGeneration && marker["homeIdentityFingerprint"] === input.expectedMarker.homeIdentityFingerprint;
}
async function readExactMarker(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) throw invalid();
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } catch (error) {
    if (error instanceof CodexHostError) throw error;
    throw invalid();
  } finally { await handle?.close().catch(() => undefined); }
}
function within(root: string, path: string): boolean { return root === sep ? path.startsWith(sep) : path.startsWith(`${root}${sep}`); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT"; }
function invalid(): CodexHostError { return new CodexHostError("PROFILE_HOME_INVALID", "Profile home deletion revalidation failed"); }
