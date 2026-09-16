import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { mobileUserAgreementAcceptances } from "../../src/schema/mobile-user-agreement-acceptances";
import { SENSITIVE_TABLES } from "../../src/utils/agent-role-grants";

const migration = await Bun.file(
  new URL("../../src/migrations/0208_aspiring_doorman.sql", import.meta.url),
).text();

describe("Mobile user agreement acceptance schema", () => {
  test("keeps append history with one active acceptance per Human", () => {
    const config = getTableConfig(mobileUserAgreementAcceptances);
    expect(config.name).toBe("mobile_user_agreement_acceptances");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "agreement_version",
      "policy_version",
      "recipient_manifest_version",
      "accepted_at",
      "withdrawn_at",
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "uniq_mobile_agreement_active_user",
      "idx_mobile_agreement_user_time",
    ]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(migration).toContain('WHERE "mobile_user_agreement_acceptances"."withdrawn_at" IS NULL');
    expect(migration).toContain("ON DELETE cascade");
  });

  test("keeps acceptance history invisible to the Agent database role", () => {
    expect(SENSITIVE_TABLES).toContain("mobile_user_agreement_acceptances");
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.mobile_user_agreement_acceptances FROM nautilo_agent",
    );
  });
});
