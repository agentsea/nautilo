import type { EncryptionCoverageEntry } from "../src/model";
import type { RetiredFrozenDebt, ReviewedDebtLink } from "../src/registry";

const RELAY_TEST_EVIDENCE = [
  "packages/relay/tests/unit/client-send.test.ts",
  "apps/desktop/tests/unit-isolated/computer-use-relay-splice.test.ts",
] as const;

export const SUPERSEDED_MAIN_2026_08_31_COVERAGE_LOCATORS = new Set<string>([
  "packages/agent/src/utils/chat-model-invocation.ts#invokeModelWithFirstTokenTimeout",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding#supportedActions[]",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBindingValidationResult",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBindingValidationResult#binding.supportedActions[]",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#desktopAutomationBinding.supportedActions[]",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#desktopAutomationBinding.supportedActions[]",
  "relay:server_to_client:relay:dispatch#desktopAutomationBinding.supportedActions[]",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#desktopAutomationBinding.supportedActions[]",
]);

const CONTRACT_LOCATORS = [
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#ComputerUseHostDispatchRequest#contract",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#computerUseRequest.contract",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#computerUseRequest.contract",
  "relay:server_to_client:relay:dispatch#computerUseRequest.contract",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#computerUseRequest.contract",
] as const;

export const REVIEWED_MAIN_2026_08_31_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = CONTRACT_LOCATORS.map((locator, index) => ({
    id: `wire.main-2026-08-31.computer-use-contract.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/relay",
    readers: ["apps/desktop/electron/computer-use-relay-splice.ts"],
    writers: ["packages/relay/src/client.ts"],
    migrationState: "not_applicable",
    retention: "Request-scoped relay metadata; the exact Host contract is discarded after the bounded Computer Use dispatch completes.",
    testEvidence: RELAY_TEST_EVIDENCE,
    classification: "bounded_metadata",
    metadataAllowlist: [
      "contract schema version",
      "action identifier",
      "closed argument schema",
      "bounded timeout and capability metadata",
    ],
    plaintextReason: "The signed public Host contract contains only executable capability metadata; Human-supplied action arguments are inventoried separately as existing plaintext relay debt.",
  }));

const ARGUMENT_DEBT_LINKS = [
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#ComputerUseHostDispatchRequest",
    "debt.wire.arbitrary.1ezwf46",
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#ComputerUseHostDispatchRequest#arguments",
    "debt.wire.arbitrary.1ezwf46",
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#computerUseRequest.arguments",
    "debt.wire.arbitrary.1ezwf46",
  ],
  [
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#computerUseRequest.arguments",
    "debt.wire.arbitrary.10l7ijx",
  ],
  [
    "relay:server_to_client:relay:dispatch#computerUseRequest.arguments",
    "debt.wire.arbitrary.1ctmkbq",
  ],
  [
    "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#computerUseRequest.arguments",
    "debt.wire.arbitrary.18ha82p",
  ],
] as const;

export const REVIEWED_MAIN_2026_08_31_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
  ...ARGUMENT_DEBT_LINKS.map(([locator, targetDebtId], index) => ({
    id: `wire.main-2026-08-31.computer-use-arguments.${index + 1}`,
    surface: "wire" as const,
    locator,
    owner: "packages/relay",
    targetDebtIds: [targetDebtId],
    reason: "The Computer Use Host request projects the same Human-supplied plaintext tool-argument class already frozen at the enclosing relay dispatch boundary; the new typed envelope does not create a different content class or protected transport.",
    testEvidence: RELAY_TEST_EVIDENCE,
  })),
  {
    id: "processor.main-2026-08-31.chat-model-supervisor-move",
    surface: "processor",
    locator: "packages/agent/src/utils/chat-model-invocation.ts#invokeModelWithAttemptSupervisor",
    owner: "packages/agent",
    targetDebtIds: ["debt.source.processor.chat-model-invocation"],
    reason: "The attempt supervisor is the renamed and strengthened owner of the same model.invoke plaintext processor boundary; timeout and retry supervision changed, but the provider payload class did not.",
    testEvidence: ["packages/agent/tests/unit/chat-model-invocation.test.ts"],
  },
];

export const RETIRED_MAIN_2026_08_31_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] = [{
    debtId: "debt.source.processor.chat-model-invocation",
    reason: "The old first-token-timeout symbol was replaced by invokeModelWithAttemptSupervisor; the exact current locator is linked back to this immutable processor debt row.",
    testEvidence: ["packages/agent/tests/unit/chat-model-invocation.test.ts"],
  }];
