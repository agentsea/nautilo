import type {
  HarnessCapability,
  HarnessCapabilityState,
  HarnessDescriptor,
  HarnessDriver,
  HarnessExecution,
  HarnessRegistration,
} from "@nautilo/runtime";
import {
  HERMES_ACP_HARNESS_ID,
  HermesAcpReadinessError,
  OPENCODE_ACP_HARNESS_ID,
  classifyHermesAcpReadiness,
  type HermesAcpReadinessResolver,
} from "@nautilo/acp-host";

/** Product facts are server composition, not Electron-host implementation. */
export const HERMES_ACP_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: HERMES_ACP_HARNESS_ID,
  displayName: "Hermes",
  setup: Object.freeze({ installation: "manual", activation: "user_initiated" }),
  integration: Object.freeze({ authentication: "existing_session", resume: "new_session_only" }),
  declaredCapabilities: Object.freeze({
    execution: "supported",
    resume: "unsupported",
    stop: "unsupported",
    steer: "unsupported",
    requests: "unsupported",
  }),
});

export const OPENCODE_ACP_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: OPENCODE_ACP_HARNESS_ID,
  displayName: "OpenCode",
  setup: Object.freeze({ installation: "manual", activation: "user_initiated" }),
  integration: Object.freeze({ authentication: "existing_session", resume: "new_session_only" }),
  declaredCapabilities: Object.freeze({
    execution: "supported",
    resume: "unsupported",
    stop: "unsupported",
    steer: "unsupported",
    requests: "unsupported",
  }),
});

/** Provided only by the later canonical execution composition. */
export interface HermesAcpRegistrationPorts {
  readonly readiness: HermesAcpReadinessResolver;
  readonly createExecution: () => Promise<HarnessExecution> | HarnessExecution;
}

/** Thin runtime wrapper; no host, process, or ACP data is retained here. */
class AcpHarnessDriver implements HarnessDriver {
  /** Hermes exposes exactly its admitted turn starter. It never forwards an
   * adapter's optional control/request facets into Nautilo's harness plane. */
  readonly execution: HarnessExecution;

  constructor(execution: HarnessExecution) {
    this.execution = Object.freeze({ start: execution.start.bind(execution) });
  }

  probeCapabilities(): Promise<Readonly<Partial<Record<HarnessCapability, HarnessCapabilityState>>>> {
    return Promise.resolve({
      execution: "supported",
      resume: "unsupported",
      stop: "unsupported",
      steer: "unsupported",
      requests: "unsupported",
    });
  }
}

/** Exact selection/readiness only; it is not added to the Task router until 4.2. */
export function createHermesAcpHarnessRegistration(ports: HermesAcpRegistrationPorts): HarnessRegistration {
  return {
    descriptor: HERMES_ACP_HARNESS_DESCRIPTOR,
    createDriver: async () => {
      const readiness = classifyHermesAcpReadiness(await ports.readiness.inspect());
      if (readiness.state !== "ready") throw new HermesAcpReadinessError(readiness.state);
      return new AcpHarnessDriver(await ports.createExecution());
    },
  };
}
