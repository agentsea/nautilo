import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IS_WIN = process.platform === "win32";

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

/** Read the token file. Missing file or empty body → `null`. Refuses files not at mode 0600 on non-Windows. */
export function readBootstrapToken(profileName: string, opts?: { home?: string }): string | null {
  const path = bootstrapTokenPath(profileName, opts?.home);
  if (!existsSync(path)) return null;
  const body = readFileSync(path, "utf8").trim();
  if (body === "") return null;
  if (!IS_WIN) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `bootstrap token file ${path} must be chmod 600 (found 0${mode.toString(8)}); refusing to read`,
      );
    }
  }
  return body;
}

/** Write the token. Creates parent dir at 0700. File at 0600. Single-line, no trailing newline. Atomic (write to .tmp, rename). Idempotent (same content → still rewrite + chmod). */
export function writeBootstrapToken(profileName: string, value: string, opts?: { home?: string }): void {
  const path = bootstrapTokenPath(profileName, opts?.home);
  const dir = bootstrapTokensDir(opts?.home);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Delete the token file. Missing file is a no-op. */
export function deleteBootstrapToken(profileName: string, opts?: { home?: string }): void {
  const path = bootstrapTokenPath(profileName, opts?.home);
  if (!existsSync(path)) return;
  unlinkSync(path);
}
