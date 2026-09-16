import { describe, expect, test } from "bun:test";
import { CAPABILITY_SLUGS } from "@nautilo/types";
import { CAPABILITY_SEEDS } from "../../src/utils/seed-trust-personal";

describe("M129 capability catalogue parity", () => {
  test("@nautilo/types list === DB seed list", () => {
    const seedSlugs = CAPABILITY_SEEDS.map((c) => c.slug).sort();
    const typeSlugs = [...CAPABILITY_SLUGS].sort();
    expect(typeSlugs).toEqual(seedSlugs);
  });

  test("uncontained host command management is limited to Owner and Admin", async () => {
    const { M128_ROLE_CAPABILITIES } = await import("../../src/utils/seed-trust-personal");
    expect(M128_ROLE_CAPABILITIES["owner"]).toContain("manage_uncontained_host_commands");
    expect(M128_ROLE_CAPABILITIES["admin"]).toContain("manage_uncontained_host_commands");
    expect(M128_ROLE_CAPABILITIES["superuser"]).not.toContain("manage_uncontained_host_commands");
  });

  test("manage_server_security retains its current-main Owner-only bundle", async () => {
    const { M128_ROLE_CAPABILITIES } = await import("../../src/utils/seed-trust-personal");
    expect(M128_ROLE_CAPABILITIES["owner"]).toContain("manage_server_security");
    expect(M128_ROLE_CAPABILITIES["admin"]).not.toContain("manage_server_security");
    expect(M128_ROLE_CAPABILITIES["superuser"]).not.toContain("manage_server_security");
  });

  test("protected D538 Role and Group remain outside the canonical ladder", async () => {
    const {
      M128_GROUP_TYPES,
      M128_ROLE_SLUGS,
      UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE,
      UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
    } = await import("../../src/utils/seed-trust-personal");
    expect(M128_ROLE_SLUGS).not.toContain(UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG);
    expect(M128_GROUP_TYPES).not.toContain(UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE);
  });
});
