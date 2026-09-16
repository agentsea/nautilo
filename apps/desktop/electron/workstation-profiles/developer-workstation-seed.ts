/**
 * D418 — shipped Developer Workstation seed profile.
 *
 * A Workstation Profile is durable admin configuration, never authority by
 * itself. Full Workstation Mode binds one exact revision and compiles it
 * against separately discovered concrete facts (`DiscoveredWorkstationFacts`)
 * into explicit `policy_pack` / `session` grants. This module ships the
 * **Developer Workstation** seed so a user never hand-authors profile JSON:
 * first run presents this profile with a readable discovery review and an
 * "Enable with my PIN" action.
 *
 * This is a profile TEMPLATE only — it does not discover anything, does not
 * mutate a profile store, does not activate, and does not create grants.
 * Discovery adapters (`./discovery.ts`) emit canonical facts later; the
 * compiler (`./compiler.ts`) intersects those facts with this profile's
 * authorized roots / env keys / capabilities. Every discovered root, env key,
 * and capability operation not already authorized here is rejected by the
 * compiler — discovery never creates authority.
 *
 * Seed posture (per ISSUE-D418 / spec R14):
 *   - **Host networking** so Metro/Expo, dev servers, emulators, package
 *     registries, and local service ports work without repeated prompts. The
 *     discovery review surfaces the exfiltration implication of host network.
 *   - **Explicit toolchain capability ids + backends.** Each discovered
 *     toolchain declares a stable capability id and an explicit backend
 *     (`sandboxed` for package managers / build tools; `brokered_host_service`
 *     for device-control surfaces — ADB/emulator, iOS Simulator, Maestro).
 *     No escape capability (Docker socket, raw host control) is representable
 *     here; those require the separate Real Workstation tier.
 *   - **Bounded environment key allowlist.** Only the named developer keys
 *     (`JAVA_HOME`, `ANDROID_HOME`, `DEVELOPER_DIR`, `GRADLE_USER_HOME`, …)
 *     are permitted. Arbitrary raw `process.env` is never authorized.
 *   - **Safe root templates.** Roots are host-canonical, absolute, traversal-
 *     free developer prefixes and caches derived from the operator home and
 *     platform. The literal filesystem root (`/`) and the exact user home are
 *     never used as roots. The Current Folder / monorepo root is NOT baked in
 *     — it is discovered and compiled separately, or added as an admin profile
 *     delta, so this template never claims authority over an unknown project.
 *
 * The profile is materialized per host (home + platform) by
 * {@link createDeveloperWorkstationSeedProfile} and strict-validated by
 * `parseWorkstationProfile` before it is handed to a store. It is Electron-
 * free and side-effect-free: no disk, process, or env access.
 */

import { homedir } from "node:os";
import * as nodePath from "node:path";

import {
  parseWorkstationProfile,
  type ProfileCapabilityBackend,
  type ProfileDiscoveryOrigin,
  type ProfileRootRule,
  type ProfileToolchainCapability,
  type ProfileToolchainCapabilityKind,
  type WorkstationProfile,
  type WorkstationProfileValidationResult,
} from "@nautilo/workstation-profiles";

/** Stable id of the shipped Developer Workstation seed profile. */
export const DEVELOPER_WORKSTATION_SEED_PROFILE_ID = "developer-workstation";

/** Human-readable name shown in the profile review / settings surface. */
export const DEVELOPER_WORKSTATION_SEED_PROFILE_NAME = "Developer Workstation";

/** First shipped revision of the seed profile. */
export const DEVELOPER_WORKSTATION_SEED_PROFILE_REVISION = 1 as const;

/**
 * `protectedPolicyVersion` stamped on the seed. Bumped when the shipped seed's
 * protected-path / hard-deny posture changes so an active session can detect a
 * stale binding. Independent of the per-profile `revision`.
 */
export const DEVELOPER_WORKSTATION_SEED_PROTECTED_POLICY_VERSION = 1 as const;

// ── Toolchain capability ids ───────────────────────────────────────────────
//
// Stable ids shared with `./discovery.ts`. A discovered capability with one of
// these ids compiles only if its backend, operations, env keys, and roots are
// already authorized below. Discovery emits a capability for an installed tool
// only; a missing tool yields an optional/missing review row, never an error.

export const CAP_BUN = "cap-bun";
export const CAP_NPM = "cap-npm";
export const CAP_HOMEBREW = "cap-homebrew";
export const CAP_JDK = "cap-jdk";
export const CAP_GRADLE = "cap-gradle";
export const CAP_EXPO_METRO = "cap-expo-metro";
export const CAP_ANDROID_SDK = "cap-android-sdk";
export const CAP_XCODE = "cap-xcode";
export const CAP_MASTRO = "cap-maestro";

/**
 * Bounded environment key allowlist for the Developer Workstation seed.
 * Discovery may only emit keys in this list; the compiler rejects any other
 * key. `PATH` and arbitrary `process.env` are deliberately absent — host PATH
 * resolution is a runtime concern, not a profile-authorized env key.
 */
export const DEVELOPER_WORKSTATION_ENV_ALLOWLIST = [
  "BUN_INSTALL",
  "NPM_CONFIG_CACHE",
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "DEVELOPER_DIR",
] as const;

/**
 * Declarative toolchain capability specs shared with discovery: id, kind,
 * origin, backend, typed operations, and bounded env keys. Roots and the
 * declarative `executable` are host-dependent and live in the materialized
 * profile only; discovery supplies the real executable and existing readable
 * roots at activation time.
 */
export interface DeveloperWorkstationSeedCapabilityDeclaration {
  readonly id: string;
  readonly kind: ProfileToolchainCapabilityKind;
  readonly discoveredFrom: ProfileDiscoveryOrigin;
  readonly backend: ProfileCapabilityBackend;
  readonly operations: readonly string[];
  readonly environmentKeys: readonly string[];
}

/**
 * Ordered declarations for every toolchain capability the seed authorizes.
 * Discovery imports this so its emitted capabilities match the seed's id /
 * backend / operations / env-key contracts exactly — no drift.
 */
export const DEVELOPER_WORKSTATION_SEED_CAPABILITY_DECLARATIONS: readonly DeveloperWorkstationSeedCapabilityDeclaration[] =
  [
    {
      id: CAP_BUN,
      kind: "toolchain",
      discoveredFrom: "fixed_argv",
      backend: "sandboxed",
      operations: ["run", "install", "test"],
      environmentKeys: ["BUN_INSTALL"],
    },
    {
      id: CAP_NPM,
      kind: "toolchain",
      discoveredFrom: "fixed_argv",
      backend: "sandboxed",
      operations: ["run", "install", "test"],
      environmentKeys: ["NPM_CONFIG_CACHE"],
    },
    {
      id: CAP_HOMEBREW,
      kind: "toolchain",
      discoveredFrom: "well_known_path",
      backend: "sandboxed",
      operations: ["install", "upgrade", "list"],
      environmentKeys: [],
    },
    {
      id: CAP_JDK,
      kind: "toolchain",
      discoveredFrom: "fixed_argv",
      backend: "sandboxed",
      operations: ["compile", "run"],
      environmentKeys: ["JAVA_HOME"],
    },
    {
      id: CAP_GRADLE,
      kind: "toolchain",
      discoveredFrom: "existing_config",
      backend: "sandboxed",
      operations: ["build", "test"],
      environmentKeys: ["GRADLE_USER_HOME"],
    },
    {
      id: CAP_EXPO_METRO,
      kind: "toolchain",
      discoveredFrom: "existing_config",
      backend: "sandboxed",
      operations: ["start", "build"],
      environmentKeys: [],
    },
    {
      id: CAP_ANDROID_SDK,
      kind: "toolchain",
      discoveredFrom: "well_known_path",
      // ADB / emulator / AVD state are device-control surfaces: contained via
      // a typed profile-bound host-service broker, never unsandboxed.
      backend: "brokered_host_service",
      operations: ["adb", "emulator", "build"],
      environmentKeys: ["ANDROID_HOME", "ANDROID_SDK_ROOT"],
    },
    {
      id: CAP_XCODE,
      kind: "toolchain",
      discoveredFrom: "well_known_path",
      // iOS Simulator / DerivedData / CoreSimulator are device-control surfaces
      // contained via a typed profile-bound host-service broker.
      backend: "brokered_host_service",
      operations: ["build", "test", "simulate"],
      environmentKeys: ["DEVELOPER_DIR"],
    },
    {
      id: CAP_MASTRO,
      kind: "toolchain",
      discoveredFrom: "well_known_path",
      // Maestro drives UIs and runs as an MCP host — a brokered, revocable
      // device-control surface, not an unsandboxed shell.
      backend: "brokered_host_service",
      operations: ["test", "drive"],
      environmentKeys: [],
    },
  ];

/**
 * Discovery providers the seed opts into. JDK is discovered via a fixed-argv
 * `java_home` probe (an origin, not a provider) and so has no entry here; its
 * capability declares `discoveredFrom: "fixed_argv"` directly.
 */
const DEVELOPER_WORKSTATION_SEED_DISCOVERY_PROVIDERS = [
  "bun",
  "npm",
  "homebrew",
  "gradle",
  "expo_metro",
  "android_sdk",
  "xcode",
  "maestro",
] as const;

/**
 * Broad boolean capability flags the Developer Workstation seed turns on.
 * `device_control` covers the brokered ADB / simulator / Maestro surfaces;
 * escape capabilities (Docker socket, raw host control) are deliberately
 * absent and require the separate Real Workstation tier.
 */
export const DEVELOPER_WORKSTATION_SEED_CAPABILITIES = [
  "background_processes",
  "mcp_hosts",
  "device_control",
] as const;

/** Options for materializing the seed profile against a specific host. */
export interface CreateDeveloperWorkstationSeedProfileOptions {
  /**
   * Operator home directory. Roots are derived from it so the seed is a true
   * template, not a hardcoded path list. Defaults to `os.homedir()` at call
   * time; tests inject a fixed value.
   */
  readonly home?: string;
  /**
   * `process.platform` value. macOS-only capabilities (Xcode / CoreSimulator,
   * `java_home`, Homebrew prefixes) are included on `darwin`; other platforms
   * get the cross-platform toolchains plus their platform-specific prefixes.
   */
  readonly platform?: string;
  /** Inject a clock for deterministic `createdAt` / `updatedAt`. */
  readonly now?: Date;
  /** Override the profile id (e.g. when duplicating the seed). */
  readonly id?: string;
  /** Override the profile revision (e.g. when applying an admin delta). */
  readonly revision?: number;
}

function rootRule(
  path: string,
  access: readonly ("read" | "create_modify" | "delete" | "execute")[],
): ProfileRootRule {
  return { path, access };
}

const READ_WRITE: readonly ("read" | "create_modify" | "delete" | "execute")[] = [
  "read",
  "create_modify",
  "delete",
  "execute",
];
const READ_WRITE_NO_DELETE: readonly ("read" | "create_modify" | "delete" | "execute")[] = [
  "read",
  "create_modify",
];
const READ_ONLY: readonly ("read" | "create_modify" | "delete" | "execute")[] = ["read"];
const READ_EXECUTE: readonly ("read" | "create_modify" | "delete" | "execute")[] = [
  "read",
  "execute",
];

interface HostPaths {
  readonly home: string;
  readonly platform: string;
  readonly isDarwin: boolean;
  readonly homebrewPrefixes: readonly string[];
  readonly homebrewCache: string;
  readonly homebrewExtra: readonly string[];
  readonly androidSdk: string;
  readonly androidAvd: string;
  readonly jdkParent: string;
  readonly jdkExecutable: string;
  readonly homebrewExecutable: string;
  readonly xcodeExecutable: string;
  readonly androidAdb: string;
}

function resolveHostPaths(home: string, platform: string): HostPaths {
  const isDarwin = platform === "darwin";
  if (isDarwin) {
    return {
      home,
      platform,
      isDarwin,
      // Both Apple Silicon (`/opt/homebrew`) and Intel (`/usr/local`) prefixes
      // are safe developer roots; only the one that exists is discovered.
      homebrewPrefixes: ["/opt/homebrew", "/usr/local"],
      homebrewCache: nodePath.join(home, "Library", "Caches", "Homebrew"),
      homebrewExtra: [nodePath.join(home, "Library", "Homebrew")],
      androidSdk: nodePath.join(home, "Library", "Android", "sdk"),
      androidAvd: nodePath.join(home, ".android"),
      jdkParent: "/Library/Java/JavaVirtualMachines",
      jdkExecutable: "/usr/libexec/java_home",
      homebrewExecutable: "/opt/homebrew/bin/brew",
      xcodeExecutable: "/usr/bin/xcodebuild",
      androidAdb: nodePath.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    };
  }
  return {
    home,
    platform,
    isDarwin,
    homebrewPrefixes: ["/home/linuxbrew/.linuxbrew"],
    homebrewCache: nodePath.join(home, ".cache", "Homebrew"),
    homebrewExtra: [],
    androidSdk: nodePath.join(home, "Android", "Sdk"),
    androidAvd: nodePath.join(home, ".android"),
    jdkParent: "/usr/lib/jvm",
    jdkExecutable: "java",
    homebrewExecutable: "/home/linuxbrew/.linuxbrew/bin/brew",
    xcodeExecutable: "",
    androidAdb: nodePath.join(home, "Android", "Sdk", "platform-tools", "adb"),
  };
}

/**
 * Build the JSON-safe seed profile record for a specific host. Exported for
 * tests that want to inspect the raw record before parsing.
 */
export function buildDeveloperWorkstationSeedRecord(
  options: CreateDeveloperWorkstationSeedProfileOptions = {},
): Record<string, unknown> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? "darwin";
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const paths = resolveHostPaths(home, platform);

  // ── Top-level roots: broad shared developer prefixes / caches ──────────
  // These are the genuinely shared developer roots (Homebrew prefix + cache).
  // Per-toolchain home dirs (`.bun`, `.gradle`, …) live under their capability
  // roots. The Current Folder / monorepo is intentionally NOT here — it is
  // discovered and compiled separately or added as an admin delta.
  const roots: ProfileRootRule[] = [];
  for (const prefix of paths.homebrewPrefixes) {
    roots.push(rootRule(prefix, READ_WRITE));
  }
  roots.push(rootRule(paths.homebrewCache, READ_WRITE_NO_DELETE));
  for (const extra of paths.homebrewExtra) {
    roots.push(rootRule(extra, READ_ONLY));
  }

  // ── Toolchain capabilities ──────────────────────────────────────────────
  const toolchainCapabilities: ProfileToolchainCapability[] = [];

  toolchainCapabilities.push({
    id: CAP_BUN,
    kind: "toolchain",
    discoveredFrom: "fixed_argv",
    executable: nodePath.join(home, ".bun", "bin", "bun"),
    roots: [rootRule(nodePath.join(home, ".bun"), READ_WRITE_NO_DELETE)],
    environmentKeys: ["BUN_INSTALL"],
    backend: "sandboxed",
    operations: ["run", "install", "test"],
  });

  toolchainCapabilities.push({
    id: CAP_NPM,
    kind: "toolchain",
    discoveredFrom: "fixed_argv",
    executable: "npm",
    roots: [rootRule(nodePath.join(home, ".npm"), READ_WRITE_NO_DELETE)],
    environmentKeys: ["NPM_CONFIG_CACHE"],
    backend: "sandboxed",
    operations: ["run", "install", "test"],
  });

  toolchainCapabilities.push({
    id: CAP_HOMEBREW,
    kind: "toolchain",
    discoveredFrom: "well_known_path",
    executable: paths.homebrewExecutable,
    // The Homebrew prefix + cache are top-level roots; the brew tool itself
    // owns no separate filesystem root.
    roots: [],
    environmentKeys: [],
    backend: "sandboxed",
    operations: ["install", "upgrade", "list"],
  });

  toolchainCapabilities.push({
    id: CAP_JDK,
    kind: "toolchain",
    discoveredFrom: "fixed_argv",
    executable: paths.jdkExecutable,
    // Authorize the parent that contains every installed JDK home; the
    // discovered `java_home` result lives beneath it.
    roots: [rootRule(paths.jdkParent, READ_EXECUTE)],
    environmentKeys: ["JAVA_HOME"],
    backend: "sandboxed",
    operations: ["compile", "run"],
  });

  toolchainCapabilities.push({
    id: CAP_GRADLE,
    kind: "toolchain",
    discoveredFrom: "existing_config",
    executable: "gradle",
    roots: [rootRule(nodePath.join(home, ".gradle"), READ_WRITE_NO_DELETE)],
    environmentKeys: ["GRADLE_USER_HOME"],
    backend: "sandboxed",
    operations: ["build", "test"],
  });

  toolchainCapabilities.push({
    id: CAP_EXPO_METRO,
    kind: "toolchain",
    discoveredFrom: "existing_config",
    executable: "expo",
    roots: [rootRule(nodePath.join(home, ".expo"), READ_WRITE_NO_DELETE)],
    environmentKeys: [],
    backend: "sandboxed",
    operations: ["start", "build"],
  });

  toolchainCapabilities.push({
    id: CAP_ANDROID_SDK,
    kind: "toolchain",
    discoveredFrom: "well_known_path",
    executable: paths.androidAdb,
    roots: [
      rootRule(paths.androidSdk, READ_WRITE),
      rootRule(paths.androidAvd, READ_WRITE_NO_DELETE),
    ],
    environmentKeys: ["ANDROID_HOME", "ANDROID_SDK_ROOT"],
    backend: "brokered_host_service",
    operations: ["adb", "emulator", "build"],
  });

  if (paths.isDarwin) {
    toolchainCapabilities.push({
      id: CAP_XCODE,
      kind: "toolchain",
      discoveredFrom: "well_known_path",
      executable: paths.xcodeExecutable,
      roots: [
        rootRule(
          nodePath.join(home, "Library", "Developer", "Xcode", "DerivedData"),
          READ_WRITE_NO_DELETE,
        ),
        rootRule(
          nodePath.join(home, "Library", "Developer", "CoreSimulator"),
          READ_WRITE_NO_DELETE,
        ),
      ],
      environmentKeys: ["DEVELOPER_DIR"],
      backend: "brokered_host_service",
      operations: ["build", "test", "simulate"],
    });
  }

  toolchainCapabilities.push({
    id: CAP_MASTRO,
    kind: "toolchain",
    discoveredFrom: "well_known_path",
    executable: nodePath.join(home, ".maestro", "bin", "maestro"),
    roots: [rootRule(nodePath.join(home, ".maestro"), READ_WRITE_NO_DELETE)],
    environmentKeys: [],
    backend: "brokered_host_service",
    operations: ["test", "drive"],
  });

  return {
    schemaVersion: 1,
    id: options.id ?? DEVELOPER_WORKSTATION_SEED_PROFILE_ID,
    revision: options.revision ?? DEVELOPER_WORKSTATION_SEED_PROFILE_REVISION,
    name: DEVELOPER_WORKSTATION_SEED_PROFILE_NAME,
    roots,
    discoveryProviders: [...DEVELOPER_WORKSTATION_SEED_DISCOVERY_PROVIDERS],
    environmentKeys: [...DEVELOPER_WORKSTATION_ENV_ALLOWLIST],
    executableRules: [
      {
        id: "exec-bun",
        executable: nodePath.join(home, ".bun", "bin", "bun"),
        argv: ["install", "run", "test"],
        backend: "sandboxed",
      },
    ],
    network: { mode: "host", allow: [] },
    capabilities: [...DEVELOPER_WORKSTATION_SEED_CAPABILITIES],
    toolchainCapabilities,
    protectedPolicyVersion: DEVELOPER_WORKSTATION_SEED_PROTECTED_POLICY_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Materialize and strict-validate the Developer Workstation seed profile for a
 * specific host. Returns the typed validation result so a caller can react to
 * a future schema drift; a shipped seed parsed against a matching schema never
 * fails. The result is a profile TEMPLATE — it is not activated and creates no
 * authority. Discovery facts are compiled against it separately.
 */
export function createDeveloperWorkstationSeedProfile(
  options: CreateDeveloperWorkstationSeedProfileOptions = {},
): WorkstationProfileValidationResult {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return {
      ok: false,
      error: { code: "invalid_record", message: "seed clock must be a valid date" },
    };
  }
  const record = buildDeveloperWorkstationSeedRecord({ ...options, now });
  return parseWorkstationProfile(record, { now });
}

/**
 * Convenience wrapper that returns the parsed seed profile or throws if the
 * shipped seed ever fails strict validation (a programming error, not a user
 * condition). Callers that prefer the typed result should use
 * {@link createDeveloperWorkstationSeedProfile} directly.
 */
export function developerWorkstationSeedProfile(
  options: CreateDeveloperWorkstationSeedProfileOptions = {},
): WorkstationProfile {
  const result = createDeveloperWorkstationSeedProfile(options);
  if (!result.ok) {
    throw new Error(
      `Developer Workstation seed profile rejected: ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.profile;
}
