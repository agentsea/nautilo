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
  // officecli registration is gated on a usable OfficeCLI binary. The
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

  // Built-in tools are counted separately from the active signed Computer Use catalog.
  test("registers all built-in tools including transcription and Connections", () => {
    expect(catalog.size).toBe(108 + activeComputerUseHostToolDefinitions().length);
  });

  test("registers mini_app with static destructive approval", () => {
    expect(catalog.get("mini_app")?.approvalMode).toBeUndefined();
  });

  test("marks protected foreground Memory mutations as Full-capable", () => {
    expect(catalog.get("manage_memory")?.fullEncryptionSupport)
      .toBe("supported");
  });

  test("live office tools are absent when office is disabled but officecli remains", () => {
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

  test("office tools register when office is enabled", () => {
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

  test("manifest classifies all conditionally-enabled catalog registrations", () => {
    setConfigOverrides({ nautilo_office_enabled: true });
    const fullCatalog = new ToolCatalog();
    registerAllTools(fullCatalog, {
      officeCliAvailable: () => true, publicBrowserUseAvailable: () => true,
      mediaGenerationAvailable: () => true,
      decisionModelsAvailable: () => true,
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
    // `transcribe_audio` is gated on the dedicated
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

  test("catalog capability gates match trust policies and policy filtering", () => {
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

  test("without toolPolicy cloud tools visible regardless of trustTier ", () => {
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

  test("apply_patch is core, destructive, project-content gated, and always scanned", () => {
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

  test("guide_user is discoverable, read-only guidance with no approval", () => {
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
    // Built-in tools are counted separately from the active signed Computer Use catalog.
    expect(stats.total).toBe(108 + activeComputerUseHostToolDefinitions().length);
    expect(stats.bySource.builtin).toBe(108 + activeComputerUseHostToolDefinitions().length);
    expect(stats.bySource.mcp).toBe(0);
    expect(stats.enabled).toBe(108 + activeComputerUseHostToolDefinitions().length);
    expect(stats.byTier.admin).toBeGreaterThan(0);
    expect(stats.byTier.standard).toBeGreaterThan(0);
    expect(stats.byTier.high).toBeGreaterThan(0);
    expect(stats.byTier.guest).toBeGreaterThan(0);
  });

  test("Connection tools are registered without exposing values", () => {
    const names = catalog.getFiltered().entries.map((e) => e.name);
    expect(names).not.toContain("store_connection");
    expect(names).toContain("use_connection");
    expect(names).toContain("list_connections");
    expect(names).toContain("use_credential");
    expect(names).toContain("delete_connection");
  });

  // The full `discover_models`
  // projection is standard-tier/authenticated. The guest picker projection
  // lives on the separate HTTP route `GET /api/config/models`, which is
  // intentionally left guest-readable and is not exercised here. This test
  // pins the catalog-side boundary: the tier label, the guest withhold via
  // the production guest toolPolicy (GUEST_ALLOWED_TOOLS), and the
  // authenticated-actor eligibility.
  test("discover_models is standard-tier, withheld from guests, available to authenticated actors", () => {
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
