/**
 * D418 — advisory Developer Workstation discovery adapters.
 *
 * Discovery is ADVISORY ONLY. Fixed-argv probes, well-known paths, and bounded
 * existing-config / env-key reads produce canonical `DiscoveredWorkstationFacts`
 * plus a human-readable review model. It NEVER creates a grant, NEVER mutates a
 * profile, NEVER activates a profile, and NEVER runs a shell string. The
 * compiler (`./compiler.ts`) intersects these facts with a bound profile
 * revision; any discovered root / env key / capability operation the profile
 * does not already authorize is rejected — discovery never creates authority.
 *
 * Safety contract:
 *   - `spawn`/`execFile` with **argument arrays only**. No shell strings, no
 *     `sh -c`, no `exec(command)`. Every probe is a fixed binary + fixed argv.
 *   - **No arbitrary environment dump.** Only the profile's bounded
 *     `environmentKeys` allowlist is read, via an injected `getEnv` seam.
 *   - **No arbitrary path scanning.** Only well-known candidate paths and the
 *     profile's own root templates are checked for existence/readability via an
 *     injected filesystem seam. Discovered roots are canonicalized with
 *     `path.resolve` and emitted only when they are both readable AND within a
 *     root rule the bound profile already authorizes (out-of-profile paths are
 *     surfaced as review notes, never as facts).
 *   - **Missing tools are optional/missing review rows, not errors.** A probe
 *     failure or an unreadable path resolves to a `missing` / `optional` row;
 *     `discoverWorkstationFacts` never rejects because a tool is absent.
 *
 * Driven by the bound profile's `toolchainCapabilities`: for each declared
 * capability id, the matching adapter probes the host. A capability is emitted
 * only when its executable is available; roots are emitted only when readable
 * and within the capability's authorized root templates. Capability ids the
 * profile declares but discovery has no built-in adapter for (an admin-added
 * custom/relocated toolchain) fall back to a generic adapter that proposes a
 * decision-ready delta from the admin-declared spec (fixed-argv executable
 * probe + declared root paths + bounded existing-config env keys), so
 * compatibility does not depend on Nautilo knowing every SDK in advance and
 * an unknown toolchain never requires a code release.
 *
 * Electron-free and side-effect-free except through the injected seams.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import {
  isPathWithinDesktopFilesystemGrantRoot,
} from "@nautilo/desktop-filesystem-grants";
import {
  type DiscoveredProfileCapability,
  type DiscoveredProfileRoot,
  type DiscoveredWorkstationFacts,
  type ProfileCapabilityBackend,
  type ProfileDiscoveryProvider,
  type ProfileRootRule,
  type ProfileToolchainCapability,
  type WorkstationProfile,
} from "@nautilo/workstation-profiles";

import {
  CAP_ANDROID_SDK,
  CAP_BUN,
  CAP_EXPO_METRO,
  CAP_GRADLE,
  CAP_HOMEBREW,
  CAP_JDK,
  CAP_MASTRO,
  CAP_NPM,
  CAP_XCODE,
} from "./developer-workstation-seed.ts";

const EXEC_PROBE_TIMEOUT_MS = 5_000;
const EXEC_PROBE_MAX_BUFFER = 1024 * 1024;

// ── Injectable seams ────────────────────────────────────────────────────────

/**
 * Filesystem seam: resolves if `path` is readable, rejects otherwise. Defaults
 * to `fs.promises.access(path, R_OK)`. Discovery never reads file contents.
 */
export interface WorkstationDiscoveryFileSystem {
  access(path: string): Promise<void>;
}

/**
 * `execFile`-style seam. Always invoked with a fixed binary and a fixed
 * argument array — never a shell string. Defaults to promisified
 * `child_process.execFile`.
 */
export interface WorkstationDiscoveryExec {
  (
    file: string,
    args: readonly string[],
    options: { timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Bounded environment read seam. Discovery calls this only for keys in the
 * profile's `environmentKeys` allowlist — never for a full env dump. Defaults
 * to `process.env[key]`.
 */
export interface WorkstationDiscoveryEnv {
  (key: string): string | undefined;
}

export interface WorkstationDiscoveryDependencies {
  readonly fs?: WorkstationDiscoveryFileSystem;
  readonly execFileAsync?: WorkstationDiscoveryExec;
  readonly getEnv?: WorkstationDiscoveryEnv;
  readonly home?: string;
  readonly platform?: string;
  readonly clock?: () => Date;
}

export interface DiscoverWorkstationFactsOptions extends WorkstationDiscoveryDependencies {
  /**
   * The bound profile whose `toolchainCapabilities` drive discovery. Discovery
   * emits facts only for capabilities this profile declares, and only roots
   * within this profile's authorized root templates. The profile is not
   * mutated and no authority is created.
   */
  readonly profile: WorkstationProfile;
}

// ── Review model ─────────────────────────────────────────────────────────────

export type WorkstationDiscoveryRowStatus = "found" | "missing" | "optional";

export interface WorkstationDiscoveryRow {
  /** Human-readable tool label (e.g. "Bun", "JDK", "Homebrew"). */
  readonly tool: string;
  /** Matching profile toolchain capability id, when applicable. */
  readonly capabilityId?: string;
  /** Discovery provider id, when the tool maps to one. */
  readonly provider?: ProfileDiscoveryProvider;
  readonly status: WorkstationDiscoveryRowStatus;
  /** How the tool was discovered: fixed argv / well-known path / existing config. */
  readonly origin?: "fixed_argv" | "well_known_path" | "existing_config";
  readonly executable?: string;
  readonly version?: string;
  readonly roots?: readonly string[];
  readonly environmentKeys?: readonly string[];
  readonly backend?: ProfileCapabilityBackend;
  readonly note?: string;
}

export interface WorkstationDiscoveryReviewSummary {
  readonly found: number;
  readonly optional: number;
  readonly missing: number;
}

export interface WorkstationDiscoveryReview {
  readonly generatedAt: string;
  readonly platform: string;
  readonly home: string;
  readonly networkMode: WorkstationProfile["network"]["mode"];
  readonly rows: readonly WorkstationDiscoveryRow[];
  readonly hostNetworkImplication: string;
  readonly hardBoundaries: readonly string[];
  readonly summary: WorkstationDiscoveryReviewSummary;
}

export interface WorkstationDiscoveryResult {
  readonly facts: DiscoveredWorkstationFacts;
  readonly review: WorkstationDiscoveryReview;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const defaultExecFileAsync: WorkstationDiscoveryExec = promisify(execFile) as unknown as WorkstationDiscoveryExec;
const defaultGetEnv: WorkstationDiscoveryEnv = (key) => process.env[key];
const defaultFs: WorkstationDiscoveryFileSystem = {
  access(path) {
    return nodeFs.access(path, nodeFs.constants.R_OK);
  },
};

interface ResolvedDependencies {
  readonly fs: WorkstationDiscoveryFileSystem;
  readonly exec: WorkstationDiscoveryExec;
  readonly getEnv: WorkstationDiscoveryEnv;
  readonly home: string;
  readonly platform: string;
  readonly clock: () => Date;
}

function resolveDependencies(options: WorkstationDiscoveryDependencies): ResolvedDependencies {
  return {
    fs: options.fs ?? defaultFs,
    exec: options.execFileAsync ?? defaultExecFileAsync,
    getEnv: options.getEnv ?? defaultGetEnv,
    home: options.home ?? nodeOs.homedir(),
    platform: options.platform ?? process.platform,
    clock: options.clock ?? (() => new Date()),
  };
}

/** Returns the canonical absolute path if it is readable, otherwise `null`. */
async function readablePath(
  fs: WorkstationDiscoveryFileSystem,
  candidate: string,
): Promise<string | null> {
  if (!nodePath.isAbsolute(candidate)) return null;
  const canonical = nodePath.resolve(candidate);
  try {
    await fs.access(canonical);
    return canonical;
  } catch {
    return null;
  }
}

interface ProbeResult {
  readonly ok: boolean;
  readonly version: string | null;
  readonly stdout: string;
}

/**
 * Runs a fixed binary + fixed argv and returns the first trimmed output line as
 * `version`. Never throws — a probe failure resolves to `{ ok: false }`.
 */
async function probeExecutable(
  exec: WorkstationDiscoveryExec,
  file: string,
  args: readonly string[],
): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      timeout: EXEC_PROBE_TIMEOUT_MS,
      maxBuffer: EXEC_PROBE_MAX_BUFFER,
    });
    const out = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim();
    const version = out.split(/\r?\n/)[0]?.trim() || null;
    return { ok: true, version, stdout: out };
  } catch {
    return { ok: false, version: null, stdout: "" };
  }
}

/**
 * Finds the narrowest spec root rule that contains `candidate`. Discovery emits
 * a discovered root with exactly that rule's access, so the discovered access is
 * always a subset of what the profile already authorizes.
 */
function containingRoot(
  specRoots: readonly ProfileRootRule[],
  candidate: string,
): ProfileRootRule | undefined {
  let best: ProfileRootRule | undefined;
  for (const rule of specRoots) {
    if (isPathWithinDesktopFilesystemGrantRoot(rule.path, candidate)) {
      if (best === undefined || rule.path.length > best.path.length) {
        best = rule;
      }
    }
  }
  return best;
}

interface AdapterContext extends ResolvedDependencies {
  readonly profile: WorkstationProfile;
}

interface AdapterOutcome {
  readonly capability?: DiscoveredProfileCapability;
  readonly topRoots?: readonly DiscoveredProfileRoot[];
  readonly rows: readonly WorkstationDiscoveryRow[];
}

async function collectCapabilityRoots(
  ctx: AdapterContext,
  spec: ProfileToolchainCapability,
  candidates: readonly string[],
  sourceProvider?: ProfileDiscoveryProvider,
): Promise<{ roots: DiscoveredProfileRoot[]; dropped: string[] }> {
  const roots: DiscoveredProfileRoot[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const readable = await readablePath(ctx.fs, candidate);
    if (readable === null) continue;
    if (seen.has(readable)) continue;
    seen.add(readable);
    const rule = containingRoot(spec.roots, readable);
    if (rule === undefined) {
      dropped.push(readable);
      continue;
    }
    roots.push({
      path: readable,
      access: [...rule.access],
      ...(sourceProvider !== undefined ? { sourceProvider } : {}),
    });
  }
  return { roots, dropped };
}

async function collectTopRoots(
  ctx: AdapterContext,
  candidates: readonly string[],
  sourceProvider: ProfileDiscoveryProvider,
): Promise<{ roots: DiscoveredProfileRoot[]; dropped: string[] }> {
  const roots: DiscoveredProfileRoot[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const readable = await readablePath(ctx.fs, candidate);
    if (readable === null) continue;
    if (seen.has(readable)) continue;
    seen.add(readable);
    const rule = containingRoot(ctx.profile.roots, readable);
    if (rule === undefined) {
      dropped.push(readable);
      continue;
    }
    roots.push({ path: readable, access: [...rule.access], sourceProvider });
  }
  return { roots, dropped };
}

function presentEnvKeys(
  getEnv: WorkstationDiscoveryEnv,
  allowed: readonly string[],
): string[] {
  const present: string[] = [];
  for (const key of allowed) {
    const value = getEnv(key);
    if (typeof value === "string" && value.length > 0) {
      present.push(key);
    }
  }
  return present;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

async function adaptBun(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const bunBin = nodePath.join(ctx.home, ".bun", "bin", "bun");
  const binReadable = await readablePath(ctx.fs, bunBin);
  let executable: string | null = null;
  let version: string | null = null;
  if (binReadable !== null) {
    const probed = await probeExecutable(ctx.exec, binReadable, ["--version"]);
    if (probed.ok) {
      executable = binReadable;
      version = probed.version;
    }
  }
  if (executable === null) {
    const probed = await probeExecutable(ctx.exec, "bun", ["--version"]);
    if (probed.ok) {
      executable = "bun";
      version = probed.version;
    }
  }
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [nodePath.join(ctx.home, ".bun")], "bun");
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  if (executable === null) {
    return {
      rows: [
        {
          tool: "Bun",
          capabilityId: CAP_BUN,
          provider: "bun",
          status: roots.length > 0 ? "optional" : "missing",
          origin: "fixed_argv",
          roots: roots.map((r) => r.path),
          environmentKeys: envKeys,
          backend: spec.backend,
          note:
            roots.length > 0
              ? "Bun cache present but executable not found on PATH or at ~/.bun/bin/bun."
              : "Bun is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_BUN,
      executable,
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(CAP_BUN, "Bun", "bun", "fixed_argv", executable, version, roots, envKeys, spec.backend, dropped),
    ],
  };
}

async function adaptNpm(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const probed = await probeExecutable(ctx.exec, "npm", ["--version"]);
  const executable = probed.ok ? "npm" : null;
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [nodePath.join(ctx.home, ".npm")], "npm");
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  if (executable === null) {
    return {
      rows: [
        {
          tool: "npm",
          capabilityId: CAP_NPM,
          provider: "npm",
          status: roots.length > 0 ? "optional" : "missing",
          origin: "fixed_argv",
          roots: roots.map((r) => r.path),
          environmentKeys: envKeys,
          backend: spec.backend,
          note: "npm is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_NPM,
      executable,
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(CAP_NPM, "npm", "npm", "fixed_argv", executable, probed.version, roots, envKeys, spec.backend, dropped),
    ],
  };
}

async function adaptHomebrew(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const binCandidates =
    ctx.platform === "darwin"
      ? ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
      : ["/home/linuxbrew/.linuxbrew/bin/brew"];
  let brewBin: string | null = null;
  for (const candidate of binCandidates) {
    const readable = await readablePath(ctx.fs, candidate);
    if (readable !== null) {
      brewBin = readable;
      break;
    }
  }
  if (brewBin === null) {
    const probed = await probeExecutable(ctx.exec, "brew", ["--version"]);
    if (probed.ok) brewBin = "brew";
  }
  if (brewBin === null) {
    return {
      rows: [
        {
          tool: "Homebrew",
          capabilityId: CAP_HOMEBREW,
          provider: "homebrew",
          status: "missing",
          origin: "well_known_path",
          environmentKeys: [],
          backend: spec.backend,
          note: "Homebrew is not installed at any well-known prefix.",
        },
      ],
    };
  }
  // Resolve the actual prefix via a fixed argv probe; fall back to well-known.
  const prefixProbed = await probeExecutable(ctx.exec, brewBin, ["--prefix"]);
  const prefix = prefixProbed.ok && prefixProbed.stdout.trim().length > 0
    ? prefixProbed.stdout.split(/\r?\n/)[0]!.trim()
    : null;
  const versionProbed = await probeExecutable(ctx.exec, brewBin, ["--version"]);
  const cache =
    ctx.platform === "darwin"
      ? nodePath.join(ctx.home, "Library", "Caches", "Homebrew")
      : nodePath.join(ctx.home, ".cache", "Homebrew");
  const topCandidates = [prefix, ...binCandidates.map((b) => nodePath.dirname(nodePath.dirname(b))), cache].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const { roots: topRoots, dropped } = await collectTopRoots(ctx, topCandidates, "homebrew");
  return {
    capability: {
      id: CAP_HOMEBREW,
      executable: brewBin,
      roots: [],
      environmentKeys: [],
      backend: spec.backend,
      operations: [...spec.operations],
    },
    topRoots,
    rows: [
      rowFound(
        CAP_HOMEBREW,
        "Homebrew",
        "homebrew",
        "well_known_path",
        brewBin,
        versionProbed.version,
        topRoots,
        [],
        spec.backend,
        dropped,
      ),
    ],
  };
}

async function adaptJdk(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  let javaHome: string | null = null;
  let origin: "fixed_argv" | "existing_config" = "fixed_argv";
  if (ctx.platform === "darwin") {
    const probed = await probeExecutable(ctx.exec, "/usr/libexec/java_home", []);
    if (probed.ok) {
      const candidate = probed.stdout.split(/\r?\n/)[0]?.trim() || null;
      if (candidate !== null && candidate.length > 0) {
        const readable = await readablePath(ctx.fs, candidate);
        if (readable !== null) javaHome = readable;
      }
    }
  }
  if (javaHome === null) {
    const envHome = ctx.getEnv("JAVA_HOME");
    if (typeof envHome === "string" && envHome.length > 0) {
      const readable = await readablePath(ctx.fs, envHome);
      if (readable !== null) {
        javaHome = readable;
        origin = "existing_config";
      }
    }
  }
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  if (javaHome === null) {
    return {
      rows: [
        {
          tool: "JDK",
          capabilityId: CAP_JDK,
          status: "missing",
          origin,
          environmentKeys: envKeys,
          backend: spec.backend,
          note:
            ctx.platform === "darwin"
              ? "No JDK found via /usr/libexec/java_home or JAVA_HOME."
              : "No JDK found via JAVA_HOME.",
        },
      ],
    };
  }
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [javaHome]);
  let version: string | null = null;
  const javaBin = nodePath.join(javaHome, "bin", "java");
  const javaReadable = await readablePath(ctx.fs, javaBin);
  if (javaReadable !== null) {
    const probed = await probeExecutable(ctx.exec, javaReadable, ["-version"]);
    if (probed.ok) version = probed.version;
  }
  return {
    capability: {
      id: CAP_JDK,
      executable: ctx.platform === "darwin" ? "/usr/libexec/java_home" : "java",
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [rowFound(CAP_JDK, "JDK", undefined, origin, javaHome, version, roots, envKeys, spec.backend, dropped)],
  };
}

async function adaptGradle(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const envHome = ctx.getEnv("GRADLE_USER_HOME");
  const rootCandidate =
    typeof envHome === "string" && envHome.length > 0 ? envHome : nodePath.join(ctx.home, ".gradle");
  const probed = await probeExecutable(ctx.exec, "gradle", ["--version"]);
  const executable = probed.ok ? "gradle" : null;
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [rootCandidate], "gradle");
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  const origin = "existing_config" as const;
  if (executable === null) {
    return {
      rows: [
        {
          tool: "Gradle",
          capabilityId: CAP_GRADLE,
          provider: "gradle",
          status: roots.length > 0 ? "optional" : "missing",
          origin,
          roots: roots.map((r) => r.path),
          environmentKeys: envKeys,
          backend: spec.backend,
          note:
            roots.length > 0
              ? "Gradle cache present but `gradle` executable not found on PATH."
              : "Gradle is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_GRADLE,
      executable,
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [rowFound(CAP_GRADLE, "Gradle", "gradle", origin, executable, probed.version, roots, envKeys, spec.backend, dropped)],
  };
}

async function adaptExpoMetro(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const rootCandidate = nodePath.join(ctx.home, ".expo");
  let executable: string | null = null;
  let version: string | null = null;
  const direct = await probeExecutable(ctx.exec, "expo", ["--version"]);
  if (direct.ok) {
    executable = "expo";
    version = direct.version;
  } else {
    const viaNpx = await probeExecutable(ctx.exec, "npx", ["expo", "--version"]);
    if (viaNpx.ok) {
      executable = "npx";
      version = viaNpx.version;
    }
  }
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [rootCandidate], "expo_metro");
  if (executable === null) {
    return {
      rows: [
        {
          tool: "Expo / Metro",
          capabilityId: CAP_EXPO_METRO,
          provider: "expo_metro",
          status: roots.length > 0 ? "optional" : "missing",
          origin: "existing_config",
          roots: roots.map((r) => r.path),
          backend: spec.backend,
          note:
            roots.length > 0
              ? "Expo cache present but `expo` / `npx expo` not available."
              : "Expo / Metro is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_EXPO_METRO,
      executable,
      roots,
      environmentKeys: [],
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(CAP_EXPO_METRO, "Expo / Metro", "expo_metro", "existing_config", executable, version, roots, [], spec.backend, dropped),
    ],
  };
}

async function adaptAndroidSdk(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const envSdk = ctx.getEnv("ANDROID_HOME") ?? ctx.getEnv("ANDROID_SDK_ROOT");
  const sdkCandidate =
    typeof envSdk === "string" && envSdk.length > 0
      ? envSdk
      : ctx.platform === "darwin"
        ? nodePath.join(ctx.home, "Library", "Android", "sdk")
        : nodePath.join(ctx.home, "Android", "Sdk");
  const adbPath = nodePath.join(sdkCandidate, "platform-tools", "adb");
  let executable: string | null = null;
  let version: string | null = null;
  const adbReadable = await readablePath(ctx.fs, adbPath);
  if (adbReadable !== null) {
    const probed = await probeExecutable(ctx.exec, adbReadable, ["version"]);
    if (probed.ok) {
      executable = adbReadable;
      version = probed.version;
    }
  }
  if (executable === null) {
    const probed = await probeExecutable(ctx.exec, "adb", ["version"]);
    if (probed.ok) {
      executable = "adb";
      version = probed.version;
    }
  }
  const avdCandidate = nodePath.join(ctx.home, ".android");
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [sdkCandidate, avdCandidate], "android_sdk");
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  if (executable === null) {
    return {
      rows: [
        {
          tool: "Android SDK / ADB / AVD",
          capabilityId: CAP_ANDROID_SDK,
          provider: "android_sdk",
          status: roots.length > 0 ? "optional" : "missing",
          origin: "well_known_path",
          roots: roots.map((r) => r.path),
          environmentKeys: envKeys,
          backend: spec.backend,
          note:
            roots.length > 0
              ? "Android SDK state present but ADB executable not found."
              : "Android SDK is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_ANDROID_SDK,
      executable,
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(
        CAP_ANDROID_SDK,
        "Android SDK / ADB / AVD",
        "android_sdk",
        "well_known_path",
        executable,
        version,
        roots,
        envKeys,
        spec.backend,
        dropped,
      ),
    ],
  };
}

async function adaptXcode(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  if (ctx.platform !== "darwin") {
    return {
      rows: [
        {
          tool: "Xcode / CoreSimulator",
          capabilityId: CAP_XCODE,
          provider: "xcode",
          status: "missing",
          origin: "well_known_path",
          backend: spec.backend,
          note: "Xcode is only available on macOS.",
        },
      ],
    };
  }
  const xcodebuild = "/usr/bin/xcodebuild";
  const readable = await readablePath(ctx.fs, xcodebuild);
  let executable: string | null = null;
  let version: string | null = null;
  if (readable !== null) {
    const probed = await probeExecutable(ctx.exec, xcodebuild, ["-version"]);
    if (probed.ok) {
      executable = xcodebuild;
      version = probed.version;
    }
  }
  const derivedData = nodePath.join(ctx.home, "Library", "Developer", "Xcode", "DerivedData");
  const coreSim = nodePath.join(ctx.home, "Library", "Developer", "CoreSimulator");
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [derivedData, coreSim], "xcode");
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  if (executable === null) {
    return {
      rows: [
        {
          tool: "Xcode / CoreSimulator",
          capabilityId: CAP_XCODE,
          provider: "xcode",
          status: roots.length > 0 ? "optional" : "missing",
          origin: "well_known_path",
          roots: roots.map((r) => r.path),
          environmentKeys: envKeys,
          backend: spec.backend,
          note:
            roots.length > 0
              ? "Xcode DerivedData / CoreSimulator present but xcodebuild not available."
              : "Xcode is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_XCODE,
      executable,
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(CAP_XCODE, "Xcode / CoreSimulator", "xcode", "well_known_path", executable, version, roots, envKeys, spec.backend, dropped),
    ],
  };
}

async function adaptMaestro(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  const maestroBin = nodePath.join(ctx.home, ".maestro", "bin", "maestro");
  let executable: string | null = null;
  let version: string | null = null;
  const binReadable = await readablePath(ctx.fs, maestroBin);
  if (binReadable !== null) {
    const probed = await probeExecutable(ctx.exec, binReadable, ["--version"]);
    if (probed.ok) {
      executable = binReadable;
      version = probed.version;
    }
  }
  if (executable === null) {
    const probed = await probeExecutable(ctx.exec, "maestro", ["--version"]);
    if (probed.ok) {
      executable = "maestro";
      version = probed.version;
    }
  }
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, [nodePath.join(ctx.home, ".maestro")], "maestro");
  if (executable === null) {
    return {
      rows: [
        {
          tool: "Maestro",
          capabilityId: CAP_MASTRO,
          provider: "maestro",
          status: roots.length > 0 ? "optional" : "missing",
          origin: "well_known_path",
          roots: roots.map((r) => r.path),
          backend: spec.backend,
          note:
            roots.length > 0
              ? "Maestro config present but executable not found at ~/.maestro/bin/maestro or on PATH."
              : "Maestro is not installed.",
        },
      ],
    };
  }
  return {
    capability: {
      id: CAP_MASTRO,
      executable,
      roots,
      environmentKeys: [],
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(CAP_MASTRO, "Maestro", "maestro", "well_known_path", executable, version, roots, [], spec.backend, dropped),
    ],
  };
}

/**
 * Conservative fixed argv probes used by the generic admin-declared adapter to
 * confirm an admin-declared executable is actually present on the host. Both
 * argv forms are fixed arrays — never a shell string, never a renderer- or
 * env-supplied fragment. A tool that responds to neither is treated as absent.
 */
const GENERIC_VERSION_PROBES: readonly (readonly string[])[] = [["--version"], ["version"]];

/**
 * Generic adapter for profile-declared toolchains that have no built-in
 * adapter — admin-added custom/relocated toolchains. It proposes a
 * **decision-ready delta** derived strictly from the admin-declared spec, so
 * an admin can review and approve the concrete facts without a Nautilo code
 * release. It uses only the three conservative discovery modalities:
 *
 *   - **fixed argv**: probes the spec's declared `executable` with a fixed
 *     `--version` / `version` argv to confirm the tool is present;
 *   - **well-known / admin-declared paths**: checks the spec's declared
 *     `roots` for existence (out-of-profile readable paths are dropped and
 *     surfaced as review notes, exactly like the built-in adapters);
 *   - **existing config**: reads only the spec's bounded `environmentKeys`
 *     allowlist via the injected `getEnv` seam.
 *
 * It never creates authority. The emitted `DiscoveredProfileCapability` is
 * advisory: the compiler still intersects it with the bound profile, and
 * because the capability is already profile-declared, it compiles only when
 * its roots/env/operations match the declaration. A missing executable yields
 * an optional/missing review row carrying the proposed shape (roots, env
 * keys, declared executable in the note) — never a fact, never an error.
 */
async function adaptAdminDeclared(spec: ProfileToolchainCapability, ctx: AdapterContext): Promise<AdapterOutcome> {
  let executable: string | null = null;
  let version: string | null = null;
  if (nodePath.isAbsolute(spec.executable)) {
    const readable = await readablePath(ctx.fs, spec.executable);
    if (readable !== null) {
      for (const args of GENERIC_VERSION_PROBES) {
        const probed = await probeExecutable(ctx.exec, readable, args);
        if (probed.ok) {
          executable = readable;
          version = probed.version;
          break;
        }
      }
    }
  } else {
    for (const args of GENERIC_VERSION_PROBES) {
      const probed = await probeExecutable(ctx.exec, spec.executable, args);
      if (probed.ok) {
        executable = spec.executable;
        version = probed.version;
        break;
      }
    }
  }
  const rootCandidates = spec.roots.map((rule) => rule.path);
  const { roots, dropped } = await collectCapabilityRoots(ctx, spec, rootCandidates);
  const envKeys = presentEnvKeys(ctx.getEnv, spec.environmentKeys);
  if (executable === null) {
    const rootsPresent = roots.length > 0;
    return {
      rows: [
        {
          tool: spec.id,
          capabilityId: spec.id,
          status: rootsPresent ? "optional" : "missing",
          origin: "existing_config",
          roots: roots.map((r) => r.path),
          environmentKeys: envKeys,
          backend: spec.backend,
          note: rootsPresent
            ? `Admin-declared toolchain "${spec.id}" roots present but executable "${spec.executable}" was not found; approve the declared profile delta once the tool is installed or relocated.`
            : `Admin-declared toolchain "${spec.id}" was not found (executable "${spec.executable}" and no declared roots present on host); approve the declared profile delta to enable.`,
        },
      ],
    };
  }
  return {
    capability: {
      id: spec.id,
      executable,
      roots,
      environmentKeys: envKeys,
      backend: spec.backend,
      operations: [...spec.operations],
    },
    rows: [
      rowFound(spec.id, spec.id, undefined, "existing_config", executable, version, roots, envKeys, spec.backend, dropped),
    ],
  };
}

const ADAPTERS: Record<string, (spec: ProfileToolchainCapability, ctx: AdapterContext) => Promise<AdapterOutcome>> = {
  [CAP_BUN]: adaptBun,
  [CAP_NPM]: adaptNpm,
  [CAP_HOMEBREW]: adaptHomebrew,
  [CAP_JDK]: adaptJdk,
  [CAP_GRADLE]: adaptGradle,
  [CAP_EXPO_METRO]: adaptExpoMetro,
  [CAP_ANDROID_SDK]: adaptAndroidSdk,
  [CAP_XCODE]: adaptXcode,
  [CAP_MASTRO]: adaptMaestro,
};

function rowFound(
  capabilityId: string,
  tool: string,
  provider: ProfileDiscoveryProvider | undefined,
  origin: "fixed_argv" | "well_known_path" | "existing_config",
  executable: string,
  version: string | null,
  roots: readonly DiscoveredProfileRoot[],
  environmentKeys: readonly string[],
  backend: ProfileCapabilityBackend,
  dropped: readonly string[],
): WorkstationDiscoveryRow {
  const note = dropped.length > 0 ? `Discovered path(s) outside the profile root templates (need an admin delta): ${dropped.join(", ")}` : undefined;
  return {
    tool,
    capabilityId,
    ...(provider !== undefined ? { provider } : {}),
    status: "found",
    origin,
    executable,
    ...(version !== null ? { version } : {}),
    roots: roots.map((r) => r.path),
    environmentKeys,
    backend,
    ...(note !== undefined ? { note } : {}),
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

const HARD_BOUNDARIES: readonly string[] = [
  "SSH / GPG / cloud credentials, Keychains, and browser/password stores remain denied.",
  "Nautilo private state, vault, and audit data remain denied under every parent grant.",
  "sudo, password/PIN entry, and OS authorization elevation remain blocked.",
  "Critical disk destruction (rm -rf /, disk wipe, fork bomb) remains blocked.",
  "TCC/FDA, SIP, ACL, and file ownership remain macOS/OS decisions.",
];

const HOST_NETWORK_IMPLICATION =
  "Host networking is on: any readable non-protected file reachable from this workstation may be transmitted to network destinations the agent reaches. Command scanning is defense-in-depth, not an exfiltration guarantee.";

/**
 * Run advisory discovery against the bound profile's declared toolchain
 * capabilities and return canonical `DiscoveredWorkstationFacts` plus a
 * human-readable review model. Never creates a grant, never mutates the
 * profile, never rejects because a tool is missing.
 */
export async function discoverWorkstationFacts(
  options: DiscoverWorkstationFactsOptions,
): Promise<WorkstationDiscoveryResult> {
  const deps = resolveDependencies(options);
  const ctx: AdapterContext = { ...deps, profile: options.profile };
  const now = deps.clock();
  const generatedAt = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();

  const capabilities: DiscoveredProfileCapability[] = [];
  const topRoots: DiscoveredProfileRoot[] = [];
  const rows: WorkstationDiscoveryRow[] = [];
  const seenTopRoots = new Set<string>();

  for (const spec of options.profile.toolchainCapabilities) {
    // A profile-declared capability with no built-in adapter (an admin-added
    // custom/relocated toolchain) falls back to the generic adapter, which
    // proposes a decision-ready delta from the admin-declared spec without a
    // code release. It never creates authority and never rejects on a missing
    // tool.
    const adapter = ADAPTERS[spec.id] ?? adaptAdminDeclared;
    const outcome = await adapter(spec, ctx);
    if (outcome.capability !== undefined) {
      capabilities.push(outcome.capability);
    }
    if (outcome.topRoots !== undefined) {
      for (const root of outcome.topRoots) {
        if (!seenTopRoots.has(root.path)) {
          seenTopRoots.add(root.path);
          topRoots.push(root);
        }
      }
    }
    rows.push(...outcome.rows);
  }

  const environmentKeys = presentEnvKeys(ctx.getEnv, options.profile.environmentKeys);

  const facts: DiscoveredWorkstationFacts = {
    roots: topRoots,
    environmentKeys,
    capabilities,
  };

  const summary: WorkstationDiscoveryReviewSummary = {
    found: rows.filter((r) => r.status === "found").length,
    optional: rows.filter((r) => r.status === "optional").length,
    missing: rows.filter((r) => r.status === "missing").length,
  };

  const review: WorkstationDiscoveryReview = {
    generatedAt,
    platform: deps.platform,
    home: deps.home,
    networkMode: options.profile.network.mode,
    rows,
    hostNetworkImplication: HOST_NETWORK_IMPLICATION,
    hardBoundaries: HARD_BOUNDARIES,
    summary,
  };

  return { facts, review };
}
