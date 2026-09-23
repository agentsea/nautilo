import { describe, expect, test } from "bun:test";
import { CAPABILITY_SLUGS } from "@nautilo/types";
import { CAPABILITY_SEEDS } from "../../src/utils/seed-trust-personal";

describe("M129 capability catalogue parity", () => {
  test("@nautilo/types list === DB seed list", () => {
    const seedSlugs = CAPABILITY_SEEDS.map((c) => c.slug).sort();
    const typeSlugs = [...CAPABILITY_SLUGS].sort();
    expect(typeSlugs).toEqual(seedSlugs);
  });

  test("adds exactly the three provider-funding and Genie-ownership capabilities", () => {
    const expected: Array<(typeof CAPABILITY_SLUGS)[number]> = [
      "invoke_other_agents",
      "use_personal_provider_credentials",
      "use_server_provider_credentials",
    ];
    for (const slug of expected) {
      expect(CAPABILITY_SLUGS).toContain(slug);
    }
    expect(CAPABILITY_SLUGS.filter((slug) => expected.includes(slug))).toEqual(
      expected,
    );
  });

  test("Community is the empty-membership catalogue rung between Contributor and Guest", async () => {
    const { M128_GROUP_TYPES, M128_ROLE_SLUGS } = await import(
      "../../src/utils/seed-trust-personal"
    );
    expect(M128_ROLE_SLUGS).toEqual([
      "owner",
      "admin",
      "superuser",
      "member",
      "contributor",
      "community",
      "guest",
    ]);
    expect(M128_GROUP_TYPES).toContain("communities");
  });

  test("custom Role compatibility maps only source-grounded paid entrances", async () => {
    const { CUSTOM_ROLE_COMPATIBILITY_GRANTS } = await import(
      "../../src/utils/seed-trust-personal"
    );
    expect(Object.keys(CUSTOM_ROLE_COMPATIBILITY_GRANTS).sort()).toEqual([
      "invoke_agents",
      "manage_agents",
      "use_connections",
      "use_image_generation",
      "use_media_generation",
      "use_project_content",
      "use_research_tools",
      "use_transcription",
    ]);
    expect(CUSTOM_ROLE_COMPATIBILITY_GRANTS["invoke_agents"]).toEqual([
      "invoke_other_agents",
      "use_server_provider_credentials",
    ]);
    for (const [source, targets] of Object.entries(
      CUSTOM_ROLE_COMPATIBILITY_GRANTS,
    )) {
      expect(targets).toContain("use_server_provider_credentials");
      expect(targets).not.toContain("use_personal_provider_credentials");
      if (source !== "invoke_agents") {
        expect(targets).not.toContain("invoke_other_agents");
      }
    }
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
