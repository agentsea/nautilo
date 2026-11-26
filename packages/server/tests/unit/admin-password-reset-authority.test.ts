import { describe, expect, test } from "bun:test";
import type { ServerRoleSlug } from "@nautilo/trust";
import { canResetPasswordForRole } from "../../src/lib/admin-password-reset-authority";

describe("admin password reset authority", () => {
  const cases: Array<[string, ServerRoleSlug | null, ServerRoleSlug | null, boolean]> = [
    ["denies Admin to Owner", "admin", "owner", false],
    ["allows Admin to Admin", "admin", "admin", true],
    ["allows Admin to Member", "admin", "member", true],
    ["allows Admin to an unranked target", "admin", null, true],
    ["allows Owner to Owner", "owner", "owner", true],
    ["allows Owner to Admin", "owner", "admin", true],
    ["denies an unranked caller to Owner", null, "owner", false],
    ["denies an unranked caller to an unranked target", null, null, false],
  ];

  test.each(cases)("%s", (_description, caller, target, allowed) => {
    expect(canResetPasswordForRole(caller, target)).toBe(allowed);
  });
});
