import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact closure for Wave 14's authenticated opaque bootstrap delivery. */
export const REVIEWED_WAVE_14_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    {
      locator:
        "packages/lattice-bridge/src/server/delivery/postgres-human-memory-access-namespace-provisioning-port.ts#network_processor:b84635f56d5d4fce:1",
      owner: "packages/lattice-bridge",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.wave14.namespace-bootstrap-delivery-fetch",
      reason:
        "The network processor is only the read side of the already-declared protected bootstrap storage boundary: it accepts signed, bounded, opaque artifacts, authenticates their exact operation, device, expiry, and replay coordinates, and exposes no plaintext content or key material to the server.",
    },
  ];
