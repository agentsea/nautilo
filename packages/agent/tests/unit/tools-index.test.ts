import { afterAll, describe, expect, test, beforeAll } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { getToolPolicy as getTrustToolPolicy } from "@nautilo/trust";
import { registerAllTools } from "../../src/tools/register-all";
import { validateToolExposureManifest } from "../../src/tools/exposure/manifest";
import { activeComputerUseHostToolDefinitions } from "../../src/config/computer-use-catalogue/host-tool-admission";

let catalog: ToolCatalog;
const ORIGINAL_TAVILY_API_KEY = process.env["TAVILY_API_KEY"];

beforeAll(() => {
  setConfigOverrides({ nautilo_office_enabled: false });
  process.env["TAVILY_API_KEY"] = "test-key";
  catalog = new ToolCatalog();
  // M203 — officecli registration is gated on a usable OfficeCLI binary. The
  // binary is no longer committed to git, so force availability on here to keep
  // the count-based assertions deterministic across hosts/CI. A dedicated test
  // below verifies the gate omits officecli when the binary is unavailable.
  registerAllTools(catalog, { officeCliAvailable: () => true, publicBrowserUseAvailable: () => true });
});

afterAll(() => {
  if (ORIGINAL_TAVILY_API_KEY !== undefined) process.env["TAVILY_API_KEY"] = ORIGINAL_TAVILY_API_KEY;
  else delete process.env["TAVILY_API_KEY"];
});

describe("tool catalog registration", () => {
  // D079 Phase 4 / G3 commit 5 added the unified `file` tool. D073
  // Sprint 2 added `execute_artifact`; D066 adds `transcribe_audio`;
  // D041 adds four model-callable Connection tools (list, use, delete + one legacy alias).
  // M080 adds four scope tools.
  // D113 adds generate_image. M088A adds share_artifact. D128 adds skip.
  // D261 adds manage_voices; P4 adds audition_voices.
  // M137 adds get_room_members.
  // M121 adds react.
  // D261 P6b adds read_artifact_events.
  // M087 adds get_current_time.
  // M144 adds in_scope + in_private_namespace + in_background (+3).
  // M145 adds schedule (+1).
  // D263 adds skill_manage + view_skill (+2).
  // D263 Stack 80 adds discover_skills + eject (+2).
  // M148 removes delegate_to_subagent + do_in_private_namespace (-2 → 46).
  // M151 adds ask_peer (+1 → 47).
    // M189 adds mini_app (+1 → 49).
    // D336 adds browser_snapshot (+1 → 50), browser_click/type/press/read (+4 → 54),
    // then browser_screenshot/mouse/get (+3 → 57), browser_scroll (+1 → 58),
    // and D138 google_workspace (+1 → 59).
    // D363: +1 generate_repo_docs (→ 60).
  // D373: +1 terminal (→ 61).
  // D379: +4 command_manage / view_command / discover_commands / eject_command (→ 65).
  // D379: +1 launch_customization (→ 66).
  // D396: +1 officecli (bundled headless binary, always registered → 67).
  // D384 §5.4: +1 manage_local_mcp (→ 68).
  // Stack 163: +1 manage_avatar (→ 69).
  // D055 Stack 173: +1 hue_lights (→ 70).
  // D417: +1 ingest_local_media +1 extract_audio_from_video (→ 72).
  // D419 Phase 1: +1 activate_tools (→ 73).
  // D419 Phase 2.3: +1 deactivate_tools (→ 74).
  // D416: +1 find_explainer, +1 user-consented play_explainer (→ 76).
  // D429 Phase 2: +1 discover_models (→ 77).
  // D421 Phase 6.4: redirect_to_agent folded into skip (no net change from
  // Phase 4's +1; the separate registration is removed, so the count stays
  // 77 vs the Phase-4 78). D448 adds core apply_patch (→ 78).
  // D362 merge-gate: live LibreOffice office + edit_doc are feature-flagged
  // off by default.
  // D490 browser work: +11 open/navigation/interaction/wait tools (→ 89).
  // D497: +1 select_current_folder (→ 90). D500: +2 structured SSH tools;
  // D500 continuation retrieval adds one read-only tool (→ 95).
  // D504: +1 browser_read_page (→ 96). D513: +1 guide_user (→ 97).
  // M271: +1 invocation-bound recall_records (→ 98).
  // D560 adds security_scan (→ 99 excluding the signed Computer Use catalogue).
  // D568 adds read_connected_web_account plus the confirmed action and the two
  // read-supervision/control tools (→ 103). D525 contributes two live-gated
  // paid media registrations (→ 105). D585 adds browse_web (→ 106).
  // General website tasks add run_website_task (→ 107).
  // D516 tools are added from the active signed catalogue and are deliberately
  // not a second compiled count/list in this test.
  test("registers all built-in tools including D066 and D041 tools", () => {
    expect(catalog.size).toBe(107 + activeComputerUseHostToolDefinitions().length);
  });

  test("registers mini_app with static destructive approval", () => {
    expect(catalog.get("mini_app")?.approvalMode).toBeUndefined();
  });

  test("marks protected foreground Memory mutations as Full-capable", () => {
    expect(catalog.get("manage_memory")?.fullEncryptionSupport)
      .toBe("supported");
  });

  test("D362 live office tools are absent when office is disabled but D396 officecli remains", () => {
    expect(catalog.get("office")).toBeUndefined();
    expect(catalog.get("edit_doc")).toBeUndefined();
    expect(catalog.get("officecli")).toBeDefined();
    expect(catalog.get("officecli")?.exposure).toBe("discoverable");
    const names = catalog.getFiltered().entries.map((e) => e.name);
    expect(names).not.toContain("office");
    expect(names).not.toContain("edit_doc");
    expect(names).toContain("officecli");
    const attemptedActivation = catalog.resolveProgressiveTools({
      activatedToolNames: ["office", "edit_doc", "officecli"],
    });
    expect(attemptedActivation.snapshot.entries.map((entry) => entry.name)).toContain("officecli");
    expect(attemptedActivation.snapshot.entries.map((entry) => entry.name)).not.toContain("office");
    expect(attemptedActivation.snapshot.entries.map((entry) => entry.name)).not.toContain("edit_doc");
  });

  test("D362 office tools register when office is enabled", () => {
    setConfigOverrides({ nautilo_office_enabled: true });
    const enabledCatalog = new ToolCatalog();
    registerAllTools(enabledCatalog, { officeCliAvailable: () => true, publicBrowserUseAvailable: () => true });
    setConfigOverrides({ nautilo_office_enabled: false });

    expect(enabledCatalog.get("office")).toBeDefined();
    expect(enabledCatalog.get("edit_doc")).toBeDefined();
    expect(enabledCatalog.get("officecli")).toBeDefined();
    expect(enabledCatalog.get("office")?.exposure).toBe("discoverable");
    expect(enabledCatalog.get("edit_doc")?.exposure).toBe("discoverable");
    expect(enabledCatalog.get("officecli")?.exposure).toBe("discoverable");
    const names = enabledCatalog.getFiltered().entries.map((e) => e.name);
    expect(names).toContain("office");
    expect(names).toContain("edit_doc");
    expect(names).toContain("officecli");
    const deferredByDefault = enabledCatalog.resolveProgressiveTools();
    expect(deferredByDefault.snapshot.entries.map((entry) => entry.name)).not.toContain("office");
    expect(deferredByDefault.snapshot.entries.map((entry) => entry.name)).not.toContain("edit_doc");
    const activated = enabledCatalog.resolveProgressiveTools({
      activatedToolNames: ["office", "edit_doc"],
    });
    const activatedNames = activated.snapshot.entries.map((entry) => entry.name);
    expect(activatedNames).toContain("office");
    expect(activatedNames).toContain("edit_doc");
  });

  test("D419 manifest classifies all conditionally-enabled catalog registrations", () => {
    setConfigOverrides({ nautilo_office_enabled: true });
    const fullCatalog = new ToolCatalog();
    registerAllTools(fullCatalog, {
      officeCliAvailable: () => true, publicBrowserUseAvailable: () => true,
      mediaGenerationAvailable: () => true,
    });
    setConfigOverrides({ nautilo_office_enabled: false });

    expect(() =>
      validateToolExposureManifest(fullCatalog.query({}).map((entry) => entry.name)),
    ).not.toThrow();
  });

  test("M203 officecli is omitted when no usable OfficeCLI binary is available", () => {
    const gatedCatalog = new ToolCatalog();
    registerAllTools(gatedCatalog, { officeCliAvailable: () => false, publicBrowserUseAvailable: () => true });
    expect(gatedCatalog.get("officecli")).toBeUndefined();
    const names = gatedCatalog.getFiltered().entries.map((e) => e.name);
    expect(names).not.toContain("officecli");
    // Exactly one fewer tool than the available-binary case.
    expect(gatedCatalog.size).toBe(catalog.size - 1);
  });

  test("transcribe_audio is high-impact and requires explicit approval", () => {
    const entry = catalog.get("transcribe_audio");
    expect(entry).toBeDefined();
    expect(entry!.impact).toBe("high");
    expect(entry!.requiresApproval).toBe(true);
    expect(entry!.approvalLevel).toBe("confirm");
    // M128 — `transcribe_audio` is gated on the dedicated
    // `use_transcription` capability (was `use_high_impact_tools`).
    expect(entry!.requiredCapabilities).toContain("use_transcription");
    expect(entry!.resultScanPolicy).toBe("on-suspicious");
    expect(catalog.getToolPolicy("transcribe_audio")).toEqual({
      impact: "high",
      requiredCapability: "use_transcription",
      requiresApproval: true,
      approvalLevel: "confirm",
    });
  });

  test("D419 catalog capability gates match trust policies and policy filtering", () => {
    const entries = [
      ["search_memory", "read_memories"],
      ["manage_memory", "manage_memories"],
      ["check_config", "read_server_settings"],
    ] as const;

    const forbiddenPolicy = Object.fromEntries(
      entries.map(([name]) => [name, "forbidden"]),
    );
    const visibleNames = catalog
      .getFiltered(forbiddenPolicy)
      .entries.map((entry) => entry.name);

    for (const [name, capability] of entries) {
      const catalogEntry = catalog.get(name);
      expect(catalogEntry?.requiredCapabilities).toEqual([capability]);
      expect(catalog.getToolPolicy(name).requiredCapability).toBe(capability);
      expect(getTrustToolPolicy(name).requiredCapability).toBe(capability);
      expect(visibleNames).not.toContain(name);
    }
  });

  test("all tools have descriptions", () => {
    for (const name of ["search_memory", "run_shell", "discover_tools", "guide_user", "find_explainer", "play_explainer", "run_deep_research"]) {
      const entry = catalog.get(name);
      expect(entry).toBeDefined();
      expect(entry!.description.length).toBeGreaterThan(10);
    }
  });

  test("admin tier tools include run_shell, update_config, verify_identity (with relay)", () => {
    const snap = catalog.getFiltered(undefined, {
      canReadWorkspace: true, canWriteWorkspace: true, canRunShell: true,
    });
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain("run_shell");
    expect(names).toContain("update_config");
    expect(names).toContain("verify_identity");
  });

  test("without toolPolicy cloud tools visible regardless of trustTier (M133)", () => {
    const snap = catalog.getFiltered();
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain("discover_tools");
    expect(names).toContain("find_explainer");
    expect(names).toContain("play_explainer");
    expect(names).toContain("search_memory");
    // run_shell is relay-gated separately — see admin snapshot test with relay tokens
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("desktop_click");
  });

  test("toolPolicy forbidden excludes tools regardless of trustTier metadata", () => {
    const snap = catalog.getFiltered({ search_memory: "forbidden" });
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain("discover_tools");
    expect(names).not.toContain("search_memory");
  });

  test("getToolsForActor returns StructuredTool instances", () => {
    const tools = catalog.getToolsForActor({});
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.invoke).toBe("function");
    }
  });

  test("forbidden policy excludes tools", () => {
    const snap = catalog.getFiltered({ search_memory: "forbidden" });
    const names = snap.entries.map((e) => e.name);
    expect(names).not.toContain("search_memory");
  });

  test("filesystem and shell tools include unified `file` + run_shell", () => {
    const snap = catalog.getFiltered(undefined, { canRunShell: true });
    const names = snap.entries.map((e) => e.name);
    expect(names).toContain("file");
    expect(names).toContain("run_shell");
    expect(names).toContain("apply_patch");
  });

  test("D448 apply_patch is core, destructive, project-content gated, and always scanned", () => {
    const entry = catalog.get("apply_patch");
    expect(entry).toMatchObject({
      exposure: "core",
      impact: "destructive",
      requiredCapabilities: ["use_project_content"],
      requiresApproval: true,
      approvalLevel: "prove_it",
      resultScanPolicy: "always",
    });
  });

  test("D513 guide_user is discoverable, read-only guidance with no approval", () => {
    const entry = catalog.get("guide_user");
    expect(entry).toMatchObject({
      category: "help",
      discoveryCategories: ["settings"],
      trustTier: "standard",
      impact: "read-only",
      exposure: "discoverable",
      requiredCapabilities: [],
      requiresApproval: false,
    });
    for (const tag of ["help", "settings", "config", "navigation"]) {
      expect(entry?.tags).toContain(tag);
    }
  });

  test("all tools have unique names", () => {
    const tools = catalog.getToolsForActor({});
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("strict catalog validation passes after built-in registration", () => {
    expect(() => catalog.validate({ requireExposure: true })).not.toThrow();
  });

  test("obsolete desktop_* tools are absent from the catalog", () => {
    for (const name of ["desktop_app", "desktop_window", "desktop_menu", "desktop_inspect", "desktop_see", "desktop_click", "desktop_type", "desktop_key"]) {
      expect(catalog.get(name)).toBeUndefined();
    }
    expect(catalog.get("computer_observe")).toBeDefined();
    expect(catalog.get("computer_do")).toBeDefined();
    expect(catalog.get("computer_verify")).toBeDefined();
  });

  test("stats reflect correct distribution", () => {
    const stats = catalog.getStats();
    // D079 Phase 4 / G3 commit 5: +1 for the unified `file` tool.
    // D073 Sprint 2: +1 for sandboxed `execute_artifact`;
    // D066: +1 for transcribe_audio; D041: +4 Connection tools.
    // M078: +2; M080: +4.
    // M088B: removed legacy read_file / write_file / list_directory (-3).
    // D128: +1 skip. D261: +1 manage_voices; P4: +1 audition_voices.
    // M137: +1 get_room_members.
    // M087: +1 get_current_time.
    // M144: +3 in_scope / in_private_namespace / in_background.
    // M145: +1 schedule.
    // D263: +1 skill_manage, +1 view_skill.
    // D263 Stack 80: +1 discover_skills, +1 eject.
    // M148: -2 delegate_to_subagent + do_in_private_namespace (sunset).
    // M151: +1 ask_peer.
    // M189: +1 mini_app (→ 57).
    // D336/D138: +1 snapshot, +4 act/read, +3 screenshot/mouse/get, +1 scroll,
    // +1 google_workspace (→ 67).
    // D363: +1 generate_repo_docs (→ 68).
    // D373: +1 terminal (→ 69).
    // D379: +4 command_* tools (→ 73), +1 launch_customization (→ 74).
    // D396: +1 officecli (bundled headless, always registered → 75).
    // D384 §5.4: +1 manage_local_mcp (→ 76).
    // Stack 163: +1 manage_avatar (→ 77).
    // D055 Stack 173: +1 hue_lights (→ 78).
    // D417: +1 ingest_local_media +1 extract_audio_from_video (→ 80).
    // D419 Phase 1: +1 activate_tools (→ 81).
    // D419 Phase 2.3: +1 deactivate_tools (→ 82).
    // D416: +1 find_explainer, +1 user-consented play_explainer (→ 84).
    // D429 Phase 2: +1 discover_models (→ 85).
    // D421 Phase 6.4: redirect_to_agent folded into skip (removed; → 85).
    // D448 adds top-level core apply_patch (→ 86).
    // D362 office + edit_doc are feature-flagged off by default.
    // D490 browser work: +11 open/navigation/interaction/wait tools (→ 89).
    // D497: +1 select_current_folder (→ 90). D500: +2 structured SSH tools;
    // D500 continuation retrieval adds one read-only tool (→ 95).
    // D504: +1 browser_read_page (→ 96). D513: +1 guide_user (→ 97).
    // M271: +1 invocation-bound recall_records (→ 98).
    // D568 adds read_connected_web_account plus its action and two operation
    // control tools (→ 103). D525 contributes two live-gated paid media
    // registrations (→ 105).
    // D585 adds anonymous public browse_web (→ 106).
    // run_website_task makes the static baseline 107; the active signed Computer Use catalogue is
    // the sole owner of its additional tool count.
    expect(stats.total).toBe(107 + activeComputerUseHostToolDefinitions().length);
    expect(stats.bySource.builtin).toBe(107 + activeComputerUseHostToolDefinitions().length);
    expect(stats.bySource.mcp).toBe(0);
    expect(stats.enabled).toBe(107 + activeComputerUseHostToolDefinitions().length);
    expect(stats.byTier.admin).toBeGreaterThan(0);
    expect(stats.byTier.standard).toBeGreaterThan(0);
    expect(stats.byTier.high).toBeGreaterThan(0);
    expect(stats.byTier.guest).toBeGreaterThan(0);
  });

  test("D041 Connection tools are registered without exposing values", () => {
    const names = catalog.getFiltered().entries.map((e) => e.name);
    expect(names).not.toContain("store_connection");
    expect(names).toContain("use_connection");
    expect(names).toContain("list_connections");
    expect(names).toContain("use_credential");
    expect(names).toContain("delete_connection");
  });

  // D429 Task 2.2.1 — Phase 0 decision #4: the full `discover_models`
  // projection is standard-tier/authenticated. The guest picker projection
  // lives on the separate HTTP route `GET /api/config/models`, which is
  // intentionally left guest-readable and is not exercised here. This test
  // pins the catalog-side boundary: the tier label, the guest withhold via
  // the production guest toolPolicy (GUEST_ALLOWED_TOOLS), and the
  // authenticated-actor eligibility.
  test("D429 Task 2.2.1 — discover_models is standard-tier, withheld from guests, available to authenticated actors", () => {
    const entry = catalog.get("discover_models");
    expect(entry).toBeDefined();
    expect(entry!.trustTier).toBe("standard");
    expect(entry!.impact).toBe("read-only");
    expect(entry!.exposure).toBe("core");

    // This assertion is intentionally local to discover_models. The complete
    // production guest policy is covered in trust tests; rebuilding it here
    // would couple this catalog unit test to process-global catalog state.
    const guestPolicy = { discover_models: "forbidden" as const };
    const guestVisible = catalog.getFiltered(guestPolicy).entries.map((e) => e.name);
    expect(guestVisible).not.toContain("discover_models");
    // Sanity: the guest surface still carries the picker-adjacent discovery
    // tools, so this is a discover_models-specific withhold, not a blanket
    // exclusion artifact.
    expect(guestVisible).toContain("discover_tools");
    expect(guestVisible).toContain("run_web_search");

    // An authenticated (non-guest) actor carries no forbidding policy, so the
    // standard-tier tool is eligible for exposure.
    const authedVisible = catalog.getFiltered().entries.map((e) => e.name);
    expect(authedVisible).toContain("discover_models");
  });
});
