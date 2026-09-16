import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_M240_SOURCE_ALARM_LOCATORS: ReadonlySet<string> =
  new Set([
    "apps/desktop/electron/chat-notifications.ts#notification_emitter:ecf277d9f1136214:1",
    "apps/desktop/electron/main.ts#notification_emitter:731e4ca92ce74b84:1",
    "apps/workbench/src/notifications/notification-state-context.tsx#notification_emitter:47e8b6e75f62b6ac:1",
    "packages/api-client/src/client.ts#network_processor:df218c3c4914a3fb:1",
    "packages/api-client/src/client.ts#network_processor:0c21946ad1dcd5e6:1",
  ]);

const DECLARATION_LOCATORS = [
  "apps/desktop/electron/chat-notifications.ts#notification_emitter:4beabdaa110922f1:1",
  "apps/desktop/electron/main.ts#notification_emitter:46498b4d7cb14a54:1",
  "apps/workbench/src/notifications/notification-state-context.tsx#notification_emitter:ef0a7e600ff917dc:1",
] as const;

const EXCLUSION_LOCATORS = [
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:15",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:16",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:17",
] as const;

const REPLACED_BASELINE_DEBT_REVIEWS: readonly SourceAlarmReview[] = [
  {
    locator:
      "packages/api-client/src/client.ts#network_processor:a50aa78e7d6a887f:1",
    debtId:
      "debt.source-alarm.processor.network_processor.b836e989ec3c744a",
    surface: "processor",
    owner: "packages/api-client",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      "packages/api-client/src/client.ts#network_processor:a50aa78e7d6a887f:1 is the relocated reviewed network-processor alarm whose outbound and inbound network payload classification remains untriaged.",
    evidenceGap:
      "packages/api-client/src/client.ts#network_processor:a50aa78e7d6a887f:1 lacks executable evidence identifying the exact request and response fields, recipient boundary, and encryption bridge for this network-processor alarm.",
  },
  {
    locator:
      "packages/api-client/src/client.ts#network_processor:fc34552379aa34d3:1",
    debtId:
      "debt.source-alarm.processor.network_processor.5a5648c5992cc83c",
    surface: "processor",
    owner: "packages/api-client",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      "packages/api-client/src/client.ts#network_processor:fc34552379aa34d3:1 is the relocated reviewed network-processor alarm whose outbound and inbound network payload classification remains untriaged.",
    evidenceGap:
      "packages/api-client/src/client.ts#network_processor:fc34552379aa34d3:1 lacks executable evidence identifying the exact request and response fields, recipient boundary, and encryption bridge for this network-processor alarm.",
  },
];

export const REVIEWED_M240_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    ...REPLACED_BASELINE_DEBT_REVIEWS,
    ...DECLARATION_LOCATORS.map((locator, index) => ({
      locator,
      owner: locator.split("/").slice(0, 2).join("/"),
      closure: "declaration" as const,
      declarationId:
        `source.m240.device-local-notification-${index + 1}`,
      reason:
        "This exact callsite belongs to the classified M240 device-local important-message notification boundary and is covered by its content-validation and native-delivery tests.",
    })),
    ...EXCLUSION_LOCATORS.map((locator, index) => ({
      locator,
      owner: "apps/desktop",
      closure: "reviewed_exclusion" as const,
      exclusionId: `exclusion.m240.fixed-notification-log-${index + 1}`,
      reason:
        "This exact rejection log contains only a fixed subsystem label, a bounded reason enum, and an Electron numeric sender ID; it emits no notification labels, message content, credentials, or raw exception text.",
    })),
  ];
