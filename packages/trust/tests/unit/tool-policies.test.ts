import { describe, test, expect } from "bun:test";
import { getToolPolicy, getRegisteredToolNames } from "../../src/tool-policies";

describe("tool policy registry", () => {
  test("all built-in tool policies are registered, including D066 transcribe_audio + M088A share_artifact", () => {
    const names = getRegisteredToolNames();
    // M144 — task + 3 intent shortcuts (in_scope / in_background / in_private_namespace).
    // M145 — schedule (+1).
    // D263 — +2 skill_manage + view_skill.
    // M148 — removed delegate_to_subagent + do_in_private_namespace (-2 → 38).
    // M151 — added ask_peer (+1 → 39).
    // M189 — +1 mini_app (→ 40).
    // D336 — +1 snapshot (→ 49), +4 act/read (→ 53), +3 screenshot/mouse/get (→ 56), +1 scroll (→ 57).
    // D138 — +1 google_workspace (→ 58).
    // D363 — +1 generate_repo_docs (→ 59).
    // D373 — +1 terminal (→ 60).
    // D362 — +2 office + edit_doc (→ 62).
    // D379 — +4 command_manage + view_command + discover_commands + eject_command (→ 66).
    // D379 — +1 launch_customization (→ 67).
    // D055 — +1 hue_lights (→ 68).
    // D417 — +1 ingest_local_media +1 extract_audio_from_video (→ 70).
    // D419 — +1 activate_tools + deactivate_tools (→ 72). D448 adds
    // top-level apply_patch (→ 73). Browser hardening adds native navigation/actions (→ 84).
    // D497 adds bounded Current Folder adoption (→ 85). D504 adds
    // browser_read_page (→ 86). D516 Wave 1A adds the semantic
    // computer_observe + computer_do policies (→ 88); D516 2.1.3b adds
    // read-only computer_verify (→ 89). Removing eight legacy desktop_*
    // policies and retaining D560 security_scan leaves 95 policies. D456 adds
    // three exact Notion and four exact Slack policies (→ 102). D568 adds the
    // connected website read policy (→ 103). D585 adds public browse_web (→ 104).
    // General website task execution adds one action-capable policy (105).
    expect(names).toHaveLength(105);
    expect(names).toContain("browse_web");
    expect(names).toContain("apply_patch");
    expect(names).toContain("select_current_folder");
    expect(names).toContain("share_artifact");
    expect(names).toContain("terminal");
    expect(names).toContain("command_manage");
    expect(names).toContain("view_command");
    expect(names).not.toContain("do_in_private_namespace");
    expect(names).not.toContain("delegate_to_subagent");
    expect(names).toContain("in_scope");
    expect(names).toContain("in_background");
    expect(names).toContain("schedule");
    expect(names).toContain("in_private_namespace");
    expect(names).toContain("ask_peer");
    expect(names).toContain("generate_repo_docs");
    expect(names).toContain("get_room_members");
    expect(names).toContain("manage_voices");
    expect(names).toContain("audition_voices");
    expect(names).toContain("hue_lights");
    expect(names).toContain("activate_tools");
    expect(names).toContain("deactivate_tools");
    expect(names).toContain("skill_manage");
    expect(names).toContain("view_skill");
    expect(names).toContain("browser_read_page");
    expect(names).toContain("security_scan");
    expect(names).toContain("notion_search");
    expect(names).toContain("notion_retrieve_page");
    expect(names).toContain("notion_create_page");
    expect(names).toContain("slack_list_conversations");
    expect(names).toContain("slack_get_channel_messages");
    expect(names).toContain("slack_search_messages");
    expect(names).toContain("slack_post_message");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("list_directory");
  });

  test("unified `file` tool is registered with project-content authority", () => {
    const policy = getToolPolicy("file");
    expect(policy.impact).toBe("destructive");
    expect(policy.requiredCapability).toBe("use_project_content");
  });

  test("D448 apply_patch is destructive and requires project-content authority", () => {
    const policy = getToolPolicy("apply_patch");
    expect(policy).toMatchObject({
      requiredCapability: "use_project_content",
      impact: "destructive",
      executor: "cloud",
      requiresApproval: true,
    });
  });

  test("D497 Current Folder adoption uses the local Electron relay capability", () => {
    expect(getToolPolicy("select_current_folder")).toMatchObject({
      requiredCapability: "control_desktop",
      impact: "high",
      executor: "relay",
      relayCapability: "canRunShell",
      requiresApproval: true,
    });
  });

  test("read-only tools have no required capability", () => {
    // M128 — search_memory now requires read_memories; session_search / run_web_search / read_webpage unchanged
    for (const name of ["session_search", "run_web_search", "read_webpage"]) {
      const policy = getToolPolicy(name);
      expect(policy.requiredCapability).toBeNull();
      expect(policy.impact).toBe("read-only");
    }
    // M128 — search_memory is still read-only impact but now gated by read_memories
    const searchPolicy = getToolPolicy("search_memory");
    expect(searchPolicy.requiredCapability).toBe("read_memories");
    expect(searchPolicy.impact).toBe("read-only");
  });

  test("D419 activation controls are read-only, ungated cloud meta-tools", () => {
    for (const name of ["activate_tools", "deactivate_tools"]) {
      const policy = getToolPolicy(name);
      expect(policy.requiredCapability).toBeNull();
      expect(policy.impact).toBe("read-only");
      expect(policy.executor).toBe("cloud");
      expect(policy.requiresApproval).not.toBe(true);
    }
  });

  test("D456 Notion reads are read-only while page creation remains approval-gated", () => {
    for (const name of ["notion_search", "notion_retrieve_page"]) {
      expect(getToolPolicy(name)).toMatchObject({
        requiredCapability: null,
        impact: "read-only",
        executor: "cloud",
      });
    }
    expect(getToolPolicy("notion_create_page")).toMatchObject({
      requiredCapability: null,
      impact: "high",
      executor: "cloud",
      requiresApproval: true,
    });
  });

  test("D456 Slack reads are read-only while posting remains approval-gated", () => {
    for (const name of ["slack_list_conversations", "slack_get_channel_messages", "slack_search_messages"]) {
      expect(getToolPolicy(name)).toMatchObject({
        requiredCapability: null,
        impact: "read-only",
        executor: "cloud",
      });
    }
    expect(getToolPolicy("slack_post_message")).toMatchObject({
      requiredCapability: null,
      impact: "high",
      executor: "cloud",
      requiresApproval: true,
    });
  });

  test("manage_memory requires manage_memories", () => {
    // M128 — write_shared_memory retired; manage_memories is the replacement
    const policy = getToolPolicy("manage_memory");
    expect(policy.requiredCapability).toBe("manage_memories");
    expect(policy.impact).toBe("low");
  });

  test("workstation shell requires use_workstation with destructive impact", () => {
    for (const name of ["run_shell"]) {
      const policy = getToolPolicy(name);
      expect(policy.requiredCapability).toBe("use_workstation");
      expect(policy.impact).toBe("destructive");
    }
  });

  test("config/onboarding tools are registered with correct policies", () => {
    // M128 — onboarding_status / find_voice unchanged (no cap required)
    const nullCapReadOnly = ["onboarding_status", "find_voice", "audition_voices"];
    for (const name of nullCapReadOnly) {
      const policy = getToolPolicy(name);
      expect(policy.requiredCapability).toBeNull();
      expect(policy.impact).toBe("read-only");
    }
    // M128 — check_config now gated by read_server_settings (was null)
    const checkConfig = getToolPolicy("check_config");
    expect(checkConfig.requiredCapability).toBe("read_server_settings");
    expect(checkConfig.impact).toBe("read-only");

    // M128 D4-A — manage_profile is self-edit by construction (no target
    // parameter; the tool body operates on context.ownerId). Static cap
    // is null; see tool-policy-cap-remap.test.ts for the rationale.
    const low = getToolPolicy("manage_profile");
    expect(low.requiredCapability).toBeNull();
    expect(low.impact).toBe("low");

    // M128 — update_config: manage_server_settings (was use_high_impact_tools)
    const updateConfig = getToolPolicy("update_config");
    expect(updateConfig.requiredCapability).toBe("manage_server_settings");
    expect(updateConfig.impact).toBe("destructive");

    // M128 D4-A — regenerate_soul: same as manage_profile, self-edit by construction.
    const regenerateSoul = getToolPolicy("regenerate_soul");
    expect(regenerateSoul.requiredCapability).toBeNull();
    expect(regenerateSoul.impact).toBe("destructive");
  });

  test("transcribe_audio is high-impact and explicitly approval-gated (local file → hosted STT)", () => {
    // M128 — use_transcription replaces use_high_impact_tools for transcribe_audio
    const policy = getToolPolicy("transcribe_audio");
    expect(policy.requiredCapability).toBe("use_transcription");
    expect(policy.impact).toBe("high");
    expect(policy.requiresApproval).toBe(true);
  });

  test("execute_artifact requires project-execution authority and destructive impact", () => {
    const policy = getToolPolicy("execute_artifact");
    expect(policy.requiredCapability).toBe("use_project_execution");
    expect(policy.impact).toBe("destructive");
  });

  test("M189 mini_app requires Admin-grade manage_server_operations, destructive, static approval", () => {
    const policy = getToolPolicy("mini_app");
    expect(policy.requiredCapability).toBe("manage_server_operations");
    expect(policy.impact).toBe("destructive");
    expect(policy.executor).toBe("cloud");
    expect(policy.approvalMode).toBeUndefined();
  });

  test("list_my_users is read-only; share_memory is hybrid + manage_memories", () => {
    // M128 — write_shared_memory retired; share_memory now uses manage_memories
    expect(getToolPolicy("list_my_users").impact).toBe("read-only");
    expect(getToolPolicy("list_my_users").requiredCapability).toBeNull();
    const share = getToolPolicy("share_memory");
    expect(share.requiredCapability).toBe("manage_memories");
    expect(share.approvalMode).toBe("hybrid");
    expect(share.impact).toBe("destructive");
  });

  test("M080 scope tools mirror manage_memory / search_memory posture in deprecated table", () => {
    expect(getToolPolicy("find_scope").impact).toBe("read-only");
    expect(getToolPolicy("find_scope").requiredCapability).toBeNull();
    for (const name of ["create_scope", "add_memory_to_scope", "close_scope", "task"]) {
      const p = getToolPolicy(name);
      expect(p.impact).toBe("low");
      expect(p.requiredCapability).toBeNull();
    }
  });

  test("M144 in_scope / in_background / schedule are low + ungated; cross-context shortcuts require agent invocation", () => {
    for (const name of ["in_scope", "in_background", "schedule"]) {
      const p = getToolPolicy(name);
      expect(p.impact).toBe("low");
      expect(p.requiredCapability).toBeNull();
      expect(p.executor).toBe("cloud");
    }
    const priv = getToolPolicy("in_private_namespace");
    expect(priv.impact).toBe("destructive");
    expect(priv.requiredCapability).toBe("invoke_agents");
    expect(priv.executor).toBe("cloud");
    // M151 — ask_peer uses the same agent-invocation authority.
    const askPeer = getToolPolicy("ask_peer");
    expect(askPeer.impact).toBe("destructive");
    expect(askPeer.requiredCapability).toBe("invoke_agents");
    expect(askPeer.approvalMode).toBe("hybrid");
    expect(askPeer.executor).toBe("cloud");
  });

  test("M137 get_room_members is read-only, room-scoped, no capability gate", () => {
    const p = getToolPolicy("get_room_members");
    expect(p.impact).toBe("read-only");
    expect(p.requiredCapability).toBeNull();
  });

  test("M087 get_current_time is low-impact cloud tool with no capability gate", () => {
    const policy = getToolPolicy("get_current_time");
    expect(policy.executor).toBe("cloud");
    expect(policy.impact).toBe("low");
    expect(policy.requiredCapability).toBeNull();
  });

  test("generate_image is low-impact, gated by use_image_generation (D113 / M128)", () => {
    // M128 — generate_image now requires use_image_generation (was null)
    const policy = getToolPolicy("generate_image");
    expect(policy.requiredCapability).toBe("use_image_generation");
    expect(policy.impact).toBe("low");
  });

  test("obsolete desktop_* names resolve to the unregistered fail-closed policy", () => {
    for (const name of ["desktop_app", "desktop_window", "desktop_menu", "desktop_inspect", "desktop_see", "desktop_click", "desktop_type", "desktop_key"]) {
      const policy = getToolPolicy(name);
      expect(policy.requiredCapability).toBe("__unregistered_tool_forbidden__");
      expect(policy.impact).toBe("destructive");
      expect(policy.executor).toBe("cloud");
      expect(policy.requiresApproval).toBe(true);
    }
  });

  test("D516 semantic Computer use has a dedicated relay gate and no generic approval", () => {
    const observe = getToolPolicy("computer_observe");
    expect(observe).toMatchObject({
      requiredCapability: "control_desktop",
      impact: "read-only",
      executor: "relay",
      relayCapability: "canUseComputer",
      requiresApproval: false,
    });
    const action = getToolPolicy("computer_do");
    expect(action).toMatchObject({
      requiredCapability: "control_desktop",
      impact: "high",
      executor: "relay",
      relayCapability: "canUseComputer",
      requiresApproval: false,
    });
    expect(getToolPolicy("computer_verify")).toMatchObject({
      requiredCapability: "control_desktop",
      impact: "read-only",
      executor: "relay",
      relayCapability: "canUseComputer",
      requiresApproval: false,
    });
  });

  test("D336 browser_snapshot is a low-impact relay tool gated by control_browser, no approval", () => {
    const policy = getToolPolicy("browser_snapshot");
    expect(policy.requiredCapability).toBe("control_browser");
    expect(policy.impact).toBe("low");
    expect(policy.executor).toBe("relay");
    expect(policy.relayCapability).toBe("canControlBrowser");
    expect(policy.requiresApproval).not.toBe(true);
  });

  test("D504 browser_read_page is a read-only relay tool gated by control_browser", () => {
    const policy = getToolPolicy("browser_read_page");
    expect(policy.requiredCapability).toBe("control_browser");
    expect(policy.impact).toBe("read-only");
    expect(policy.executor).toBe("relay");
    expect(policy.relayCapability).toBe("canControlBrowser");
    expect(policy.requiresApproval).not.toBe(true);
  });

  test("browser_back uses the routine embedded-browser control policy", () => {
    const policy = getToolPolicy("browser_back");
    expect(policy.requiredCapability).toBe("control_browser");
    expect(policy.impact).toBe("low");
    expect(policy.executor).toBe("relay");
    expect(policy.relayCapability).toBe("canControlBrowser");
    expect(policy.requiresApproval).not.toBe(true);
  });

  test("browser_open uses the routine embedded-browser control policy", () => {
    const policy = getToolPolicy("browser_open");
    expect(policy.requiredCapability).toBe("control_browser");
    expect(policy.impact).toBe("low");
    expect(policy.executor).toBe("relay");
    expect(policy.relayCapability).toBe("canControlBrowser");
    expect(policy.requiresApproval).not.toBe(true);
  });

  test("D055 hue_lights is a low-impact relay tool gated by control_home", () => {
    const policy = getToolPolicy("hue_lights");
    expect(policy.requiredCapability).toBe("control_home");
    expect(policy.impact).toBe("low");
    expect(policy.executor).toBe("relay");
    expect(policy.relayCapability).toBe("canControlHue");
    expect(policy.requiresApproval).not.toBe(true);
  });

  test("unknown tool defaults to destructive (fail-closed)", () => {
    const policy = getToolPolicy("some_unknown_tool");
    expect(policy.requiredCapability).toBe("__unregistered_tool_forbidden__");
    expect(policy.impact).toBe("destructive");
  });
});
