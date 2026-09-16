import { isAbsolute, resolve } from "node:path";

/**
 * First-owner intent is deliberately decided before a Compose driver exists.
 *
 * It does not inspect a target or perform I/O. The deploy and resume adapters
 * consume this intent only after their own provider-specific safety checks.
 */
export type ComposeOwnerMode = "claim" | "config";

export type ComposeOwnerModeResolution =
  | {
      kind: "claim";
      ownerMode: "claim";
    }
  | {
      kind: "config";
      ownerMode: "config";
      ownerConfigPath: string;
      ownerResultPath: string;
    }
  | {
      kind: "rejected";
      code:
        | "owner-config-missing"
        | "owner-mode-required"
        | "redeem-disabled"
        | "invalid-owner-mode"
        | "owner-config-invalid"
        | "owner-result-invalid"
        | "owner-result-missing"
        | "owner-result-requires-config"
        | "owner-config-conflicts-claim"
        | "owner-result-conflicts-claim";
      message: string;
    };

export interface ResolveComposeOwnerModeInput {
  /** Canonical protected default path, even when it is not present. */
  defaultOwnerConfigPath: string;
  protectedOwnerConfigPresent: boolean;
  requestedOwnerMode: unknown;
  /** Public `--owner-config` path. Presence explicitly selects config mode. */
  requestedOwnerConfigPath: unknown;
  /** Public `--owner-result` path for crash-durable seeded recovery output. */
  requestedOwnerResultPath: unknown;
  redeem: boolean;
  interactive: boolean;
  json: boolean;
}

function requestedMode(value: unknown): ComposeOwnerMode | undefined | null {
  if (value === undefined) return undefined;
  if (value === "claim" || value === "config") return value;
  return null;
}

function optionalPath(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (path.length === 0 || !isAbsolute(path) || resolve(path) !== path) return null;
  return path;
}

/**
 * Resolve exactly one first-owner intent before driver construction or Docker
 * mutation. An interactive terminal defaults to hosted claim; JSON and
 * noninteractive calls must name an owner mode (or provide owner config).
 */
export function resolveComposeOwnerMode(
  input: ResolveComposeOwnerModeInput,
): ComposeOwnerModeResolution {
  const mode = requestedMode(input.requestedOwnerMode);
  if (mode === null) {
    return {
      kind: "rejected",
      code: "invalid-owner-mode",
      message: "--owner-mode must be either 'claim' or 'config'.",
    };
  }
  const configPath = optionalPath(input.requestedOwnerConfigPath);
  if (configPath === null) {
    return {
      kind: "rejected",
      code: "owner-config-invalid",
      message: "--owner-config must be a non-empty protected TOML path.",
    };
  }
  const resultPath = optionalPath(input.requestedOwnerResultPath);
  if (resultPath === null) {
    return {
      kind: "rejected",
      code: "owner-result-invalid",
      message: "--owner-result must be a non-empty operator-owned result path.",
    };
  }

  // This historical escape hatch used to suppress the hook and then let deploy
  // report complete. It cannot be an owner mode in the new state machine.
  if (!input.redeem) {
    return {
      kind: "rejected",
      code: "redeem-disabled",
      message:
        "--no-redeem is no longer supported for deploy. For an existing owner-bound server, use nautilo restart or nautilo upgrade instead.",
    };
  }

  if (mode === "claim") {
    if (configPath !== undefined) {
      return {
        kind: "rejected",
        code: "owner-config-conflicts-claim",
        message: "--owner-config cannot be combined with --owner-mode claim.",
      };
    }
    if (resultPath !== undefined) {
      return {
        kind: "rejected",
        code: "owner-result-conflicts-claim",
        message: "--owner-result is only valid with --owner-mode config.",
      };
    }
    return { kind: "claim", ownerMode: "claim" };
  }

  const configSelected = mode === "config" || configPath !== undefined;
  if (configSelected) {
    const resolvedConfigPath = configPath
      ?? (input.protectedOwnerConfigPresent ? input.defaultOwnerConfigPath : undefined);
    if (resolvedConfigPath === undefined) {
      return {
        kind: "rejected",
        code: "owner-config-missing",
        message:
          "--owner-mode config requires --owner-config <protected.toml> or the protected default ~/.config/nautilo/deploy.toml.",
      };
    }
    if (resultPath === undefined) {
      return {
        kind: "rejected",
        code: "owner-result-missing",
        message:
          "Config owner mode requires --owner-result <operator-owned-result.json> so one-time recovery codes are durably delivered before success is reported.",
      };
    }
    return {
      kind: "config",
      ownerMode: "config",
      ownerConfigPath: resolvedConfigPath,
      ownerResultPath: resultPath,
    };
  }

  if (resultPath !== undefined) {
    return {
      kind: "rejected",
      code: "owner-result-requires-config",
      message: "--owner-result requires --owner-mode config or --owner-config <protected.toml>.",
    };
  }

  if (input.interactive && !input.json) {
    return { kind: "claim", ownerMode: "claim" };
  }

  return {
    kind: "rejected",
    code: "owner-mode-required",
    message:
      "Noninteractive or JSON deploy requires --owner-mode claim, --owner-mode config, or --owner-config <protected.toml>.",
  };
}
