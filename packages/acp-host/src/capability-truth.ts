export type AcpCapabilityTruth = Readonly<{
  execution: "supported";
  requests: "supported";
  stop: "unknown";
  resume: "unsupported";
  steer: "unsupported";
}>;

const validated = new WeakSet<AcpCapabilityTruth>();

/** Internal adapter seam: package consumers receive this only via onNegotiated. */
export function validateAcpInitializeCapabilityTruth(initialize: unknown): AcpCapabilityTruth {
  if (typeof initialize !== "object" || initialize === null || Array.isArray(initialize)) {
    throw new TypeError("initialize response must be an object");
  }
  const value = initialize as Record<string, unknown>;
  if (value["protocolVersion"] !== 1) throw new TypeError("ACP protocol version is unsupported");
  const advertised = value["agentCapabilities"];
  if (advertised !== undefined && advertised !== null) {
    if (typeof advertised !== "object" || Array.isArray(advertised)) {
      throw new TypeError("agent capabilities must be an object");
    }
    const capabilities = advertised as Record<string, unknown>;
    if (capabilities["loadSession"] !== undefined && typeof capabilities["loadSession"] !== "boolean") {
      throw new TypeError("ACP load-session capability is invalid");
    }
    const prompt = capabilities["promptCapabilities"];
    if (prompt !== undefined && (typeof prompt !== "object" || prompt === null || Array.isArray(prompt))) {
      throw new TypeError("ACP prompt capabilities are invalid");
    }
  }
  const truth: AcpCapabilityTruth = Object.freeze({
    execution: "supported",
    requests: "supported",
    stop: "unknown",
    resume: "unsupported",
    steer: "unsupported",
  });
  validated.add(truth);
  return truth;
}

export function isValidatedAcpCapabilityTruth(value: AcpCapabilityTruth): boolean {
  return validated.has(value);
}
