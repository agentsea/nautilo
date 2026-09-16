import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { KEY_REGISTRY } from "@nautilo/config-guard";

/** Keys in operator secrets files: `^[A-Z][A-Z0-9_]*$` (§13.2). */
export const OPERATOR_SECRET_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

const BOOTSTRAP_ADMIN_RE = /^NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_[A-Z0-9_]+$/;
const BOOTSTRAP_PIN_RE = /^NAUTILO_BOOTSTRAP_PIN_[A-Z0-9_]+$/;
const CLAIM_INVITE_RE = /^NAUTILO_CLAIM_INVITE_[A-Z0-9_]+$/;

const registryEnvVars = new Set(KEY_REGISTRY.map((k) => k.envVar));

function instanceIdToSecretSuffix(instanceId: string): string {
  return instanceId.trim().replace(/-/g, "_").toUpperCase();
}

export function bootstrapAdminPasswordKey(instanceId: string): string {
  return `NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_${instanceIdToSecretSuffix(instanceId)}`;
}

export function bootstrapPinKey(instanceId: string): string {
  return `NAUTILO_BOOTSTRAP_PIN_${instanceIdToSecretSuffix(instanceId)}`;
}

export function claimInviteKey(instanceId: string): string {
  return `NAUTILO_CLAIM_INVITE_${instanceIdToSecretSuffix(instanceId)}`;
}

function isRegistryEnvVar(key: string): boolean {
  return registryEnvVars.has(key);
}

function isKnownBootstrapOrClaimKey(key: string): boolean {
  return (
    BOOTSTRAP_ADMIN_RE.test(key) ||
    BOOTSTRAP_PIN_RE.test(key) ||
    CLAIM_INVITE_RE.test(key)
  );
}

export function isRecognizedOperatorSecretKey(key: string): boolean {
  return isRegistryEnvVar(key) || isKnownBootstrapOrClaimKey(key);
}

function formatMode(octal: number): string {
  return (octal & 0o777).toString(8).padStart(4, "0");
}

export function assertFileMode600(resolvedPath: string, label: string): void {
  if (process.platform === "win32") return;
  const st = statSync(resolvedPath);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${label} must be mode 0600 (current: ${formatMode(mode)}): ${resolvedPath}`,
    );
  }
}

/**
 * Refuse paths inside a git work tree (walk up from the secrets file directory).
 */
export function assertPathOutsideGitWorkTree(resolvedFilePath: string): void {
  let dir = dirname(resolve(resolvedFilePath));
  const root = resolve("/");
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      throw new Error(
        "operator secrets must not live inside a git repository (move the file outside the repo tree).",
      );
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
}

function assertSymlinkPolicyForOperatorSecrets(args: {
  path: string;
  resolvedRealPath: string;
  homeDir?: string | undefined;
}): void {
  if (process.platform === "win32") return;
  const homeResolved = resolve(args.homeDir ?? homedir());
  const targetResolved = resolve(args.resolvedRealPath);
  const sep = "/";
  const homeNorm = homeResolved;
  const targetNorm = targetResolved;
  if (
    targetNorm !== homeNorm &&
    !targetNorm.startsWith(homeNorm.endsWith(sep) ? homeNorm : `${homeNorm}${sep}`)
  ) {
    throw new Error(
      `operator secrets symlink target must be inside HOME (${homeResolved}); refusing: ${args.path} → ${args.resolvedRealPath}`,
    );
  }
}

export function prepareOperatorSecretsPath(path: string, homeDir?: string): {
  statPath: string;
  realPath: string;
} {
  const resolvedPath = resolve(path);
  let statPath = resolvedPath;
  let realPath = resolvedPath;
  try {
    const st = lstatSync(resolvedPath);
    if (st.isSymbolicLink()) {
      realPath = realpathSync(resolvedPath);
      assertSymlinkPolicyForOperatorSecrets({
        path: resolvedPath,
        resolvedRealPath: realPath,
        homeDir,
      });
      assertFileMode600(realPath, "secrets file symlink target");
      statPath = resolvedPath;
    } else {
      realPath = resolvedPath;
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { statPath: resolvedPath, realPath: resolvedPath };
    }
    throw e;
  }
  return { statPath, realPath };
}
