/**
 * Shared, deliberately small relay dispatch sandbox policy.
 *
 * This module owns only the envelope-to-Sandbox decision. Relay consumers own
 * their dispatch execution, result mapping, and sandbox lifetime.
 */

import { accessSync, constants, statSync } from "node:fs";

import { createSandboxFromEnvelope, type SandboxEnvelopeLike } from "./from-envelope";
import { Sandbox } from "./sandbox";

/** Structural envelope factory seam; consumers do not need @nautilo/relay types. */
export interface RelayDispatchSandboxLocalAuthority {
  /** Runtime-only; never accepted from the serialized Relay envelope. */
  readonly allowWorkspaceGovernanceWrites?: boolean;
}

export type RelayDispatchSandboxFactory = (
  envelope: SandboxEnvelopeLike,
  localAuthority?: RelayDispatchSandboxLocalAuthority,
) => Promise<Sandbox>;

export type RelayDispatchSandboxResolution =
  | { readonly ok: true; readonly sandbox: Sandbox }
  | { readonly ok: false; readonly error: string };

export interface ResolveRelayDispatchSandboxOptions {
  readonly envelope: SandboxEnvelopeLike | undefined;
  readonly isProduction: boolean;
  /** Caller-selected dev fallback root; this module never chooses authority. */
  readonly developmentRoot: string;
  readonly toolName: string;
  readonly createSandbox?: RelayDispatchSandboxFactory | undefined;
  /** Caller-derived local authority; never read from the Relay request. */
  readonly localAuthority?: RelayDispatchSandboxLocalAuthority | undefined;
  readonly reportWarning?: ((message: string) => void) | undefined;
}

const MISSING_ENVELOPE_ERROR =
  "This tool could not start because the server did not supply its security configuration. " +
  "Reconnect Desktop to the server and retry. If it persists, update the server and Desktop. No operation was started.";

/**
 * Resolve the one sandbox used by a relay dispatch.
 *
 * The returned sandbox is caller-owned. In particular, this helper never
 * calls close(): terminal sessions and ordinary request dispatch have distinct
 * lifetime rules that remain local to their respective relays.
 */
export async function resolveRelayDispatchSandbox(
  options: ResolveRelayDispatchSandboxOptions,
): Promise<RelayDispatchSandboxResolution> {
  if (options.envelope !== undefined) {
    try {
      return {
        ok: true,
        sandbox: await (options.createSandbox ?? createSandboxFromEnvelope)(
          options.envelope,
          options.localAuthority,
        ),
      };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to construct sandbox from envelope: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  if (options.isProduction) {
    return { ok: false, error: MISSING_ENVELOPE_ERROR };
  }

  (options.reportWarning ?? console.warn)(
    `[relay] Dispatch received without sandboxProfile (${options.toolName}). ` +
      "Development-build dev loop — release builds will refuse this path.",
  );
  return {
    ok: true,
    sandbox: await Sandbox.create({
      config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
      workspace: options.developmentRoot,
      dataDir: options.developmentRoot,
      toolsBin: options.developmentRoot,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    }),
  };
}

export function unusableCurrentFolderError(cwd: string): string | null {
  try {
    if (!statSync(cwd).isDirectory()) {
      return `Current Folder is unusable for run_shell: ${cwd} is not a directory. ` +
        "Choose a normal user directory (for example, a folder in your home directory) and retry.";
    }
    accessSync(cwd, constants.R_OK | constants.X_OK);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code ? ` (${code})` : "";
    return `Current Folder is unusable for run_shell: cannot access ${cwd}${detail}. ` +
      "Choose a normal user directory (for example, a folder in your home directory) and retry.";
  }
}

export function hasSandboxCwdFailure(stderr: string): boolean {
  return /error retrieving current directory:\s*getcwd:.*operation not permitted/i.test(stderr);
}

export function sandboxCurrentFolderError(cwd: string): string {
  return `Current Folder is unusable for run_shell: the sandbox cannot access ${cwd}. ` +
    "Choose a normal user directory (for example, a folder in your home directory) and retry.";
}
