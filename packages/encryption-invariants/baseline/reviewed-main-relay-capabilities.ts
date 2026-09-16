import type { EncryptionCoverageEntry } from "../src/model";

const RELAY_CAPABILITY_EVIDENCE = [
  "packages/relay/tests/unit/client-capability-update.test.ts",
  "packages/server/tests/unit/relay-endpoint-auth.test.ts",
] as const;

const LOCATORS = [
  "relay:client_to_server:relay:register#capabilitiesByProtocolVersion",
  "relay:client_to_server_arbitrary:packages/relay/src/protocol.ts#RelayRegisterMessage#capabilitiesByProtocolVersion",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage#capabilitiesByProtocolVersion",
] as const;

/**
 * Relay registration advertises only the closed capability schema supported
 * for each protocol version. The map is negotiation metadata, not user data.
 */
export const REVIEWED_MAIN_RELAY_CAPABILITY_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = LOCATORS.map((locator, index) => ({
    id: `wire.main.relay-capabilities-by-protocol-version.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/relay",
    readers: ["packages/server/src/realtime/relay-endpoint.ts"],
    writers: ["packages/relay/src/client.ts"],
    migrationState: "not_applicable",
    retention:
      "Used transiently during Relay registration and retained only in the live connection state.",
    testEvidence: [...RELAY_CAPABILITY_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: ["capabilities_by_protocol_version"],
    plaintextReason:
      "The value maps bounded protocol-version identifiers to the already reviewed closed Relay capability schema; it contains no user-authored content, credential, or key material.",
  }));
