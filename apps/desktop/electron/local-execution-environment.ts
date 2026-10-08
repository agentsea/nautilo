import { homedir } from "node:os";
import { realpathSync } from "node:fs";
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
}

function freezePreparation(input: PreparedLocalExecutionEnvironment): PreparedLocalExecutionEnvironment {
  return Object.freeze({
    ...input,
    environment: Object.freeze({ ...input.environment }),
    executableByCapability: Object.freeze({ ...input.executableByCapability }),
    unavailableCapabilities: Object.freeze([...input.unavailableCapabilities]),
  });
}

/**
 * Build the exact environment used by every contained Development pipe/PTTY.
 * The projection is derived only from the activated profile's compiled facts;
 * parent PATH, credentials, shell startup hooks and rc files are never read.
 */
export function prepareDevelopmentExecutionEnvironment(
  source: LocalExecutionEnvironmentSource,
  options: {
    readonly trustedToolsBin: string;
    readonly expectedProfileId?: string;
    readonly expectedProfileRevision?: number;
    readonly canonicalize?: (path: string) => string;
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

  const environment: Record<string, string> = {
    HOME: home,
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp",
    CI: "true",
    DEBIAN_FRONTEND: "noninteractive",
  };
  for (const [key, value] of Object.entries(source.environmentValues)) {
    if (!APPROVED_DEVELOPMENT_ENVIRONMENT_KEYS.has(key) || !isAbsolute(value)) {
      throw new Error("LOCAL_EXECUTION_ENVIRONMENT_VALUE_DENIED");
    }
    environment[key] = canonicalize(value);
  }

  const executableByCapability: Record<string, string> = {};
  const unavailableCapabilities: string[] = [];
  const pathDirectories = [trustedToolsBin];
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

  return freezePreparation({
    mode: "development",
    environment,
    startup: "controlled_non_interactive",
    profileId: source.profileId,
    profileRevision: source.profileRevision,
    protectedPolicyVersion: source.protectedPolicyVersion,
    executableByCapability,
    unavailableCapabilities,
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
