/**
 * Canonical protected-path policy descriptors — D418 task 2.2.3 foundation.
 *
 * This module is a **pure Node-only** policy factory + matcher. Given a
 * home directory and a platform it produces a deterministic, canonical set
 * of protected-path descriptors covering system-auth roots and the common
 * user secret stores relevant to workstation access (SSH/GPG/cloud creds,
 * browser/password stores, macOS Keychains) plus caller-supplied Nautilo
 * private/data/audit roots.
 *
 * What it is NOT, deliberately (foundation slice):
 *   - It does not touch the filesystem, resolve symlinks, read TCC/Keychain
 *     state, or consult Electron. Canonicalization is lexical only, so the
 *     same `(homeDir, platform, roots)` always yields the same descriptors
 *     on any host. Relay/sandbox adapters are expected to realpath-resolve
 *     a candidate before handing it to the matcher.
 *   - It does not wire into `path-deny.ts`, execution paths, sandbox
 *     profiles, or audits. Those stay untouched in this slice; this module
 *     only exports the descriptor/matcher contracts they will adopt later.
 *
 * The matcher is **operation-agnostic**: it expresses "this path subtree is
 * denied" without reference to read/write/execute. Operation gating
 * (which ops a deny applies to) is a caller concern layered on top.
 *
 * Safety properties enforced here:
 *   - Separator-safe prefix matching (`/etc` does not match `/etcfoo`).
 *   - Ancestor detection so a recursive `/` or a home *parent* (`/Users`,
 *     `/home`) cannot bypass the home-relative deny set (FILE-02 / G7).
 *   - Fail-closed on control-byte candidates: a path containing C0/DEL/C1
 *     control bytes is denied outright because it cannot be canonicalized
 *     safely.
 */

import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const PROTECTED_PATH_POLICY_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Control-byte guard (shared with desktop-filesystem-grants semantics)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- intentional: rejecting control-byte paths
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What kind of protected subtree a descriptor names. Used by adapters for
 * audit logging and policy-pack overrides; the matcher itself is agnostic
 * to category.
 */
export type ProtectedPathCategory =
  | "system_auth"
  | "system_network"
  | "system_virtual"
  | "system_boot"
  | "ssh"
  | "gpg"
  | "cloud"
  | "container"
  | "package_manager_secret"
  | "env_secret"
  | "password_store"
  | "keyring"
  | "browser_store"
  | "macos_keychain"
  | "macos_system"
  | "nautilo_private"
  | "nautilo_data"
  | "nautilo_audit"
  | "caller_root";

/**
 * Where a descriptor came from. `builtin_*` entries are produced from the
 * `(home, platform)` tuple; `caller_supplied` entries come from the
 * Nautilo roots / extra roots passed into the builder.
 */
export type ProtectedPathOrigin =
  | "builtin_system"
  | "builtin_home"
  | "builtin_darwin"
  | "builtin_win32"
  | "caller_supplied";

/**
 * A single canonical, portable protected-path subtree. `canonicalPath` is
 * the platform-normalized absolute path of the subtree root; the matcher
 * treats the path itself, its descendants, and its ancestors as denied.
 */
export interface ProtectedPathDescriptor {
  readonly canonicalPath: string;
  readonly category: ProtectedPathCategory;
  readonly origin: ProtectedPathOrigin;
  readonly label: string;
}

/**
 * How a candidate related to the matched descriptor. `control_byte` is a
 * fail-closed outcome with no descriptor (the candidate could not be safely
 * canonicalized).
 */
export type ProtectedPathMatchKind =
  | "equality"
  | "descendant"
  | "ancestor"
  | "control_byte";

export type ProtectedPathCheckResult = {
  readonly allowed: true;
  readonly candidateCanonical: string;
} | {
  readonly allowed: false;
  readonly candidateCanonical: string;
  readonly kind: ProtectedPathMatchKind;
  readonly reason: string;
  readonly descriptor?: ProtectedPathDescriptor;
};

export interface ProtectedPathMatchOptions {
  readonly platform: NodeJS.Platform;
  readonly homeCanonical: string;
}

export interface ProtectedPathCallerRootInput {
  /** Absolute path for the host platform. Relative roots are rejected. */
  readonly canonicalPath: string;
  readonly category: ProtectedPathCategory;
  readonly label: string;
}

export interface ProtectedPathNautiloRootsInput {
  readonly privateRoot?: string;
  readonly dataRoot?: string;
  readonly auditRoot?: string;
}

export interface ProtectedPathPolicyInput {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly nautiloRoots?: ProtectedPathNautiloRootsInput;
  /** Additional caller-supplied deny roots (e.g. operator policy packs). */
  readonly extraRoots?: readonly ProtectedPathCallerRootInput[];
}

export interface ProtectedPathPolicy {
  readonly schemaVersion: typeof PROTECTED_PATH_POLICY_SCHEMA_VERSION;
  readonly platform: NodeJS.Platform;
  readonly homeCanonical: string;
  readonly descriptors: readonly ProtectedPathDescriptor[];
  /** Operation-agnostic deny check for a candidate path. */
  readonly check: (candidate: string) => ProtectedPathCheckResult;
}

export type ProtectedPathPolicyErrorCode =
  | "invalid_home"
  | "invalid_caller_root"
  | "unknown_platform";

export class ProtectedPathPolicyError extends Error {
  readonly code: ProtectedPathPolicyErrorCode;
  constructor(code: ProtectedPathPolicyErrorCode, message: string) {
    super(message);
    this.name = "ProtectedPathPolicyError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Platform-aware path selection
// ---------------------------------------------------------------------------

function platformPath(platform: NodeJS.Platform): nodePath.PlatformPath {
  switch (platform) {
    case "win32":
      return nodePath.win32;
    case "darwin":
    case "linux":
    case "freebsd":
    case "openbsd":
    case "aix":
    case "sunos":
    case "android":
    case "cygwin":
    case "netbsd":
    case "haiku":
      return nodePath.posix;
    default:
      throw new ProtectedPathPolicyError(
        "unknown_platform",
        `unsupported platform: ${String(platform)}`,
      );
  }
}

function isPosix(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

function isLinuxLike(platform: NodeJS.Platform): boolean {
  return platform !== "win32" && platform !== "darwin";
}

// ---------------------------------------------------------------------------
// Builtin descriptor tables
// ---------------------------------------------------------------------------

type BuiltinEntry = {
  readonly rel: string;
  readonly category: ProtectedPathCategory;
  readonly label: string;
};

/**
 * Absolute system-auth / system roots. POSIX-only: on Windows these paths
 * do not exist and the win32 system root set below is used instead.
 */
const POSIX_SYSTEM_ROOTS: readonly BuiltinEntry[] = [
  { rel: "/etc/passwd", category: "system_auth", label: "POSIX account database" },
  { rel: "/etc/shadow", category: "system_auth", label: "POSIX shadow password file" },
  { rel: "/etc/sudoers", category: "system_auth", label: "sudo policy" },
  { rel: "/etc/pam.d", category: "system_auth", label: "PAM policy" },
  { rel: "/etc/security", category: "system_auth", label: "POSIX security policy" },
  { rel: "/etc/hosts", category: "system_network", label: "host resolution table" },
  { rel: "/etc/ssh", category: "system_auth", label: "system SSH config + host keys" },
  { rel: "/etc/ssl", category: "system_network", label: "system TLS trust + private keys" },
  { rel: "/boot", category: "system_boot", label: "boot loader + kernels" },
  { rel: "/proc", category: "system_virtual", label: "procfs kernel interface" },
  { rel: "/sys", category: "system_virtual", label: "sysfs kernel interface" },
  { rel: "/dev", category: "system_virtual", label: "device namespace" },
];

/**
 * Minimal Windows system root set. Scoped to the conventional system drive
 * (`C:`); operators with non-standard system drives should supply an
 * extraRoot. Foundation coverage — extend in a later slice if needed.
 */
const WIN32_SYSTEM_ROOTS: readonly BuiltinEntry[] = [
  { rel: "C:\\Windows\\System32\\config", category: "system_auth", label: "Windows registry hives (SAM/SYSTEM/SECURITY)" },
  { rel: "C:\\Windows\\System32\\GroupPolicy", category: "system_auth", label: "Windows group policy" },
  { rel: "C:\\Windows\\System32\\drivers\\etc", category: "system_network", label: "Windows hosts + network config" },
];

/**
 * Home-relative secret stores that exist on every supported platform
 * (including Windows, where they live under %USERPROFILE%). All
 * single-segment, so no separator concerns across platforms.
 */
const COMMON_HOME_ROOTS: readonly BuiltinEntry[] = [
  { rel: ".ssh", category: "ssh", label: "SSH keys + known_hosts" },
  { rel: ".gnupg", category: "gpg", label: "GPG keyring + private keys" },
  { rel: ".aws", category: "cloud", label: "AWS credentials" },
  { rel: ".azure", category: "cloud", label: "Azure CLI credentials" },
  { rel: ".kube", category: "container", label: "Kubernetes config + tokens" },
  { rel: ".docker", category: "container", label: "Docker config + registry creds" },
  { rel: ".netrc", category: "package_manager_secret", label: "HTTP credentials" },
  { rel: ".npmrc", category: "package_manager_secret", label: "npm config + token" },
  { rel: ".pypirc", category: "package_manager_secret", label: "PyPI credentials" },
  { rel: ".env", category: "env_secret", label: "dotenv secrets" },
  { rel: ".env.local", category: "env_secret", label: "dotenv local secrets" },
  { rel: ".env.production", category: "env_secret", label: "dotenv production secrets" },
  { rel: ".password-store", category: "password_store", label: "pass password store" },
];

/**
 * Home-relative roots that only make sense on non-darwin POSIX (Linux,
 * FreeBSD, …). Uses XDG-style paths; macOS equivalents live in the darwin
 * table.
 */
const LINUX_HOME_ROOTS: readonly BuiltinEntry[] = [
  { rel: ".config/gcloud", category: "cloud", label: "gcloud credentials" },
  { rel: ".mozilla/firefox", category: "browser_store", label: "Firefox profile (Linux)" },
  { rel: ".config/google-chrome", category: "browser_store", label: "Chrome profile (Linux)" },
  { rel: ".config/chromium", category: "browser_store", label: "Chromium profile (Linux)" },
  { rel: ".config/BraveSoftware", category: "browser_store", label: "Brave profile (Linux)" },
  { rel: ".local/share/keyrings", category: "keyring", label: "GNOME/Secret Service keyrings" },
];

/**
 * macOS-only home-relative roots. The `Library/Keychains` subtree covers
 * the user login keychain; per-browser app-support dirs hold their
 * encrypted credential stores.
 */
const DARWIN_HOME_ROOTS: readonly BuiltinEntry[] = [
  { rel: ".config/gcloud", category: "cloud", label: "gcloud credentials" },
  { rel: "Library/Keychains", category: "macos_keychain", label: "macOS user keychains" },
  { rel: "Library/Application Support/Google/Chrome", category: "browser_store", label: "Chrome profile (macOS)" },
  { rel: "Library/Application Support/Chromium", category: "browser_store", label: "Chromium profile (macOS)" },
  { rel: "Library/Application Support/BraveSoftware", category: "browser_store", label: "Brave profile (macOS)" },
  { rel: "Library/Application Support/Arc", category: "browser_store", label: "Arc profile (macOS)" },
  { rel: "Library/Application Support/Firefox", category: "browser_store", label: "Firefox profile (macOS)" },
  { rel: "Library/Cookies", category: "macos_system", label: "macOS per-user cookie stores" },
  { rel: "Library/Safari", category: "browser_store", label: "Safari data (macOS)" },
];

/**
 * Windows-only home-relative roots. Windows browser data and credential
 * vaults live under %APPDATA% / %LOCALAPPDATA%; expressed here relative to
 * the supplied home (`%USERPROFILE%`).
 */
const WIN32_HOME_ROOTS: readonly BuiltinEntry[] = [
  { rel: "AppData\\Roaming\\gcloud", category: "cloud", label: "gcloud credentials (Windows)" },
  { rel: "AppData\\Roaming\\Microsoft\\Credentials", category: "password_store", label: "Windows Credential Manager (roaming)" },
  { rel: "AppData\\Local\\Microsoft\\Credentials", category: "password_store", label: "Windows Credential Manager (local)" },
  { rel: "AppData\\Roaming\\Microsoft\\Protect", category: "password_store", label: "Windows DPAPI master keys" },
  { rel: "AppData\\Local\\Google\\Chrome\\User Data", category: "browser_store", label: "Chrome profile (Windows)" },
  { rel: "AppData\\Local\\Microsoft\\Edge\\User Data", category: "browser_store", label: "Edge profile (Windows)" },
  { rel: "AppData\\Roaming\\Mozilla\\Firefox", category: "browser_store", label: "Firefox profile (Windows)" },
];

// ---------------------------------------------------------------------------
// Canonicalization helpers
// ---------------------------------------------------------------------------

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeHome(homeDir: string, p: nodePath.PlatformPath): string {
  if (!isNonBlankString(homeDir)) {
    throw new ProtectedPathPolicyError("invalid_home", "homeDir must be a non-blank string");
  }
  if (CONTROL_CHARACTER.test(homeDir)) {
    throw new ProtectedPathPolicyError("invalid_home", "homeDir must not contain control characters");
  }
  if (!p.isAbsolute(homeDir)) {
    throw new ProtectedPathPolicyError("invalid_home", "homeDir must be an absolute path for the platform");
  }
  return p.normalize(homeDir);
}

function normalizeCallerRoot(
  raw: string,
  p: nodePath.PlatformPath,
  category: ProtectedPathCategory,
  label: string,
  homeCanonical: string,
): ProtectedPathDescriptor {
  if (!isNonBlankString(raw)) {
    throw new ProtectedPathPolicyError("invalid_caller_root", "caller root must be a non-blank string");
  }
  if (CONTROL_CHARACTER.test(raw)) {
    throw new ProtectedPathPolicyError("invalid_caller_root", "caller root must not contain control characters");
  }
  if (!p.isAbsolute(raw)) {
    throw new ProtectedPathPolicyError("invalid_caller_root", "caller root must be an absolute path for the platform");
  }
  return {
    canonicalPath: p.resolve(homeCanonical, p.normalize(raw)),
    category,
    origin: "caller_supplied",
    label,
  };
}

/**
 * Canonicalize a candidate path for matching. `~` (and `~/...`) expands
 * against the policy home; other relative paths resolve against home so the
 * matcher stays deterministic without touching `process.cwd()`.
 */
function canonicalizeCandidate(
  candidate: string,
  homeCanonical: string,
  p: nodePath.PlatformPath,
): string {
  let s = candidate;
  if (s === "~") {
    s = homeCanonical;
  } else if (s.startsWith(`~${p.sep}`)) {
    s = p.join(homeCanonical, s.slice(2));
  }
  if (!p.isAbsolute(s)) {
    s = p.resolve(homeCanonical, s);
  }
  return p.normalize(s);
}

/**
 * Prefix used for subtree-containment tests. Separator-safe: appends the
 * platform separator so `/etc` does not match `/etcfoo`. Filesystem roots
 * (`/` on POSIX, `C:\\` on Windows) are returned as-is so that every
 * absolute path is correctly treated as a descendant/ancestor of the root.
 */
function subtreePrefix(p: nodePath.PlatformPath, absolutePath: string): string {
  if (p.parse(absolutePath).root === absolutePath) {
    return absolutePath;
  }
  return absolutePath.endsWith(p.sep) ? absolutePath : `${absolutePath}${p.sep}`;
}

// ---------------------------------------------------------------------------
// Descriptor builder
// ---------------------------------------------------------------------------

function pushBuiltin(
  out: ProtectedPathDescriptor[],
  p: nodePath.PlatformPath,
  homeCanonical: string,
  entries: readonly BuiltinEntry[],
  origin: ProtectedPathOrigin,
  useHome: boolean,
): void {
  for (const entry of entries) {
    const canonicalPath = useHome
      ? p.normalize(p.join(homeCanonical, entry.rel))
      : p.normalize(entry.rel);
    out.push({
      canonicalPath,
      category: entry.category,
      origin,
      label: entry.label,
    });
  }
}

function dedupeByPath(descriptors: ProtectedPathDescriptor[]): ProtectedPathDescriptor[] {
  const seen = new Set<string>();
  const out: ProtectedPathDescriptor[] = [];
  for (const d of descriptors) {
    if (seen.has(d.canonicalPath)) continue;
    seen.add(d.canonicalPath);
    out.push(d);
  }
  return out;
}

/**
 * Build the canonical protected-path descriptor set for a given
 * `(homeDir, platform)` plus caller-supplied roots. Deterministic and
 * filesystem-independent: identical inputs yield identical descriptors on
 * any host, so the output is snapshot-testable and serializable to a
 * relay/sandbox adapter.
 */
export function buildProtectedPathDescriptors(
  input: ProtectedPathPolicyInput,
): readonly ProtectedPathDescriptor[] {
  const p = platformPath(input.platform);
  const homeCanonical = normalizeHome(input.homeDir, p);

  const out: ProtectedPathDescriptor[] = [];

  if (isPosix(input.platform)) {
    pushBuiltin(out, p, homeCanonical, POSIX_SYSTEM_ROOTS, "builtin_system", false);
  } else {
    pushBuiltin(out, p, homeCanonical, WIN32_SYSTEM_ROOTS, "builtin_system", false);
  }

  pushBuiltin(out, p, homeCanonical, COMMON_HOME_ROOTS, "builtin_home", true);

  if (isLinuxLike(input.platform)) {
    pushBuiltin(out, p, homeCanonical, LINUX_HOME_ROOTS, "builtin_home", true);
  } else if (input.platform === "darwin") {
    pushBuiltin(out, p, homeCanonical, DARWIN_HOME_ROOTS, "builtin_darwin", true);
  } else if (input.platform === "win32") {
    pushBuiltin(out, p, homeCanonical, WIN32_HOME_ROOTS, "builtin_win32", true);
  }

  const nautilo = input.nautiloRoots;
  if (nautilo) {
    if (nautilo.privateRoot !== undefined) {
      out.push(normalizeCallerRoot(nautilo.privateRoot, p, "nautilo_private", "Nautilo private root", homeCanonical));
    }
    if (nautilo.dataRoot !== undefined) {
      out.push(normalizeCallerRoot(nautilo.dataRoot, p, "nautilo_data", "Nautilo data root", homeCanonical));
    }
    if (nautilo.auditRoot !== undefined) {
      out.push(normalizeCallerRoot(nautilo.auditRoot, p, "nautilo_audit", "Nautilo audit root", homeCanonical));
    }
  }

  if (input.extraRoots) {
    for (const root of input.extraRoots) {
      out.push(
        normalizeCallerRoot(
          root.canonicalPath,
          p,
          root.category,
          root.label,
          homeCanonical,
        ),
      );
    }
  }

  return dedupeByPath(out);
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/**
 * Operation-agnostic deny matcher. Given a descriptor set and a candidate
 * path, returns whether the candidate is denied (and why). Denies on:
 *   - equality with a protected path,
 *   - being a descendant of a protected path,
 *   - being an ancestor of a protected path (recursive-walk exfil guard),
 *   - containing control bytes (fail closed).
 */
export function matchProtectedPath(
  descriptors: readonly ProtectedPathDescriptor[],
  candidate: string,
  options: ProtectedPathMatchOptions,
): ProtectedPathCheckResult {
  const p = platformPath(options.platform);
  const homeCanonical = options.homeCanonical;

  if (CONTROL_CHARACTER.test(candidate)) {
    return {
      allowed: false,
      candidateCanonical: candidate,
      kind: "control_byte",
      reason: "candidate path contains control characters; denied fail-closed",
    };
  }

  const candidateCanonical = canonicalizeCandidate(candidate, homeCanonical, p);

  for (const descriptor of descriptors) {
    const descriptorPath = descriptor.canonicalPath;
    if (candidateCanonical === descriptorPath) {
      return {
        allowed: false,
        candidateCanonical,
        kind: "equality",
        reason: `candidate is a protected path (${descriptor.label})`,
        descriptor,
      };
    }
    if (candidateCanonical.startsWith(subtreePrefix(p, descriptorPath))) {
      return {
        allowed: false,
        candidateCanonical,
        kind: "descendant",
        reason: `candidate is inside a protected path (${descriptor.label})`,
        descriptor,
      };
    }
    if (descriptorPath.startsWith(subtreePrefix(p, candidateCanonical))) {
      return {
        allowed: false,
        candidateCanonical,
        kind: "ancestor",
        reason: `candidate is an ancestor of a protected path (${descriptor.label})`,
        descriptor,
      };
    }
  }

  return { allowed: true, candidateCanonical };
}

/**
 * Boolean convenience for adapters that only need the allow/deny bit.
 */
export function isPathProtected(
  descriptors: readonly ProtectedPathDescriptor[],
  candidate: string,
  options: ProtectedPathMatchOptions,
): boolean {
  return !matchProtectedPath(descriptors, candidate, options).allowed;
}

// ---------------------------------------------------------------------------
// Policy convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Build a `ProtectedPathPolicy` bundling the canonical descriptors with a
 * `check(candidate)` matcher closed over the platform + home. The policy
 * object is the unit a relay/sandbox adapter serializes or holds.
 */
export function buildProtectedPathPolicy(input: ProtectedPathPolicyInput): ProtectedPathPolicy {
  const descriptors = buildProtectedPathDescriptors(input);
  const p = platformPath(input.platform);
  const homeCanonical = normalizeHome(input.homeDir, p);
  return {
    schemaVersion: PROTECTED_PATH_POLICY_SCHEMA_VERSION,
    platform: input.platform,
    homeCanonical,
    descriptors,
    check: (candidate: string): ProtectedPathCheckResult =>
      matchProtectedPath(descriptors, candidate, {
        platform: input.platform,
        homeCanonical,
      }),
  };
}
