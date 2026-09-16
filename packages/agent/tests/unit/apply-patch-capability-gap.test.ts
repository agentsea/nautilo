/**
 * D448 Phase 2.1 — top-level apply_patch exposure and provider contract.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import {
  APPLY_PATCH_TOOL_DESCRIPTION,
  createApplyPatchTool,
  type ApplyPatchExecutionPort,
} from "../../src/tools/apply-patch/apply-patch-tool";
import { convertToolToSanitizedOpenAITool } from "../../src/providers/gemini-schema";
import { CORE_TOOL_NAMES, TOOL_EXPOSURE_MANIFEST } from "../../src/tools/exposure/manifest";
import { registerAllTools } from "../../src/tools/register-all";

const FIXTURE_ROOT = join(import.meta.dir, "../fixtures/apply-patch/capability");
const PATCH = readFileSync(join(FIXTURE_ROOT, "multi-file-20.patch"), "utf8");

type Phase0TopLevelAbsenceBaselineFixture = {
  readonly version: number;
  readonly status: "frozen_phase0_baseline";
  readonly topLevelApplyPatch: "apply_patch";
  readonly historicalCatalogAbsence: { readonly registered: false; readonly coreManifest: false };
  readonly historicalInternalFileCommand: {
    readonly tool: "file";
    readonly command: "apply_patch";
    readonly accepted: false;
  };
};

type ProviderFixture = {
  readonly version: number;
  readonly status: "implemented";
  readonly tool: "apply_patch";
  readonly arguments: { readonly patch: string; readonly target: "workspace" | "current" };
  readonly parameters: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["patch"];
    readonly properties: {
      readonly patch: {
        readonly type: "string";
        readonly minLength: 1;
        readonly description: "A complete Codex apply_patch body bounded by *** Begin Patch and *** End Patch.";
      };
      readonly target: {
        readonly type: "string";
        readonly enum: readonly ["workspace", "current"];
        readonly description: "Optional non-authoritative target selector. Omit only when exactly one target is eligible.";
      };
    };
  };
};

type Phase0MultiFileBaselineFixture = {
  readonly version: number;
  readonly status: "frozen_phase0_baseline";
  readonly files: readonly string[];
  readonly historicalFileWorkflow: {
    readonly tool: "file";
    readonly command: "str_replace";
    readonly calls: number;
    readonly oneFilePerCall: true;
  };
  readonly recordedApplyPatchComparison: {
    readonly tool: "apply_patch";
    readonly calls: number;
    readonly argument: "patch";
    readonly grammar: "codex_apply_patch";
    readonly fixture: "multi-file-20.patch";
  };
};

type SafeParseSchema = {
  safeParse(input: unknown): { readonly success: boolean; readonly data?: unknown };
};

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), "utf8")) as T;
}

const phase0TopLevelAbsenceBaseline = readFixture<Phase0TopLevelAbsenceBaselineFixture>("phase0-top-level-absence-baseline.json");
const provider = readFixture<ProviderFixture>("provider-schema.json");
const phase0MultiFileBaseline = readFixture<Phase0MultiFileBaselineFixture>("phase0-multi-file-20-baseline.json");

function createCatalog(): ToolCatalog {
  setConfigOverrides({ nautilo_office_enabled: false });
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { officeCliAvailable: () => true });
  return catalog;
}

function acceptsPatchAndOptionalTarget(tool: { readonly name: string; readonly schema?: unknown }): boolean {
  const schema = tool.schema;
  if (!schema || typeof schema !== "object" || !("safeParse" in schema) || typeof schema.safeParse !== "function") {
    return false;
  }
  const omitted = (schema as SafeParseSchema).safeParse({ patch: PATCH });
  const selected = (schema as SafeParseSchema).safeParse({ patch: PATCH, target: "current" });
  if (!omitted.success || !selected.success || !omitted.data || !selected.data ||
      typeof omitted.data !== "object" || typeof selected.data !== "object" ||
      Array.isArray(omitted.data) || Array.isArray(selected.data)) return false;
  const omittedArgs = omitted.data as Record<string, unknown>;
  const selectedArgs = selected.data as Record<string, unknown>;
  return Object.keys(omittedArgs).length === 1 && omittedArgs["patch"] === PATCH &&
    Object.keys(selectedArgs).length === 2 && selectedArgs["patch"] === PATCH && selectedArgs["target"] === "current";
}

describe("D448 top-level apply_patch capability", () => {
  test("describes the Desktop Current Folder boundary without promising atomicity", () => {
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("Core baseline tool");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("Desktop authority and runtime availability fail closed");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("Desktop Current Folder");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("Workspace artifacts are not supported");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("target workspace returns an unsupported-target error");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("Prefer repository-relative paths");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("existing Current Folder authority decides whether a path form can be reached");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("*** Update File: <source>");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("*** Move to: <destination>");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("never attach *** Move to: to a delete block");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("about three context lines by default");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("@@ class/function anchors");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("Partial outcomes are possible");
    expect(APPLY_PATCH_TOOL_DESCRIPTION).not.toMatch(/relative paths under (?:that |one )?(?:authorized )?root/i);
    expect(APPLY_PATCH_TOOL_DESCRIPTION).not.toMatch(/do not include .*absolute paths/i);
    expect(APPLY_PATCH_TOOL_DESCRIPTION.toLowerCase()).not.toContain("atomic");
  });

  test("keeps the frozen Phase 0 top-level absence record separate from the implemented core tool", () => {
    const catalog = createCatalog();

    expect(phase0TopLevelAbsenceBaseline.status).toBe("frozen_phase0_baseline");
    expect(phase0TopLevelAbsenceBaseline.historicalCatalogAbsence).toEqual({ registered: false, coreManifest: false });
    expect(catalog.has(phase0TopLevelAbsenceBaseline.topLevelApplyPatch)).toBe(true);
    expect(catalog.get(phase0TopLevelAbsenceBaseline.topLevelApplyPatch)).toMatchObject({
      exposure: "core",
      impact: "destructive",
      requiredCapabilities: ["use_project_content"],
      resultScanPolicy: "always",
    });
    expect(CORE_TOOL_NAMES).toContain(phase0TopLevelAbsenceBaseline.topLevelApplyPatch);
    expect(TOOL_EXPOSURE_MANIFEST.coreToolNames).toContain(phase0TopLevelAbsenceBaseline.topLevelApplyPatch);
    expect(TOOL_EXPOSURE_MANIFEST.families.filesystem).toContain("file");
    expect(TOOL_EXPOSURE_MANIFEST.families.filesystem).not.toContain(phase0TopLevelAbsenceBaseline.topLevelApplyPatch);
  });

  test("the provider-bound tool set exposes a strict patch route with an optional non-authoritative selector", async () => {
    const catalog = createCatalog();
    const calls: unknown[] = [];
    const port: ApplyPatchExecutionPort = {
      async execute(input) {
        calls.push(input);
        return { ok: true };
      },
    };
    const providerTools = catalog.getToolsForActor({
      actorRole: "owner",
      applyPatchExecutionPort: port,
    });
    const applyPatch = providerTools.find((tool) => tool.name === provider.tool);

    expect(providerTools.map((tool) => tool.name)).toContain(provider.tool);
    expect(applyPatch).toBeDefined();
    expect(acceptsPatchAndOptionalTarget(applyPatch as { name: string; schema?: unknown })).toBe(true);
    expect(
      (applyPatch!.schema as unknown as SafeParseSchema).safeParse({ patch: PATCH, zone: "workspace" }).success,
    ).toBe(false);
    expect(await Promise.resolve(applyPatch!.invoke({ patch: PATCH, target: "current" }))).toBe(JSON.stringify({ ok: true }));
    expect(calls).toEqual([{ patch: PATCH, target: "current" }]);
  });

  test("retains the frozen Phase 0 twenty-file comparison as historical evidence, not an implementation claim", () => {
    expect(phase0MultiFileBaseline.version).toBe(1);
    expect(phase0MultiFileBaseline.status).toBe("frozen_phase0_baseline");
    expect(new Set(phase0MultiFileBaseline.files).size).toBe(20);
    expect(phase0MultiFileBaseline.historicalFileWorkflow).toEqual({
      tool: "file",
      command: "str_replace",
      calls: 20,
      oneFilePerCall: true,
    });
    expect(phase0MultiFileBaseline.historicalFileWorkflow.calls).toBe(phase0MultiFileBaseline.files.length);
    expect(phase0MultiFileBaseline.recordedApplyPatchComparison).toEqual({
      tool: provider.tool,
      calls: 1,
      argument: "patch",
      grammar: "codex_apply_patch",
      fixture: "multi-file-20.patch",
    });
    expect(PATCH.startsWith("*** Begin Patch\n")).toBe(true);
    expect(PATCH.trimEnd().endsWith("*** End Patch")).toBe(true);
    expect((PATCH.match(/^\*\*\* Update File: /gm) ?? [])).toHaveLength(phase0MultiFileBaseline.files.length);
  });

  test("the provider fixture retains a required patch and strict optional target selector", () => {
    expect(provider.status).toBe("implemented");
    const generated = convertToolToSanitizedOpenAITool(createApplyPatchTool()) as {
      function: { parameters: unknown };
    };
    expect(generated.function.parameters).toEqual(provider.parameters);
    expect(provider.arguments.patch).toContain("multi-file-20.patch");
    expect(provider.arguments.target).toBe("current");
  });

  test("fails closed without a trusted execution port", async () => {
    const tool = createApplyPatchTool();
    expect(await Promise.resolve(tool.invoke({ patch: PATCH }))).toContain("missing_context");
  });

  test("forwards an explicit target selector only to the trusted execution port", async () => {
    const calls: unknown[] = [];
    const tool = createApplyPatchTool({
      applyPatchExecutionPort: {
        async execute(input) {
          calls.push(input);
          return {
            ok: false,
            error: {
              code: "stale_context",
              message: "The bound Current Folder has no single pinned desktop relay.",
              retryable: true,
            },
          };
        },
      },
    });

    expect(await Promise.resolve(tool.invoke({ patch: PATCH, target: "current" }))).toBe(JSON.stringify({
      ok: false,
      error: {
        code: "stale_context",
        message: "The bound Current Folder has no single pinned desktop relay.",
        retryable: true,
      },
    }));
    expect(calls).toEqual([{ patch: PATCH, target: "current" }]);
  });
});
