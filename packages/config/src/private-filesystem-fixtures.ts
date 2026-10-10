import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync } from "node:fs";
import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";

// Test fixtures only. They grant every user access with the host permission
// model so that a private-path check must fail: POSIX mode bits, or a Windows
// ACL entry for the Everyone identity that also reaches directory children.

export async function allowOtherReaders(path: string): Promise<void> {
  const directory = (await lstat(path)).isDirectory();
  if (process.platform === "win32") { grantEveryone(path, "R", directory); return; }
  await chmod(path, directory ? 0o755 : 0o644);
}

export async function allowOtherWriters(path: string): Promise<void> {
  const directory = (await lstat(path)).isDirectory();
  if (process.platform === "win32") { grantEveryone(path, "M", directory); return; }
  await chmod(path, 0o777);
}

export function allowOtherReadersSync(path: string): void {
  const directory = lstatSync(path).isDirectory();
  if (process.platform === "win32") { grantEveryone(path, "R", directory); return; }
  chmodSync(path, directory ? 0o755 : 0o644);
}

function grantEveryone(path: string, rights: "R" | "M", directory: boolean): void {
  const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
  const inheritance = directory ? "(OI)(CI)" : "";
  const result = spawnSync(icacls, [path, "/grant", `*S-1-1-0:${inheritance}${rights}`], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not grant Everyone ${rights} on ${path}: ${result.stderr}`);
  }
}
