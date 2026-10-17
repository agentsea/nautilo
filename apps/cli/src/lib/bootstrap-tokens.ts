import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDirectorySync, isPrivateFilesystemPath, publishPrivateFileAtomicallySync } from "@nautilo/config/private-filesystem";

function resolveHome(home?: string): string {
  return home ?? process.env["HOME"] ?? homedir();
}

function bootstrapTokensDir(home?: string): string {
  return join(resolveHome(home), ".nautilo", "bootstrap-tokens");
}

/** Resolve the per-profile bootstrap-token file path. */
export function bootstrapTokenPath(profileName: string, home?: string): string {
  return join(bootstrapTokensDir(home), profileName);
}

/** Read an owner-private token. Missing files and empty bodies return null. */
export function readBootstrapToken(profileName: string, opts?: { home?: string }): string | null {
  const path = bootstrapTokenPath(profileName, opts?.home);
  let entry: Stats;
  try { entry = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile() || !isPrivateFilesystemPath(path)
    || (process.platform !== "win32" && (Number(entry.mode) & 0o777) !== 0o600)) {
    throw new Error(`bootstrap token file ${path} must have owner-only permissions; refusing to read`);
  }
  return readFileSync(path, "utf8").trim() || null;
}

/** Atomically publish a private token without a trailing newline. */
export function writeBootstrapToken(profileName: string, value: string, opts?: { home?: string }): void {
  const path = bootstrapTokenPath(profileName, opts?.home);
  ensurePrivateDirectorySync(bootstrapTokensDir(opts?.home));
  publishPrivateFileAtomicallySync(path, Buffer.from(value, "utf8"));
}

/** Delete the token file. Missing file is a no-op. */
export function deleteBootstrapToken(profileName: string, opts?: { home?: string }): void {
  const path = bootstrapTokenPath(profileName, opts?.home);
  if (!existsSync(path)) return;
  unlinkSync(path);
}
