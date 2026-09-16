import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SecurityScanInventoryEntry } from "@nautilo/types";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Complete metadata traversal through the same live authorized target; never follows symlinks. */
export async function captureSecurityInventory(input: {
  currentFolder: string;
  target: string;
  allowed: (path: string) => boolean;
  assertLive: () => Promise<void>;
  signal?: AbortSignal | undefined;
  onProgress?: ((counts: { filesObserved: number; directoriesObserved: number }) => void) | undefined;
}): Promise<SecurityScanInventoryEntry[]> {
  const currentFolder = await realpath(input.currentFolder);
  const target = await realpath(input.target);
  const entries: SecurityScanInventoryEntry[] = [];
  let directoriesObserved = 0;
  let filesObserved = 0;
  input.onProgress?.({ filesObserved, directoriesObserved });
  async function visit(path: string): Promise<void> {
    input.signal?.throwIfAborted();
    await input.assertLive();
    const relativePath = relative(currentFolder, path).split(sep).join("/");
    const add = (kind: SecurityScanInventoryEntry["kind"], reason: string | null, sizeBytes = 0, sourceVersion: string | null = null) => {
      entries.push({ id: `inventory_${hash(relativePath)}`, relativePath, kind, sizeBytes, sourceVersion, reason });
    };
    const info = await lstat(path).catch(() => null);
    if (!info) { add("unavailable", "Entry metadata was unavailable during inventory."); return; }
    if (info.isSymbolicLink()) { add("excluded", "Symbolic links are not traversed by the authorized source inventory."); return; }
    const canonical = await realpath(path).catch(() => null);
    if (!canonical || !contained(target, canonical) || !input.allowed(canonical)) {
      add("unavailable", "Entry is unavailable under the current filesystem authority."); return;
    }
    if (info.isDirectory()) {
      directoriesObserved += 1;
      input.onProgress?.({ filesObserved, directoriesObserved });
      if (path.split(sep).at(-1) === "node_modules") {
        add("excluded", "Installed dependency tree; manifests, lockfiles, first-party and vendored source remain inventoried. This exclusion is not dependency security clearance; explicitly targeting this tree inventories its source."); return;
      }
      if (path.split(sep).at(-1) === ".git") {
        add("excluded", "Git internal object and control metadata; current working-tree source remains inventoried."); return;
      }
      const names = await readdir(canonical).catch(() => null);
      if (!names) { add("unavailable", "Directory contents could not be enumerated."); return; }
      for (const name of names.sort()) await visit(resolve(canonical, name));
      input.onProgress?.({ filesObserved, directoriesObserved });
    } else if (info.isFile()) {
      filesObserved += 1;
      let format: string | null;
      try { format = await knownNonSourceFormat(canonical, info, input.assertLive); }
      catch { add("unavailable", "Candidate non-source format could not be checked safely.", info.size); return; }
      if (format !== null) { add("excluded", `Recognized ${format} media/document format; bytes are not text-source review evidence.`, info.size); return; }
      add("file", null, info.size, securityInventorySourceVersion(info));
    } else add("excluded", "Non-regular filesystem entries cannot be inspected as repository source.");
  }
  await input.assertLive();
  const names = await readdir(target);
  for (const name of names.sort()) await visit(resolve(target, name));
  await input.assertLive();
  input.onProgress?.({ filesObserved, directoriesObserved });
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export function securityInventoryFingerprint(entries: readonly SecurityScanInventoryEntry[]): string {
  return hash(JSON.stringify([...entries].sort((a, b) => a.id.localeCompare(b.id))));
}

/** Fixed format signatures, not a source read ceiling; unknown formats remain review work. */
async function knownNonSourceFormat(path: string, expected: { dev: number; ino: number; size: number; mtimeMs: number }, assertLive: () => Promise<void>): Promise<string | null> {
  // Extensions select candidates only; an exclusion requires matching binary format bytes.
  if (![".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".woff", ".woff2", ".otf", ".ogg", ".flac", ".mp3"].includes(extname(path).toLowerCase())) return null;
  await assertLive();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const live = await handle.stat();
    if (!live.isFile() || live.dev !== expected.dev || live.ino !== expected.ino || live.size !== expected.size || live.mtimeMs !== expected.mtimeMs) throw new Error("inventory_source_changed");
    await assertLive();
    // All signatures below fit within the 12-byte RIFF/ISO format header.
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const prefix = bytes.subarray(0, bytesRead);
    if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "PNG";
    if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "JPEG";
    const ascii = prefix.toString("latin1");
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "GIF";
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "WebP";
    if (ascii.startsWith("%PDF-")) return "PDF";
    if (ascii.startsWith("wOFF") || ascii.startsWith("wOF2")) return "WOFF font";
    if (ascii.startsWith("OTTO")) return "OpenType font";
    if (ascii.startsWith("OggS") || ascii.startsWith("fLaC") || ascii.startsWith("ID3")) return "audio";
    return null;
  } finally { await handle.close(); }
}

/** The same metadata version is attached to independently hashed source citations. */
export function securityInventorySourceVersion(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return hash(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
}
