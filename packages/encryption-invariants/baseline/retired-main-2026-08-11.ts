import type { RetiredFrozenDebt } from "../src/registry";

const DTO_SOURCE_EVIDENCE =
  "packages/encryption-invariants/tests/integration/dto-inventory-actual-source.test.ts";
const SSE_CONSUMER_EVIDENCE =
  "packages/encryption-invariants/tests/integration/dto-sse-consumer-evidence.test.ts";

/**
 * Wave 0 observations removed by later, source-reviewed contract narrowing.
 * Their original debt rows remain in the immutable snapshot as audit history.
 */
export const RETIRED_MAIN_2026_08_11_FROZEN_DEBT:
readonly RetiredFrozenDebt[] = [
  {
    debtId: "debt.wire.arbitrary.1i929r8",
    reason:
      "The task transcript response no longer exposes an untyped tool-call args leaf at this legacy path; current response fields remain inventoried independently.",
    testEvidence: [DTO_SOURCE_EVIDENCE],
  },
  {
    debtId: "debt.wire.arbitrary.1kzccij",
    reason:
      "The accepted live-session response no longer exposes the legacy untyped code leaf; the current response contract remains inventoried independently.",
    testEvidence: [DTO_SOURCE_EVIDENCE],
  },
  {
    debtId: "debt.wire.arbitrary.qhezcj",
    reason:
      "The desktop soul.completed consumer now narrows the event payload structurally, so the former whole-payload arbitrary observation no longer exists.",
    testEvidence: [DTO_SOURCE_EVIDENCE, SSE_CONSUMER_EVIDENCE],
  },
  {
    debtId: "debt.wire.arbitrary.tktu68",
    reason:
      "The desktop soul.delta consumer now narrows the event payload structurally, so the former whole-payload arbitrary observation no longer exists.",
    testEvidence: [DTO_SOURCE_EVIDENCE, SSE_CONSUMER_EVIDENCE],
  },
  {
    debtId: "debt.wire.arbitrary.17lxlko",
    reason:
      "The desktop soul.error consumer now narrows the event payload structurally, so the former whole-payload arbitrary observation no longer exists.",
    testEvidence: [DTO_SOURCE_EVIDENCE, SSE_CONSUMER_EVIDENCE],
  },
];
