import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator:
      "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:468c68ed4723a1f2:16",
    owner: "bin/nautilo-dev",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.main-2026-09-04.openconnector-health-wait",
    reason:
      "The developer-only failure log contains only a fixed OpenConnector health-wait label plus a loopback 127.0.0.1 URL, HTTP status or transport class, and timeout; it excludes Human content, credentials, headers, response bodies, and remote URLs.",
  },
  {
    locator:
      "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:11",
    owner: "bin/nautilo-dev",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.main-2026-09-04.openconnector-start-url",
    reason:
      "The developer-only success log contains only the fixed OpenConnector label and its generated loopback 127.0.0.1 health URL and configured port; it excludes Human content, credentials, headers, query strings, and remote URLs.",
  },
  {
    locator:
      "bin/nautilo-dev/src/commands/infra-status.ts#log_emitter:6eab313eca52a747:3",
    owner: "bin/nautilo-dev",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.main-2026-09-04.openconnector-health-status",
    reason:
      "The developer-only status log contains only a fixed OpenConnector /health label, an HTTP status or unreachable marker, and the configured local port; it excludes Human content, credentials, response bodies, and remote endpoints.",
  },
];
