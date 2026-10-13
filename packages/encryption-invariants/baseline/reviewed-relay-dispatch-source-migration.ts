import type { RetiredFrozenDebt, ReviewedDebtLink } from "../src/registry";

const EVIDENCE = [
  "packages/encryption-invariants/tests/integration/reviewed-relay-dispatch-source-migration-security.test.ts",
] as const;

/**
 * Relay dispatch refactor split the monolithic Desktop relay into fixed dispatch modules. These
 * are exact current representations of the two frozen plaintext boundaries;
 * they inherit their release impact rather than creating new baseline debt.
 */
export const REVIEWED_RELAY_DISPATCH_SOURCE_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    id: "source.relay-dispatch.desktop-browser-capture-temporaries",
    surface: "file",
    locator: "apps/desktop/electron/relay.ts#browser-capture-temporary-roots",
    owner: "apps/desktop",
    targetDebtIds: ["debt.source.file.desktop-capture-temporaries"],
    reason: "Relay dispatch refactor retains the former Desktop capture-temporary plaintext boundary for browser screenshots at its exact remaining relay coordinate; the refactor neither encrypts those bytes nor weakens the frozen debt's product-claim impact.",
    testEvidence: EVIDENCE,
  },
  {
    id: "source.relay-dispatch.desktop-media-extract-temporaries",
    surface: "file",
    locator:
      "apps/desktop/electron/relay-dispatch/media.ts#media-extract-temporary-roots",
    owner: "apps/desktop",
    targetDebtIds: ["debt.source.file.desktop-capture-temporaries"],
    reason: "Relay dispatch refactor relocates the former Desktop capture-temporary plaintext boundary for media extraction into the fixed media dispatcher; the refactor neither encrypts those bytes nor weakens the frozen debt's product-claim impact.",
    testEvidence: EVIDENCE,
  },
  {
    id: "source.relay-dispatch.desktop-relay-dispatch",
    surface: "processor",
    locator:
      "apps/desktop/electron/relay-dispatch/router.ts#createFixedDesktopDispatchRouter",
    owner: "apps/desktop",
    targetDebtIds: ["debt.source.processor.desktop-relay"],
    reason: "Relay dispatch refactor moves the same Electron-local plaintext processing boundary from the monolithic relay dispatcher to the fixed ordered dispatch router; modular ownership and routing changed, not encryption coverage or the frozen debt's product-claim impact.",
    testEvidence: EVIDENCE,
  },
];

export const RETIRED_RELAY_DISPATCH_SOURCE_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] = [
  {
    debtId: "debt.source.file.desktop-capture-temporaries",
    reason: "Relay dispatch refactor split the old monolithic relay locator into separately inspected browser-capture and media-extraction temporary boundaries, each explicitly linked to this immutable frozen file debt row.",
    testEvidence: EVIDENCE,
  },
  {
    debtId: "debt.source.processor.desktop-relay",
    reason: "Relay dispatch refactor replaced the monolithic relay-dispatch coordinate with the fixed ordered dispatch router, which is explicitly linked to this immutable frozen processor debt row.",
    testEvidence: EVIDENCE,
  },
];
