import {
  definePlatformCapabilities,
  FAIL_CLOSED_CAPABILITY_DECISIONS,
} from "./capability-contract";

// Non-Metro tools do not select .native/.web files. Their projection must be
// denied rather than accidentally inheriting native authority.
export const platformCapabilities = definePlatformCapabilities(
  "unknown",
  { ...FAIL_CLOSED_CAPABILITY_DECISIONS },
);
