export const HERMES_ACP_HARNESS_ID = "hermes-acp";
export const HERMES_ACP_REVIEWED_VERSION = "0.20.4";
export const HERMES_ACP_VERSION_OUTPUT_MAX_BYTES = 4 * 1024;

export type HermesAcpReadinessState =
  | "ready"
  | "missing"
  | "incompatible"
  | "authentication_required"
  | "unavailable";

/**
 * This is the only Electron-to-server readiness result.  Its action is fixed
 * product copy; native configuration and credential values remain local to
 * Hermes and never enter this object.
 */
export type HermesAcpReadiness = Readonly<{
  state: HermesAcpReadinessState;
  action: string | null;
}>;

/**
 * Electron produces this after it has run only the reviewed static probes.
 * The shape intentionally cannot carry an executable path, stdout/stderr,
 * environment, config-home, account, provider, or credential material.
 */
export type HermesAcpHostReadinessEvidence = Readonly<{
  executableBasename: "hermes";
  versionOutput: Uint8Array | null;
  preflight: "passed" | "authentication_required" | "missing" | "unavailable";
}>;

/** Electron-owned port; listing descriptors must never invoke it. */
export interface HermesAcpReadinessResolver {
  inspect(): Promise<HermesAcpHostReadinessEvidence>;
}

export class HermesAcpReadinessError extends Error {
  constructor(readonly state: Exclude<HermesAcpReadinessState, "ready">) {
    super(state);
    this.name = "HermesAcpReadinessError";
  }
}

/**
 * Accept one bounded, exact native version result.  The Electron resolver is
 * responsible for process execution; this helper neither launches a command
 * nor keeps raw output after classification.
 */
export function parseHermesAcpVersionOutput(output: Uint8Array): typeof HERMES_ACP_REVIEWED_VERSION | null {
  if (output.byteLength === 0 || output.byteLength > HERMES_ACP_VERSION_OUTPUT_MAX_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return null;
  }
  return text === HERMES_ACP_REVIEWED_VERSION || text === `${HERMES_ACP_REVIEWED_VERSION}\n`
    ? HERMES_ACP_REVIEWED_VERSION
    : null;
}

/**
 * Collapse host-local probe evidence to a safe, actionable public state.
 * A malformed or contradictory result is unavailable rather than a guessed
 * installation, version, or authentication conclusion.
 */
export function classifyHermesAcpReadiness(
  evidence: HermesAcpHostReadinessEvidence,
): HermesAcpReadiness {
  if (evidence.executableBasename !== "hermes") return readiness("unavailable");
  if (evidence.preflight === "missing") return readiness("missing");
  const version = evidence.versionOutput === null ? null : parseHermesAcpVersionOutput(evidence.versionOutput);
  if (version !== HERMES_ACP_REVIEWED_VERSION) return readiness("incompatible");
  if (evidence.preflight === "authentication_required") return readiness("authentication_required");
  return evidence.preflight === "passed" ? readiness("ready") : readiness("unavailable");
}

function readiness(state: HermesAcpReadinessState): HermesAcpReadiness {
  const action = state === "ready"
    ? null
    : state === "missing"
      ? "Install the reviewed Hermes runtime on this paired desktop, then retry."
      : state === "incompatible"
        ? "Update Hermes to the reviewed compatible release on this paired desktop, then retry."
        : state === "authentication_required"
          ? "Sign in to Hermes through its native local setup, then retry."
          : "Hermes is unavailable on this paired desktop. Verify its native local setup, then retry.";
  return Object.freeze({ state, action });
}
