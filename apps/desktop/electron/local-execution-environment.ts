import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute } from "node:path";
import { DEVELOPER_WORKSTATION_ENV_ALLOWLIST } from "./workstation-profiles/developer-workstation-seed";

const CONTROLLED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const APPROVED_DEVELOPMENT_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set(DEVELOPER_WORKSTATION_ENV_ALLOWLIST);

export interface LocalExecutionEnvironmentSource {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly protectedPolicyVersion: number;
  readonly home: string;
  readonly environmentValues: Readonly<Record<string, string>>;
  readonly userEnvironment?: boolean;
  readonly userEnvironmentWritablePaths?: readonly string[];
  readonly executables: readonly {
    readonly capabilityId: string;
    readonly executable: string;
    readonly backend: "sandboxed" | "brokered_host_service";
  }[];
}

export interface PreparedLocalExecutionEnvironment {
  readonly mode: "development";
  readonly environment: Readonly<Record<string, string>>;
  readonly startup: "controlled_non_interactive";
  readonly profileId: string | null;
  readonly profileRevision: number | null;
  readonly protectedPolicyVersion: number;
  readonly executableByCapability: Readonly<Record<string, string>>;
  readonly unavailableCapabilities: readonly string[];
  readonly userEnvironment?: boolean;
  readonly userEnvironmentWritablePaths?: readonly string[];
}

const APPLICATION_ENVIRONMENT_KEYS = new Set([
  "_",
  "SHLVL",
  "PWD",
  "OLDPWD",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);

function isApplicationEnvironmentKey(key: string): boolean {
  return APPLICATION_ENVIRONMENT_KEYS.has(key) || key.startsWith("ELECTRON_");
}

function projectNativeEnvironment(
  nativeEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(nativeEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isApplicationEnvironmentKey(key)) continue;
    if (value.includes("\0")) throw new Error("LOCAL_EXECUTION_ENVIRONMENT_VALUE_DENIED");
    projected[key] = value;
  }
  return projected;
}

function freezePreparation(input: PreparedLocalExecutionEnvironment): PreparedLocalExecutionEnvironment {
  return Object.freeze({
    ...input,
    environment: Object.freeze({ ...input.environment }),
    executableByCapability: Object.freeze({ ...input.executableByCapability }),
    unavailableCapabilities: Object.freeze([...input.unavailableCapabilities]),
    ...(input.userEnvironmentWritablePaths === undefined
      ? {}
      : { userEnvironmentWritablePaths: Object.freeze([...input.userEnvironmentWritablePaths]) }),
  });
}

/**
 * Build the exact environment used by every contained Development pipe/PTTY.
 * Legacy profiles use only compiled facts. An explicit `user_environment`
 * capability additionally projects an injected login-shell capture; this
 * function never reads the parent process or shell startup files itself.
 */
export function prepareDevelopmentExecutionEnvironment(
  source: LocalExecutionEnvironmentSource,
  options: {
    readonly trustedToolsBin: string;
    readonly expectedProfileId?: string;
    readonly expectedProfileRevision?: number;
    readonly canonicalize?: (path: string) => string;
    /** Login-shell environment captured from a clean native user baseline. */
    readonly nativeEnvironment?: Readonly<Record<string, string>>;
  },
): PreparedLocalExecutionEnvironment {
  if ((options.expectedProfileId !== undefined && options.expectedProfileId !== source.profileId) ||
      (options.expectedProfileRevision !== undefined && options.expectedProfileRevision !== source.profileRevision)) {
    throw new Error("LOCAL_EXECUTION_ENVIRONMENT_PROFILE_MISMATCH");
  }
  const canonicalize = options.canonicalize ?? realpathSync;
  const home = canonicalize(source.home);
  const trustedToolsBin = canonicalize(options.trustedToolsBin);
  if (!isAbsolute(home) || !isAbsolute(trustedToolsBin)) {
    throw new Error("LOCAL_EXECUTION_ENVIRONMENT_PATH_INVALID");
  }

  if (
    source.userEnvironment === true &&
    (options.nativeEnvironment === undefined || options.nativeEnvironment["HOME"] === undefined)
  ) {
    throw new Error("LOCAL_EXECUTION_NATIVE_ENVIRONMENT_REQUIRED");
  }
  const environment: Record<string, string> = source.userEnvironment === true
    ? projectNativeEnvironment(options.nativeEnvironment ?? {})
    : {
        HOME: home,
        LANG: "en_US.UTF-8",
        TMPDIR: "/tmp",
        CI: "true",
        DEBIAN_FRONTEND: "noninteractive",
      };
  environment["HOME"] = home;
  environment["LANG"] ??= "en_US.UTF-8";
  environment["TMPDIR"] ??= "/tmp";
  for (const [key, value] of Object.entries(source.environmentValues)) {
    if (!APPROVED_DEVELOPMENT_ENVIRONMENT_KEYS.has(key) || !isAbsolute(value)) {
      throw new Error("LOCAL_EXECUTION_ENVIRONMENT_VALUE_DENIED");
    }
    environment[key] = canonicalize(value);
  }

  const executableByCapability: Record<string, string> = {};
  const unavailableCapabilities: string[] = [];
  const pathDirectories = source.userEnvironment === true
    ? (environment["PATH"] ?? "").split(delimiter).filter(Boolean)
    : [];
  pathDirectories.push(trustedToolsBin);
  for (const capability of source.executables) {
    if (capability.backend !== "sandboxed") continue;
    if (!isAbsolute(capability.executable)) {
      unavailableCapabilities.push(capability.capabilityId);
      continue;
    }
    const executable = canonicalize(capability.executable);
    executableByCapability[capability.capabilityId] = executable;
    pathDirectories.push(dirname(executable));
  }
  for (const systemPath of CONTROLLED_SYSTEM_PATHS) pathDirectories.push(systemPath);
  environment["PATH"] = [...new Set(pathDirectories)].join(delimiter);

  const userEnvironmentWritablePaths = source.userEnvironment === true
    ? [...new Set((source.userEnvironmentWritablePaths ?? []).map((candidate) => {
        const canonical = canonicalize(candidate);
        if (!isAbsolute(canonical)) throw new Error("LOCAL_EXECUTION_ENVIRONMENT_PATH_INVALID");
        return canonical;
      }))]
    : undefined;

  return freezePreparation({
    mode: "development",
    environment,
    startup: "controlled_non_interactive",
    profileId: source.profileId,
    profileRevision: source.profileRevision,
    protectedPolicyVersion: source.protectedPolicyVersion,
    executableByCapability,
    unavailableCapabilities,
    ...(source.userEnvironment === true
      ? {
          userEnvironment: true,
          userEnvironmentWritablePaths: userEnvironmentWritablePaths ?? [],
        }
      : {}),
  });
}

/** Environment for an explicitly admitted Full Mac shell command. Installed
 * command lookup is part of that account-level grant; it is not a runtime
 * resolver for apply_patch or any other attested Nautilo tool. Never forward
 * Electron's account/provider tokens, loader variables, or shell startup hooks.
 */
export function createFullMacExecutionEnvironment(
  parentEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory: string = homedir(),
): Record<string, string> {
  const installedCommandPath = parentEnvironment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    HOME: homeDirectory,
    PATH: installedCommandPath.split(delimiter).filter(entry => isAbsolute(entry)).join(delimiter),
    LANG: "en_US.UTF-8",
  };
}

/** Native helper paths are local facts, never server-provided sandbox grants. */
export function developmentRuntimeWritablePaths(
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const paths: string[] = [];
  for (const key of ["TMPDIR", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"] as const) {
    const candidate = environment[key];
    if (candidate === undefined || !isAbsolute(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      // Linux keeps its private /tmp. Bind a helper socket itself if needed;
      // never replace that mount with the entire host temporary directory.
      if (canonical === "/" || (platform === "linux" && canonical === "/tmp")) continue;
      const stat = statSync(canonical);
      if (process.getuid !== undefined && stat.uid !== process.getuid()) continue;
      if (key === "SSH_AUTH_SOCK" ? !stat.isSocket() : !stat.isDirectory()) continue;
      paths.push(canonical);
    } catch {
      // Stale native helper paths remain ordinary CLI errors, not broad grants.
    }
  }
  return [...new Set(paths)];
}
