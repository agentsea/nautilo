import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** D565 retired these coordinates; later main work introduced new calls there. */
export const REINTRODUCED_D565_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:3",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:4",
]);

export const REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator:
      "apps/desktop/electron/local-file-history/relay-rebind.ts#filesystem_write:fb03010006f1394a:1",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.main-2026-09-05.desktop-local-history-relay-rebind-backup",
    reason:
      "This one-time compatibility backup copies the already-declared Desktop local-history manifest beside that store before changing only its relay identity. It creates no second semantic persistence boundary; the manifest's existing plaintext-at-rest status remains explicit in source.file.desktop-local-history.",
  },
  ...[
    "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:3",
    "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:4",
    "apps/desktop/electron/relay.ts#log_emitter:50ac6ad92ba162f7:1",
    "bin/nautilo-server/src/index.ts#log_emitter:0ae25e725db4e950:5",
  ].map((locator, index) => ({
    locator,
    owner: locator.split("/", 2).join("/"),
    closure: "declaration" as const,
    declarationId: `source.main-2026-09-05.existing-generic-log-${index + 1}`,
    reason:
      "This exact lifecycle call writes through Nautilo's already-declared generic plaintext log boundary. It does not create a separate log destination, and its current path, relay identity, or sanitized failure metadata remains covered by source.log.generic rather than being mislabeled as encrypted.",
  })),
  {
    locator:
      "packages/catalog/src/tool-catalog.ts#log_emitter:7ef703451e44cded:3",
    owner: "packages/catalog",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.main-2026-09-05.tool-catalog-validation-count",
    reason:
      "This exact successful validation diagnostic emits only a fixed Tool Catalog label and the integer number of registered tools. It emits no tool name, description, schema, Human content, prompt, key, grant, credential, ciphertext, or exception text.",
  },
];
