import { randomUUID } from "node:crypto";
import {
  HERMES_ACP_HARNESS_ID,
  HERMES_ACP_REVIEWED_VERSION,
  OPENCODE_ACP_HARNESS_ID,
  OPENCODE_ACP_REVIEWED_VERSION,
  type HermesAcpHostReadinessEvidence,
  type HermesAcpReadinessResolver,
  type OpenCodeAcpHostReadinessEvidence,
  type OpenCodeAcpReadinessResolver,
} from "@nautilo/acp-host";
import type { AcpReadinessState, AcpRegistrationId } from "@nautilo/relay";

export interface AcpReadinessRelayPort {
  requestAcpReadiness(input: {
    relayId: string;
    userId: string;
    requestId: string;
    registrationId: AcpRegistrationId;
    timeoutMs?: number;
  }): Promise<AcpReadinessState>;
}

export class OpenCodeAcpRelayReadinessResolver implements OpenCodeAcpReadinessResolver {
  constructor(
    private readonly relay: AcpReadinessRelayPort,
    private readonly target: AcpReadinessTarget,
    private readonly mintRequestId: () => string = randomUUID,
  ) {}

  async inspect(): Promise<OpenCodeAcpHostReadinessEvidence> {
    const state = await this.relay.requestAcpReadiness({
      relayId: this.target.relayId,
      userId: this.target.userId,
      requestId: this.mintRequestId(),
      registrationId: OPENCODE_ACP_HARNESS_ID,
    });
    if (state === "missing") return { executableBasename: "opencode", versionOutput: null, preflight: "missing" };
    if (state === "incompatible") return { executableBasename: "opencode", versionOutput: new TextEncoder().encode("incompatible"), preflight: "unavailable" };
    const versionOutput = new TextEncoder().encode(OPENCODE_ACP_REVIEWED_VERSION);
    if (state === "authentication_required") return { executableBasename: "opencode", versionOutput, preflight: "authentication_required" };
    return { executableBasename: "opencode", versionOutput, preflight: state === "ready" ? "passed" : "unavailable" };
  }
}

/** Server-owned exact paired-host identity; it never contains a local path. */
export type AcpReadinessTarget = Readonly<{ relayId: string; userId: string }>;

/**
 * Builds the package-local readiness resolver from one authenticated relay
 * target. It deliberately maps the wire's fixed enum back into no-secret host
 * evidence, leaving the shared classifier as the single public-state owner.
 */
export class HermesAcpRelayReadinessResolver implements HermesAcpReadinessResolver {
  constructor(
    private readonly relay: AcpReadinessRelayPort,
    private readonly target: AcpReadinessTarget,
    private readonly mintRequestId: () => string = randomUUID,
  ) {}

  async inspect(): Promise<HermesAcpHostReadinessEvidence> {
    const state = await this.relay.requestAcpReadiness({
      relayId: this.target.relayId,
      userId: this.target.userId,
      requestId: this.mintRequestId(),
      registrationId: HERMES_ACP_HARNESS_ID,
    });
    return evidenceFor(state);
  }
}

function evidenceFor(state: AcpReadinessState): HermesAcpHostReadinessEvidence {
  if (state === "missing") return { executableBasename: "hermes", versionOutput: null, preflight: "missing" };
  if (state === "incompatible") return { executableBasename: "hermes", versionOutput: new TextEncoder().encode("incompatible"), preflight: "unavailable" };
  if (state === "authentication_required") return { executableBasename: "hermes", versionOutput: new TextEncoder().encode(HERMES_ACP_REVIEWED_VERSION), preflight: "authentication_required" };
  if (state === "ready") return { executableBasename: "hermes", versionOutput: new TextEncoder().encode(HERMES_ACP_REVIEWED_VERSION), preflight: "passed" };
  return { executableBasename: "hermes", versionOutput: new TextEncoder().encode(HERMES_ACP_REVIEWED_VERSION), preflight: "unavailable" };
}
