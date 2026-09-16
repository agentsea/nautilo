import type {
  HarnessCapability,
  HarnessCapabilityState,
  HarnessDescriptor,
  HarnessDriver,
  HarnessExecution,
  HarnessRegistration,
} from "@nautilo/runtime";

export const CODEX_HARNESS_ID = "codex";

/**
 * Import-safe product facts. Protocol, relay, host, and persistence details
 * stay in the Codex composition that supplies the ports below.
 */
export const CODEX_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: CODEX_HARNESS_ID,
  displayName: "Codex",
  setup: Object.freeze({ installation: "on_demand", activation: "user_initiated" }),
  integration: Object.freeze({
    authentication: "existing_session",
    resume: "runtime_decides",
  }),
  declaredCapabilities: Object.freeze({
    execution: "supported",
    resume: "unknown",
    stop: "unknown",
    steer: "supported",
    requests: "supported",
  }),
});

/**
 * The only seam Task 3.2 composes. A later Codex-specific adapter may supply
 * these ports, but it may not leak relay or app-server wire values above this
 * driver boundary.
 */
export interface CodexHarnessPorts {
  readonly execution: HarnessExecution;
  readonly probeCapabilities?: () => Promise<
    Readonly<Partial<Record<HarnessCapability, HarnessCapabilityState>>>
  >;
}

/** A thin, provider-owned implementation of the generic runtime contract. */
class CodexHarnessDriver implements HarnessDriver {
  readonly execution: HarnessExecution;
  private readonly probe: CodexHarnessPorts["probeCapabilities"];

  constructor(ports: CodexHarnessPorts) {
    this.execution = ports.execution;
    this.probe = ports.probeCapabilities;
  }

  async probeCapabilities(): Promise<
    Readonly<Partial<Record<HarnessCapability, HarnessCapabilityState>>>
  > {
    const reported = await this.probe?.();
    const requests = typeof this.execution.respond === "function"
      ? reported?.requests ?? "supported"
      : "unsupported";
    const steer = typeof this.execution.steer === "function"
      ? reported?.steer ?? "supported"
      : "unsupported";
    return {
      ...reported,
      execution: reported?.execution ?? "supported",
      // A probe may downgrade a real response path, but it cannot claim a
      // capability that the injected execution facet does not implement.
      requests,
      steer,
    };
  }
}

export function createCodexHarnessRegistration(
  ports: CodexHarnessPorts,
): HarnessRegistration {
  return {
    descriptor: CODEX_HARNESS_DESCRIPTOR,
    createDriver: () => new CodexHarnessDriver(ports),
  };
}
