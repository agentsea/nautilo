/**
 * M128 — Tool → Capability remap probe.
 *
 * Pinned in ISSUE-M128 §5.1 as the single source of truth that the
 * post-M128 `tool-policies.ts::TOOL_POLICIES` table matches the
 * canonical Tool → Capability map in `permission-model.md` §5.
 *
 * One assertion per retargeted tool. Unknown-tool denial is also pinned.
 */

import { describe, expect, test } from "bun:test";
import { getToolPolicy } from "../../src/tool-policies";

describe("M128 tool-policy capability remap (permission-model.md §5)", () => {
  // Memory tools
  test("search_memory → read_memories (new gate)", () => {
    expect(getToolPolicy("search_memory").requiredCapability).toBe(
      "read_memories",
    );
  });

  test("manage_memory → manage_memories (renamed from write_shared_memory)", () => {
    expect(getToolPolicy("manage_memory").requiredCapability).toBe(
      "manage_memories",
    );
  });

  test("share_memory → manage_memories (renamed from write_shared_memory)", () => {
    expect(getToolPolicy("share_memory").requiredCapability).toBe(
      "manage_memories",
    );
  });

  // Tools with dedicated ordinary-product authority
  test("share_artifact → use_share_artifact (narrowed)", () => {
    expect(getToolPolicy("share_artifact").requiredCapability).toBe(
      "use_share_artifact",
    );
  });

  test("transcribe_audio → use_transcription (narrowed)", () => {
    expect(getToolPolicy("transcribe_audio").requiredCapability).toBe(
      "use_transcription",
    );
  });

  test("run_deep_research → use_research_tools (narrowed)", () => {
    expect(getToolPolicy("run_deep_research").requiredCapability).toBe(
      "use_research_tools",
    );
  });

  // Server-settings split
  test("update_config → manage_server_settings (promoted + narrowed)", () => {
    expect(getToolPolicy("update_config").requiredCapability).toBe(
      "manage_server_settings",
    );
  });

  test("check_config → read_server_settings (new gate, was null)", () => {
    expect(getToolPolicy("check_config").requiredCapability).toBe(
      "read_server_settings",
    );
  });

  // Agent management — M128 D4-A (2026-05-28): both tools are self-edit
  // by construction (operate on context.ownerId; no target parameter),
  // so the static cap is `null`. Per permission-model.md §5 + §7 item 9
  // a future revision that adds a `targetUserId` parameter must enforce
  // the two-gate `agents.ownerId === userId || caps.includes("manage_agents")`
  // inside the tool body.
  test("manage_profile → null (D4-A self-edit by construction)", () => {
    expect(getToolPolicy("manage_profile").requiredCapability).toBeNull();
  });

  test("regenerate_soul → null (D4-A self-edit by construction)", () => {
    expect(getToolPolicy("regenerate_soul").requiredCapability).toBeNull();
  });

  test("skill_manage → null + low-impact cloud (D263 P2 two-gate body)", () => {
    const policy = getToolPolicy("skill_manage");
    expect(policy.requiredCapability).toBeNull();
    expect(policy.impact).toBe("low");
    expect(policy.executor).toBe("cloud");
  });

  // Image generation
  test("generate_image → use_image_generation (new gate)", () => {
    expect(getToolPolicy("generate_image").requiredCapability).toBe(
      "use_image_generation",
    );
  });

  test("file → use_project_content (per-command severity stays in file-tool-policies.ts)", () => {
    expect(getToolPolicy("file").requiredCapability).toBe(
      "use_project_content",
    );
  });

  test("execute_artifact → use_project_execution", () => {
    expect(getToolPolicy("execute_artifact").requiredCapability).toBe(
      "use_project_execution",
    );
  });

  test("run_shell and terminal → use_workstation", () => {
    expect(getToolPolicy("run_shell").requiredCapability).toBe(
      "use_workstation",
    );
    expect(getToolPolicy("terminal").requiredCapability).toBe("use_workstation");
  });

  test("unknown tool default is the internal ungrantable sentinel (fail-closed)", () => {
    expect(getToolPolicy("nonexistent_tool").requiredCapability).toBe(
      "__unregistered_tool_forbidden__",
    );
  });

  test("project-content tools share one static capability", () => {
    for (const name of ["apply_patch", "convert", "office", "edit_doc", "officecli"]) {
      expect(getToolPolicy(name).requiredCapability).toBe("use_project_content");
    }
  });

  test("remote hosts, Connections, media, and agent shortcuts keep dedicated capabilities", () => {
    for (const name of ["structured_ssh_auth", "structured_ssh_exec", "structured_ssh_output", "structured_ssh_copy_upload", "structured_ssh_copy_download"]) {
      expect(getToolPolicy(name).requiredCapability).toBe("use_remote_hosts");
    }
    for (const name of ["list_connections", "read_connected_web_account", "use_connection", "use_credential", "delete_connection"]) {
      expect(getToolPolicy(name).requiredCapability).toBe("use_connections");
    }
    for (const name of ["generate_video", "generate_music"]) {
      expect(getToolPolicy(name).requiredCapability).toBe("use_media_generation");
    }
    for (const name of ["in_private_namespace", "ask_peer"]) {
      expect(getToolPolicy(name).requiredCapability).toBe("invoke_agents");
    }
  });
});
