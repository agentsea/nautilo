import type { EncryptionCoverageEntry } from "../src/model";

const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/migration-0127-m233-notification-intelligence.test.ts";
const CLASSIFICATION_EVIDENCE =
  "packages/agent/tests/integration/m233-notification-classification.integration.test.ts";
const PREFERENCE_EVIDENCE =
  "packages/server/tests/unit-isolated/notification-preferences-routes.test.ts";

const NOTIFICATION_TABLES = {
  room_notification_settings: [
    "level",
    "room_id",
    "updated_at",
    "user_id",
  ],
  session_message_directed_recipients: [
    "created_at",
    "message_id",
    "reason",
    "recipient_id",
  ],
  subthread_notification_participants: [
    "created_at",
    "from_message_id",
    "reason",
    "subthread_room_id",
    "user_id",
  ],
  user_notification_settings: [
    "default_level",
    "updated_at",
    "user_id",
  ],
} as const;

function databaseEntry(
  table: keyof typeof NOTIFICATION_TABLES | "session_messages",
  locator: string,
  metadataAllowlist: readonly string[],
): EncryptionCoverageEntry {
  const isPreference = table === "room_notification_settings"
    || table === "user_notification_settings";
  return {
    id: `db.main-2026-08-03.${locator.replaceAll("_", "-").replaceAll(".", "-")}`,
    surface: "db",
    locator,
    owner: isPreference ? "packages/trust" : "packages/agent",
    readers: isPreference
      ? [
        "packages/trust/src/notification-preferences.ts",
        "packages/server/src/routes/notification-preferences.ts",
      ]
      : [
        "packages/trust/src/notification-classification.ts",
        "packages/agent/src/store/session-store.ts",
      ],
    writers: isPreference
      ? ["packages/trust/src/notification-preferences.ts"]
      : [
        "packages/trust/src/notification-classification.ts",
        "packages/agent/src/store/session-store.ts",
      ],
    migrationState: "not_applicable",
    retention:
      "Retained with the owning notification preference, immutable message classification fact, or canonical transcript row and removed by that record's existing lifecycle.",
    testEvidence: [
      SCHEMA_EVIDENCE,
      isPreference ? PREFERENCE_EVIDENCE : CLASSIFICATION_EVIDENCE,
    ],
    classification: "bounded_metadata",
    metadataAllowlist,
    plaintextReason:
      "This exact field set contains only canonical identifiers, bounded notification enums, timestamps, or an opaque Human-turn correlation ID; it contains no message content, prompt, credential, or cryptographic secret.",
  };
}

export const REVIEWED_MAIN_2026_08_03_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...Object.entries(NOTIFICATION_TABLES).flatMap(([table, columns]) => [
      databaseEntry(
        table as keyof typeof NOTIFICATION_TABLES,
        `public.${table}`,
        columns,
      ),
      ...columns.map((column) =>
        databaseEntry(
          table as keyof typeof NOTIFICATION_TABLES,
          `public.${table}.${column}`,
          [column],
        )
      ),
    ]),
    databaseEntry(
      "session_messages",
      "public.session_messages.human_turn_id",
      ["human_turn_id"],
    ),
    {
      id: "wire.main-2026-08-03.room-post-mentioned-humans",
      surface: "wire",
      locator:
        "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody#mentionedHumanUserIds",
      owner: "packages/server",
      readers: ["packages/server/src/messaging/dispatch.ts"],
      writers: ["apps/workbench/src/components/composer/MentionAdapter.tsx"],
      migrationState: "not_applicable",
      retention:
        "Validated sender-authored Human recipient IDs are carried only into the canonical atomic message-classification transaction.",
      testEvidence: [CLASSIFICATION_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["mentionedHumanUserIds[]"],
      plaintextReason:
        "The field is a bounded set of canonical Human user IDs used for notification classification and contains no message text or arbitrary payload.",
    },
    {
      id: "wire.main-2026-08-03.room-message-mentioned-humans",
      surface: "wire",
      locator:
        "http:request_response:POST /api/rooms/:roomId/messages#request.body.mentionedHumanUserIds",
      owner: "packages/server",
      readers: ["packages/server/src/routes/rooms.ts"],
      writers: ["apps/workbench/src/components/composer/MentionAdapter.tsx"],
      migrationState: "not_applicable",
      retention:
        "Validated sender-authored Human recipient IDs are carried only into the canonical atomic message-classification transaction.",
      testEvidence: [CLASSIFICATION_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["request.body.mentionedHumanUserIds[]"],
      plaintextReason:
        "The field is a bounded set of canonical Human user IDs used for notification classification and contains no message text or arbitrary payload.",
    },
    {
      id: "wire.main-2026-08-03.notification-preferences-get",
      surface: "wire",
      locator: "http:request_response:GET /api/notifications/preferences",
      owner: "packages/server",
      readers: ["packages/server/src/routes/notification-preferences.ts"],
      writers: ["packages/trust/src/notification-preferences.ts"],
      migrationState: "not_applicable",
      retention:
        "The authenticated response reflects only the requesting Human's bounded default and per-Room notification preference metadata.",
      testEvidence: [PREFERENCE_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "defaultLevel",
        "roomOverrides[].level",
        "roomOverrides[].roomId",
      ],
      plaintextReason:
        "The response contains only canonical Room IDs and the closed none/direct/all notification-level enum.",
    },
    {
      id: "wire.main-2026-08-03.notification-preferences-put",
      surface: "wire",
      locator: "http:request_response:PUT /api/notifications/preferences",
      owner: "packages/server",
      readers: ["packages/server/src/routes/notification-preferences.ts"],
      writers: ["packages/trust/src/notification-preferences.ts"],
      migrationState: "not_applicable",
      retention:
        "The authenticated mutation and response contain only the requesting Human's bounded notification preference metadata.",
      testEvidence: [PREFERENCE_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "request.body.defaultLevel",
        "response.body.defaultLevel",
        "response.body.roomOverrides[].level",
        "response.body.roomOverrides[].roomId",
      ],
      plaintextReason:
        "The contract contains only canonical Room IDs and the closed none/direct/all notification-level enum.",
    },
    {
      id: "wire.main-2026-08-03.notification-preferences-put-level",
      surface: "wire",
      locator:
        "http:request_response:PUT /api/notifications/preferences#request.body.defaultLevel",
      owner: "packages/server",
      readers: ["packages/server/src/routes/notification-preferences.ts"],
      writers: ["packages/trust/src/notification-preferences.ts"],
      migrationState: "not_applicable",
      retention:
        "The validated value becomes the requesting Human's bounded account notification preference.",
      testEvidence: [PREFERENCE_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["none", "direct", "all"],
      plaintextReason:
        "The exact value is validated to the closed none/direct/all notification-level enum.",
    },
    {
      id: "wire.main-2026-08-03.room-notification-preference-put",
      surface: "wire",
      locator:
        "http:request_response:PUT /api/rooms/:roomId/notification-preference",
      owner: "packages/server",
      readers: ["packages/server/src/routes/notification-preferences.ts"],
      writers: ["packages/trust/src/notification-preferences.ts"],
      migrationState: "not_applicable",
      retention:
        "The authenticated mutation and response contain only one authorized Room identity and its bounded notification preference metadata.",
      testEvidence: [PREFERENCE_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "request.params.roomId",
        "request.body.level",
        "response.body.effectiveLevel",
        "response.body.inherited",
        "response.body.overrideLevel",
        "response.body.roomId",
      ],
      plaintextReason:
        "The contract contains only one canonical Room ID, a boolean, and the closed none/direct/all notification-level enum.",
    },
    {
      id: "wire.main-2026-08-03.room-notification-preference-put-level",
      surface: "wire",
      locator:
        "http:request_response:PUT /api/rooms/:roomId/notification-preference#request.body.level",
      owner: "packages/server",
      readers: ["packages/server/src/routes/notification-preferences.ts"],
      writers: ["packages/trust/src/notification-preferences.ts"],
      migrationState: "not_applicable",
      retention:
        "The validated value becomes or clears the requesting Human's bounded per-Room notification preference.",
      testEvidence: [PREFERENCE_EVIDENCE],
      classification: "bounded_metadata",
      metadataAllowlist: ["inherit", "none", "direct", "all"],
      plaintextReason:
        "The exact value is validated to the closed inherit/none/direct/all notification-level enum.",
    },
  ];
