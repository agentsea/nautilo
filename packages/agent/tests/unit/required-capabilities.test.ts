import { describe, test, expect, beforeAll } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";

/**
 * Regression test for requiredCapabilities bypass.
 *
 * Bug: register-all.ts had empty requiredCapabilities on all tools.
 * PersonalPolicyResolver.getToolNamesAndPolicies() reads from the catalog
 * and returned null for requiredCapability, making buildToolPolicyFromCapabilities()
 * give "allow" to all non-read-only tools for any actor with capabilities.
 *
 * Fix: tools declare requiredCapabilities. The catalog keeps ordinary product
 * authority together: project content, project execution, workstation,
 * remote-host, connection, media-generation, and agent-invocation tools have
 * their own static capability; self-edit-by-construction tools carry no cap.
 */
describe("requiredCapabilities on catalog entries", () => {
  let catalog: ToolCatalog;

  beforeAll(() => {
    catalog = new ToolCatalog();
    registerAllTools(catalog);
  });

  const TOOLS_WITH_REQUIRED_CAPABILITIES: Array<[string, string]> = [
    ["file", "use_project_content"],
    ["apply_patch", "use_project_content"],
    ["convert", "use_project_content"],
    ["execute_artifact", "use_project_execution"],
    ["generate_repo_docs", "use_project_execution"],
    ["run_shell", "use_workstation"],
    ["terminal", "use_workstation"],
    ["structured_ssh_auth", "use_remote_hosts"],
    ["structured_ssh_exec", "use_remote_hosts"],
    ["structured_ssh_output", "use_remote_hosts"],
    ["structured_ssh_copy_upload", "use_remote_hosts"],
    ["structured_ssh_copy_download", "use_remote_hosts"],
    ["list_connections", "use_connections"],
    ["use_connection", "use_connections"],
    ["use_credential", "use_connections"],
    ["delete_connection", "use_connections"],
    ["generate_image", "use_image_generation"],
    ["update_config", "manage_server_settings"],
    ["mini_app", "manage_server_operations"],
    ["run_deep_research", "use_research_tools"],
    ["transcribe_audio", "use_transcription"],
    ["evaluate_decisions", "use_server_provider_credentials"],
    ["hue_lights", "control_home"],
    ["in_private_namespace", "invoke_agents"],
    ["ask_peer", "invoke_agents"],
    ["search_memory", "read_memories"],
    ["manage_memory", "manage_memories"],
    ["check_config", "read_server_settings"],
  ];

  for (const [toolName, expectedCap] of TOOLS_WITH_REQUIRED_CAPABILITIES) {
    test(`${toolName} requires ${expectedCap}`, () => {
      const entry = catalog.get(toolName);
      expect(entry).toBeDefined();
      expect(entry!.requiredCapabilities).toContain(expectedCap);
    });
  }

  test("regenerate_soul requires manage_agents (M128 D4-A two-gate)", () => {
    const entry = catalog.get("regenerate_soul");
    expect(entry).toBeDefined();
    expect(entry!.requiredCapabilities).toContain("manage_agents");
  });

  const NO_CAPABILITY_TOOLS = [
    "session_search",
    "run_web_search",
    "read_webpage",
    "manage_profile",
    "manage_voices",
    "onboarding_status",
    "find_voice",
    "audition_voices",
    "verify_identity",
    "discover_tools",
    "guide_user",
    "create_scope",
    "find_scope",
    "add_memory_to_scope",
    "close_scope",
    "task",
    "in_scope",
    "in_background",
    "schedule",
    "list_my_users",
    "get_room_members",
    "read_artifact_events",
  ];

  for (const toolName of NO_CAPABILITY_TOOLS) {
    test(`${toolName} has no required capabilities`, () => {
      const entry = catalog.get(toolName);
      expect(entry).toBeDefined();
      expect(entry!.requiredCapabilities).toEqual([]);
    });
  }

  test("catalog.getToolPolicy returns the workstation capability for shell", () => {
    const policy = catalog.getToolPolicy("run_shell");
    expect(policy.requiredCapability).toBe("use_workstation");
  });

  test("catalog.getToolPolicy returns required capability for standard tools", () => {
    const policy = catalog.getToolPolicy("search_memory");
    expect(policy.requiredCapability).toBe("read_memories");
  });
});
