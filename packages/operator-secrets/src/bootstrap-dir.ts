import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Derive `~/.nautilo${suffix}/.bootstrap/` from an instance id ("" → default). */
export function bootstrapDirForInstance(
  instanceId: string,
  opts?: { home?: string },
): string {
  const home = opts?.home ?? homedir();
  const suffix = instanceId.trim() === "" ? "" : `-${instanceId.trim()}`;
  return join(home, `.nautilo${suffix}`, ".bootstrap");
}

export interface BootstrapDirSnapshot {
  adminPassword: string | null;
  adminPin: string | null;
  claimInvite: string | null;
  used: boolean;
  usedAt: Date | null;
}

const ADMIN_PASSWORD = "admin-password";
const ADMIN_PIN = "admin-pin";
const CLAIM_INVITE = "claim-invite";
const USED = ".used";

function readSingleLine(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function atomicWriteFile(path: string, body: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf-8", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  chmodSync(path, mode);
}

/** Read every file in `.bootstrap/`. Missing dir → all-null snapshot. */
export function readBootstrapDir(dir: string): BootstrapDirSnapshot {
  if (!existsSync(dir)) {
    return {
      adminPassword: null,
      adminPin: null,
      claimInvite: null,
      used: false,
      usedAt: null,
    };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    return {
      adminPassword: null,
      adminPin: null,
      claimInvite: null,
      used: false,
      usedAt: null,
    };
  }
  if (!st.isDirectory()) {
    return {
      adminPassword: null,
      adminPin: null,
      claimInvite: null,
      used: false,
      usedAt: null,
    };
  }
  const adminPassword = readSingleLine(join(dir, ADMIN_PASSWORD));
  const adminPin = readSingleLine(join(dir, ADMIN_PIN));
  const claimInvite = readSingleLine(join(dir, CLAIM_INVITE));
  const usedPath = join(dir, USED);
  let used = false;
  let usedAt: Date | null = null;
  if (existsSync(usedPath)) {
    try {
      const ust = statSync(usedPath);
      used = true;
      usedAt = ust.mtime;
    } catch {
      used = existsSync(usedPath);
    }
  }
  return { adminPassword, adminPin, claimInvite, used, usedAt };
}

export function writeBootstrapAdminPassword(dir: string, value: string): void {
  const v = value.trim();
  atomicWriteFile(join(dir, ADMIN_PASSWORD), v, 0o600);
}

export function writeBootstrapAdminPin(dir: string, value: string): void {
  const v = value.trim();
  atomicWriteFile(join(dir, ADMIN_PIN), v, 0o600);
}

export function writeBootstrapClaimInvite(dir: string, value: string): void {
  const v = value.trim();
  atomicWriteFile(join(dir, CLAIM_INVITE), v, 0o600);
}

/** Mark the bootstrap as consumed. Creates `.used` (mode 0600). Idempotent — preserves the FIRST stamp. */
export function markBootstrapUsed(dir: string, opts?: { now?: Date }): void {
  const usedPath = join(dir, USED);
  if (existsSync(usedPath)) return;
  const now = opts?.now ?? new Date();
  const iso = now.toISOString();
  atomicWriteFile(usedPath, iso, 0o600);
  try {
    utimesSync(usedPath, now, now);
  } catch {
    /* best-effort — mtime may still reflect write time */
  }
}

export function isBootstrapUsed(dir: string): boolean {
  return existsSync(join(dir, USED));
}

export function purgeBootstrapDir(dir: string): void {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

export const BOOTSTRAP_FILE_ALLOWLIST: readonly string[] = [
  ADMIN_PASSWORD,
  ADMIN_PIN,
  CLAIM_INVITE,
  USED,
];

/** Returns filenames present in `.bootstrap/` that are NOT in the allowlist. */
export function listUnknownBootstrapFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const allow = new Set<string>([...BOOTSTRAP_FILE_ALLOWLIST]);
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (allow.has(name)) continue;
    try {
      const p = join(dir, name);
      if (statSync(p).isFile()) out.push(name);
    } catch {
      /* skip */
    }
  }
  return out.sort();
}
