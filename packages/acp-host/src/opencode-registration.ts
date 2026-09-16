export const OPENCODE_ACP_HARNESS_ID = "opencode-acp";
export const OPENCODE_ACP_REVIEWED_VERSION = "1.18.16";
export const OPENCODE_ACP_VERSION_OUTPUT_MAX_BYTES = 4 * 1024;

export type OpenCodeAcpReadinessState =
  | "ready"
  | "missing"
  | "incompatible"
  | "authentication_required"
  | "unavailable";

export type OpenCodeAcpReadiness = Readonly<{
  state: OpenCodeAcpReadinessState;
  action: string | null;
}>;

/**
 * Electron-local discovery evidence. OpenCode configuration, providers,
 * accounts, credentials, paths, and raw diagnostics cannot enter this shape.
 */
export type OpenCodeAcpHostReadinessEvidence = Readonly<{
  executableBasename: "opencode";
  versionOutput: Uint8Array | null;
  preflight: "passed" | "authentication_required" | "missing" | "unavailable";
}>;

export interface OpenCodeAcpReadinessResolver {
  inspect(): Promise<OpenCodeAcpHostReadinessEvidence>;
}

export class OpenCodeAcpReadinessError extends Error {
  constructor(readonly state: Exclude<OpenCodeAcpReadinessState, "ready">) {
    super(state);
    this.name = "OpenCodeAcpReadinessError";
  }
}

export function parseOpenCodeAcpVersionOutput(
  output: Uint8Array,
): typeof OPENCODE_ACP_REVIEWED_VERSION | null {
  if (output.byteLength === 0 || output.byteLength > OPENCODE_ACP_VERSION_OUTPUT_MAX_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return null;
  }
  return text === OPENCODE_ACP_REVIEWED_VERSION || text === `${OPENCODE_ACP_REVIEWED_VERSION}\n`
    ? OPENCODE_ACP_REVIEWED_VERSION
    : null;
}

export function classifyOpenCodeAcpReadiness(
  evidence: OpenCodeAcpHostReadinessEvidence,
): OpenCodeAcpReadiness {
  if (evidence.executableBasename !== "opencode") return readiness("unavailable");
  if (evidence.preflight === "missing") return readiness("missing");
  const version = evidence.versionOutput === null ? null : parseOpenCodeAcpVersionOutput(evidence.versionOutput);
  if (version !== OPENCODE_ACP_REVIEWED_VERSION) return readiness("incompatible");
  if (evidence.preflight === "authentication_required") return readiness("authentication_required");
  return evidence.preflight === "passed" ? readiness("ready") : readiness("unavailable");
}

function readiness(state: OpenCodeAcpReadinessState): OpenCodeAcpReadiness {
  const action = state === "ready"
    ? null
    : state === "missing"
      ? "Install the reviewed OpenCode runtime on this paired desktop, then retry."
      : state === "incompatible"
        ? "Update OpenCode to the reviewed compatible release on this paired desktop, then retry."
        : state === "authentication_required"
          ? "Configure OpenCode through its native local setup, then retry."
          : "OpenCode is unavailable on this paired desktop. Verify its native local setup, then retry.";
  return Object.freeze({ state, action });
}
