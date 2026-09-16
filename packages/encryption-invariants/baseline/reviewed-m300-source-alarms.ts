import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/**
 * M300 moves the Browser foreground-Shadow composition into the shared client
 * package and adds two earlier Electron log calls. The scanner locator includes
 * a same-signature occurrence ordinal, so every reused ordinal whose semantic
 * callsite changed must be retired before its exact replacement is reviewed.
 */
export const SUPERSEDED_M300_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/main.ts#log_emitter:52de83cd17db4dc1:1",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:3",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:4",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:13",
  "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:1",
  "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:2",
  "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:3",
  "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:02d6d32a757bab9d:4",
  "packages/lattice-bridge/src/client/browser/index.ts#log_emitter:c4f22f3fb6bab4a7:1",
]);

const RELOCATED_DESKTOP_DEBT: readonly SourceAlarmReview[] = [
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:52de83cd17db4dc1:2",
    debtId: "debt.source-alarm.log.log_emitter.3985c5e8c2acde25",
    surface: "log",
    owner: "apps/desktop",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      "apps/desktop/electron/main.ts#log_emitter:52de83cd17db4dc1:2 is the relocated reviewed log-emitter alarm for an embedded-browser external-link diagnostic; its URL and structured-field payload classification remains untriaged.",
    evidenceGap:
      "apps/desktop/electron/main.ts#log_emitter:52de83cd17db4dc1:2 lacks executable evidence proving that every URL component and structured field is safe for this log-emitter alarm.",
  },
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:13",
    debtId: "debt.source-alarm.log.log_emitter.cb782bc859988c15",
    surface: "log",
    owner: "apps/desktop",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:13 is the relocated reviewed log-emitter alarm for rejected notification-settings recovery; its dynamic diagnostic classification remains untriaged.",
    evidenceGap:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:13 lacks executable evidence proving every structured field is content-free for this log-emitter alarm.",
  },
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:14",
    debtId: "debt.source-alarm.log.log_emitter.721443115c7cc225",
    surface: "log",
    owner: "apps/desktop",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:14 is the relocated reviewed log-emitter alarm for a rejected notification-dock update; its structured diagnostic classification remains untriaged.",
    evidenceGap:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:14 lacks executable evidence proving every structured field is content-free for this log-emitter alarm.",
  },
];

export const REVIEWED_M300_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  ...RELOCATED_DESKTOP_DEBT,
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:52de83cd17db4dc1:1",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.m300.desktop-foreground-shadow-receive-result",
    reason:
      "This exact foreground-Shadow receive diagnostic emits only a closed event kind/type, result status/reason, and checkpoint code. Message plaintext, protected bytes, keys, grants, credentials, identifiers, and exceptions are absent.",
  },
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:3",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.m300.desktop-foreground-shadow-disposal",
    reason:
      "This exact foreground-Shadow disposal diagnostic emits only the numeric Electron sender ID and an exception type name. It excludes Message plaintext, protected bytes, Namespace material, grants, credentials, paths, and exception text.",
  },
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:4",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.m300.desktop-foreground-shadow-history-ack",
    reason:
      "This exact history-acknowledgement diagnostic emits only an exception type name. It excludes history plaintext, protected bytes, Message identifiers, Namespace material, grants, credentials, paths, and exception text.",
  },
  {
    locator:
      "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:15",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.m300.relocated-navigation-guard",
    reason:
      "This relocated navigation-guard warning emits a fixed failure label plus the configured server endpoint already classified by the existing Desktop connection boundary. It emits no Human content, key, token, ciphertext, prompt, or captured Desktop content.",
  },
  ...[
    "packages/lattice-bridge/src/client/message/foreground-shadow-client-composition.ts#log_emitter:c4f22f3fb6bab4a7:1",
    "packages/lattice-bridge/src/client/message/foreground-shadow-client-composition.ts#log_emitter:c4f22f3fb6bab4a7:2",
  ].map((locator, index) => ({
    locator,
    owner: "packages/lattice-bridge",
    closure: "declaration" as const,
    declarationId: `source.m300.shared-foreground-shadow-unavailable-${index + 1}`,
    reason:
      "This shared foreground-Shadow warning interpolates only closed stage and reason codes. It emits no Message content, ciphertext, envelope, manifest, identifier, credential, private key, grant, or provider response.",
  })),
  {
    locator:
      "packages/lattice-bridge/src/client/message/foreground-shadow-client-composition.ts#log_emitter:02d6d32a757bab9d:1",
    owner: "packages/lattice-bridge",
    closure: "declaration",
    declarationId: "source.m300.shared-foreground-shadow-verification-retry",
    reason:
      "This shared foreground-verification warning emits only the client-kind label, bounded retry count, opaque operation ID, and closed retry/exhausted status. It emits no Message content, ciphertext, key, grant, credential, prompt, or exception.",
  },
];
