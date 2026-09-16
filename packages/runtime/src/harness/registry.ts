import {
  HarnessControlPlaneError,
  type HarnessCapability,
  type HarnessCapabilitySnapshot,
  type HarnessCapabilityState,
  type HarnessDescriptor,
  type HarnessDriver,
  type HarnessOperation,
  type HarnessRegistration,
} from "./types";

const CAPABILITIES: readonly HarnessCapability[] = [
  "execution",
  "resume",
  "stop",
  "steer",
  "requests",
];

const OPERATION_CAPABILITIES: Readonly<Record<HarnessOperation, HarnessCapability>> = {
  start: "execution",
  resume: "resume",
  stop: "stop",
  steer: "steer",
  respond_to_request: "requests",
};

/**
 * Collision-safe descriptor registry with lazy, single-flight driver creation.
 * Factories are not executed during construction, so a broken optional harness
 * cannot prevent other harnesses from being selected.
 */
export class HarnessControlPlane {
  private readonly registrations = new Map<string, HarnessRegistration>();
  private readonly drivers = new Map<string, HarnessDriver>();
  private readonly pendingDrivers = new Map<string, Promise<HarnessDriver>>();

  constructor(registrations: readonly HarnessRegistration[]) {
    for (const registration of registrations) {
      const id = registration.descriptor.id;
      if (this.registrations.has(id)) {
        throw new HarnessControlPlaneError({
          code: "harness_duplicate_id",
          harnessId: id,
          message: `Harness id "${id}" is registered more than once.`,
        });
      }
      this.registrations.set(id, registration);
    }
  }

  listDescriptors(): readonly HarnessDescriptor[] {
    return Object.freeze([...this.registrations.values()].map(({ descriptor }) => descriptor));
  }

  describe(harnessId: string): HarnessDescriptor {
    return this.registrationFor(harnessId).descriptor;
  }

  async driverFor(harnessId: string): Promise<HarnessDriver> {
    const existing = this.drivers.get(harnessId);
    if (existing) return existing;

    const pending = this.pendingDrivers.get(harnessId);
    if (pending) return pending;

    const registration = this.registrationFor(harnessId);
    const creating = this.createDriver(registration);
    this.pendingDrivers.set(harnessId, creating);

    try {
      const driver = await creating;
      this.drivers.set(harnessId, driver);
      return driver;
    } finally {
      this.pendingDrivers.delete(harnessId);
    }
  }

  async capabilitySnapshot(harnessId: string): Promise<HarnessCapabilitySnapshot> {
    const descriptor = this.describe(harnessId);
    const driver = await this.driverFor(harnessId);
    let probed: Readonly<Partial<Record<HarnessCapability, HarnessCapabilityState>>> = {};

    if (driver.probeCapabilities) {
      try {
        probed = await driver.probeCapabilities();
      } catch (cause) {
        throw new HarnessControlPlaneError({
          code: "harness_factory_failed",
          harnessId,
          message: `Harness "${harnessId}" could not probe its capabilities.`,
          cause,
        });
      }
    }

    const snapshot = {} as Record<HarnessCapability, { declared: HarnessCapabilityState; probed: HarnessCapabilityState }>;
    for (const capability of CAPABILITIES) {
      snapshot[capability] = {
        declared: descriptor.declaredCapabilities[capability],
        probed: probed[capability] ?? "unknown",
      };
    }
    return Object.freeze(snapshot);
  }

  async requireCapability(
    harnessId: string,
    capability: HarnessCapability,
  ): Promise<HarnessDriver> {
    const declared = this.describe(harnessId).declaredCapabilities[capability];
    if (declared === "unsupported") {
      throw new HarnessControlPlaneError({
        code: "harness_capability_unsupported",
        harnessId,
        capability,
        message: `Harness "${harnessId}" does not support "${capability}".`,
      });
    }

    const snapshot = await this.capabilitySnapshot(harnessId);
    const status = snapshot[capability];

    if (status.probed === "unsupported") {
      throw new HarnessControlPlaneError({
        code: "harness_capability_unsupported",
        harnessId,
        capability,
        message: `Harness "${harnessId}" does not support "${capability}".`,
      });
    }
    if (status.declared !== "supported" || status.probed !== "supported") {
      throw new HarnessControlPlaneError({
        code: "harness_capability_unknown",
        harnessId,
        capability,
        message: `Harness "${harnessId}" has not confirmed "${capability}".`,
      });
    }

    return this.driverFor(harnessId);
  }

  async requireOperation(harnessId: string, operation: HarnessOperation): Promise<HarnessDriver> {
    const driver = await this.requireCapability(harnessId, OPERATION_CAPABILITIES[operation]);
    if (hasOperation(driver, operation)) return driver;

    throw new HarnessControlPlaneError({
      code: "harness_operation_unsupported",
      harnessId,
      capability: OPERATION_CAPABILITIES[operation],
      operation,
      message: `Harness "${harnessId}" does not implement "${operation}".`,
    });
  }

  private registrationFor(harnessId: string): HarnessRegistration {
    const registration = this.registrations.get(harnessId);
    if (registration) return registration;

    throw new HarnessControlPlaneError({
      code: "harness_unknown_id",
      harnessId,
      message: `Harness "${harnessId}" is not registered.`,
    });
  }

  private async createDriver(registration: HarnessRegistration): Promise<HarnessDriver> {
    const harnessId = registration.descriptor.id;
    try {
      const driver = await registration.createDriver();
      if (!driver || !driver.execution || typeof driver.execution.start !== "function") {
        throw new HarnessControlPlaneError({
          code: "harness_invalid_driver",
          harnessId,
          message: `Harness "${harnessId}" did not provide the required execution facet.`,
        });
      }
      return driver;
    } catch (cause) {
      if (cause instanceof HarnessControlPlaneError) throw cause;
      throw new HarnessControlPlaneError({
        code: "harness_factory_failed",
        harnessId,
        message: `Harness "${harnessId}" could not be initialized.`,
        cause,
      });
    }
  }
}

function hasOperation(driver: HarnessDriver, operation: HarnessOperation): boolean {
  switch (operation) {
    case "start":
      return typeof driver.execution.start === "function";
    case "resume":
      return typeof driver.execution.resume === "function";
    case "stop":
      return typeof driver.execution.stop === "function";
    case "steer":
      return typeof driver.execution.steer === "function";
    case "respond_to_request":
      return typeof driver.execution.respond === "function";
  }
}
