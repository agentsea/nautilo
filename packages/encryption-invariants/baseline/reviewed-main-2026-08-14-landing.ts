import type { EncryptionCoverageEntry } from "../src/model";

const EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-14-landing-security.test.ts";

const INVITE_REDEMPTION_LOCATORS = [
  ["public.invite_redemptions", ["invite_id", "user_id", "bound_at", "completed_at"]],
  ["public.invite_redemptions.bound_at", ["bound_at"]],
  ["public.invite_redemptions.completed_at", ["completed_at"]],
  ["public.invite_redemptions.invite_id", ["invite_id"]],
  ["public.invite_redemptions.user_id", ["user_id"]],
] as const;

export const RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memories:1",
    "packages/agent/src/store/memory-store.ts#forceCreateMemoryWithDb:raw_sql:insert:public.memory_namespaces:1",
  ]);

export const REVIEWED_MAIN_2026_08_14_LANDING_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = INVITE_REDEMPTION_LOCATORS.map(
    ([locator, fields]) => ({
      id: `db.main-2026-08-14-landing.${locator.replaceAll(/[^a-z0-9]+/gu, "-")}`,
      surface: "db",
      locator,
      owner: "packages/db",
      readers: ["packages/server/src", "packages/trust/src"],
      writers: [
        "packages/server/src/lib/owner-claim-control.ts",
        "packages/server/src/lib/redeem-invite.ts",
      ],
      migrationState: "not_applicable",
      retention:
        "Retained only for Invite redemption binding and completion; cascade deletion of the Invite or Human removes the row.",
      testEvidence: [
        EVIDENCE,
        "packages/db/tests/unit/migration-0167-m260-invite-redemptions.test.ts",
        "packages/server/tests/unit/m260-invite-redemption-inventory.test.ts",
      ],
      classification: "bounded_metadata",
      metadataAllowlist: fields,
      plaintextReason:
        "The exact field set contains only opaque Invite and Human identifiers plus lifecycle timestamps. It contains no invite token, external identity, PIN, recovery code, profile value, protected content, capability, or key material.",
    }),
  );
