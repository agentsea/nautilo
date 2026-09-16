import type { EncryptionCoverageEntry } from "../src/model";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-pr-945-security.test.ts";

export const REVIEWED_PR_945_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    {
      id: "db.pr-945.push-installation-badge-enabled",
      surface: "db",
      locator: "public.push_installation_bindings.badge_enabled",
      owner: "packages/db",
      readers: ["packages/server/src/push/push-delivery-worker.ts"],
      writers: ["packages/server/src/push/push-installation-store.ts"],
      migrationState: "not_applicable",
      retention:
        "Retained only for the lifetime of the owner-scoped Mobile installation binding and removed with that binding.",
      testEvidence: [
        REVIEW_EVIDENCE,
        "packages/db/tests/unit/migration-0170-push-badge-preference.test.ts",
        "packages/db/tests/unit/push-notification-schema.test.ts",
        "packages/server/tests/unit/push-delivery-runtime.test.ts",
      ],
      classification: "bounded_metadata",
      metadataAllowlist: ["badge_enabled"],
      plaintextReason:
        "The field is a single device-display preference boolean; it contains no notification copy, Human content, provider capability, or key material.",
    },
    {
      id: "wire.pr-945.push-installation-badge-preference",
      surface: "wire",
      locator:
        "http:request_response:PUT /api/push/installations/:bindingId/badge-preference",
      owner: "packages/server",
      readers: ["packages/api-client/src/client.ts", "apps/mobile/src"],
      writers: ["packages/server/src/routes/push-notifications.ts"],
      migrationState: "not_applicable",
      retention:
        "The authenticated request and response are transient; the separately classified boolean is retained on the owner-scoped Mobile installation binding.",
      testEvidence: [
        REVIEW_EVIDENCE,
        "packages/api-client/tests/unit/push-notifications-contract.test.ts",
        "packages/server/tests/unit/push-notifications-routes.test.ts",
      ],
      classification: "bounded_metadata",
      metadataAllowlist: [
        "bindingId",
        "enabled",
        "tokenGeneration",
        "version",
      ],
      plaintextReason:
        "The closed contract contains only an opaque binding identifier, bounded generation and version numbers, and the badge preference boolean; it contains no notification copy or provider capability.",
    },
  ];
