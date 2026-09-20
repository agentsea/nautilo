import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import {
  CORE_TOOL_NAMES,
  activeComputerUseCoreToolNames,
  EMBEDDED_BROWSER_TOOL_NAMES,
  expandToolFamilies,
  MAX_ACTIVATED_FAMILY_MEMBERS,
  TOOL_EXPOSURE_MANIFEST,
  type ToolExposureManifest,
  validateCoreFamilyPartition,
  validateNoDuplicateToolMembership,
  validateNoUnknownToolNames,
  validateToolExposureManifest,
} from "../../src/tools/exposure/manifest";
import { registerAllTools } from "../../src/tools/register-all";

let registeredToolNames: string[];
let registeredToolExposure: ReadonlyMap<string, string | undefined>;
const ORIGINAL_TAVILY_API_KEY = process.env["TAVILY_API_KEY"];

beforeAll(() => {
  // Build the catalog with every conditional built-in enabled, rather than
  // hand-maintaining another list of names alongside register-all.ts.
  setConfigOverrides({ nautilo_office_enabled: true });
  process.env["TAVILY_API_KEY"] = "test-key";
  const catalog = new ToolCatalog();
  registerAllTools(catalog, {
    officeCliAvailable: () => true,
    mediaGenerationAvailable: () => true,
    publicBrowserUseAvailable: () => true,
    decisionModelsAvailable: () => true,
  });
  const entries = catalog.query({});
  registeredToolNames = entries.map((entry) => entry.name);
  registeredToolExposure = new Map(entries.map((entry) => [entry.name, entry.exposure]));
  setConfigOverrides({ nautilo_office_enabled: false });
});

afterAll(() => {
  if (ORIGINAL_TAVILY_API_KEY !== undefined) process.env["TAVILY_API_KEY"] = ORIGINAL_TAVILY_API_KEY;
  else delete process.env["TAVILY_API_KEY"];
});

describe("tool exposure manifest", () => {
  test("keeps the reviewed canonical core set", () => {
    expect(CORE_TOOL_NAMES).toEqual([
      "apply_patch",
      "discover_tools",
      "discover_models",
      "activate_tools",
      "deactivate_tools",
      "discover_skills",
      "view_skill",
      "eject",
      "discover_commands",
      "view_command",
      "eject_command",
      "search_memory",
      "recall_records",
      "manage_memory",
      "skip",
      "react",
      "in_background",
      "schedule",
      "in_scope",
      "run_web_search",
      "read_webpage",
      "browse_web",
      "run_website_task",
      "read_connected_web_account",
      "manage_connected_web_operation",
      "control_connected_web_operation",
      "verify_identity",
      ...EMBEDDED_BROWSER_TOOL_NAMES,
    ]);
  });

  test("keeps the complete embedded-browser family in core rather than deferred activation", () => {
    expect(TOOL_EXPOSURE_MANIFEST.families.browser).toEqual([]);
    for (const name of EMBEDDED_BROWSER_TOOL_NAMES) {
      expect(CORE_TOOL_NAMES).toContain(name);
      expect(registeredToolExposure.get(name)).toBe("core");
    }
  });

  test("partitions every actual built-in registration", () => {
    expect(() => validateToolExposureManifest(registeredToolNames)).not.toThrow();
  });

  test("classifies guide_user as discoverable configuration guidance", () => {
    expect(TOOL_EXPOSURE_MANIFEST.families.configuration).toContain("guide_user");
    expect(registeredToolExposure.get("guide_user")).toBe("discoverable");
  });

  test("expands reviewed family members in canonical order, deduplicated and bounded", () => {
    expect(expandToolFamilies(["shell", "shell"])).toEqual(
      [...TOOL_EXPOSURE_MANIFEST.families.shell],
    );

    const oversizedManifest: ToolExposureManifest = {
      ...TOOL_EXPOSURE_MANIFEST,
      families: {
        ...TOOL_EXPOSURE_MANIFEST.families,
        shell: Array.from(
          { length: MAX_ACTIVATED_FAMILY_MEMBERS + 1 },
          (_, index) => `shell_${index}`,
        ),
      },
    };
    expect(() => expandToolFamilies(["shell"], oversizedManifest)).toThrow(
      `exceeds ${MAX_ACTIVATED_FAMILY_MEMBERS} members`,
    );
  });

  test("matches every built-in registration's explicit exposure to the manifest", () => {
    const core = new Set([
      ...TOOL_EXPOSURE_MANIFEST.coreToolNames,
      ...activeComputerUseCoreToolNames(),
    ]);
    for (const name of registeredToolNames) {
      expect(
        registeredToolExposure.get(name),
        `built-in "${name}" must declare its manifest exposure`,
      ).toBe(core.has(name) ? "core" : "discoverable");
    }
  });

  test("rejects duplicate, unknown, and unclassified registrations", () => {
    const duplicateManifest = {
      ...TOOL_EXPOSURE_MANIFEST,
      families: {
        ...TOOL_EXPOSURE_MANIFEST.families,
        shell: [...TOOL_EXPOSURE_MANIFEST.families.shell, "file"],
      },
    };
    expect(() => validateNoDuplicateToolMembership(duplicateManifest)).toThrow(
      'assigns "file"',
    );

    const unknownManifest = {
      ...TOOL_EXPOSURE_MANIFEST,
      families: {
        ...TOOL_EXPOSURE_MANIFEST.families,
        research: [...TOOL_EXPOSURE_MANIFEST.families.research, "not_registered"],
      },
    };
    expect(() => validateNoUnknownToolNames(unknownManifest, registeredToolNames)).toThrow(
      "not_registered",
    );

    expect(() =>
      validateCoreFamilyPartition(TOOL_EXPOSURE_MANIFEST, [
        ...registeredToolNames,
        "unclassified_tool",
      ]),
    ).toThrow("unclassified_tool");
  });
});
