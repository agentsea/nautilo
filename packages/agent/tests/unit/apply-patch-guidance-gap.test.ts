/**
 * D448 Phase 4.1/4.2 — executable contract for top-level apply_patch
 * guidance in the canonical prompt and developer-workstation skill.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { FILE_TOOL_ALL_COMMAND_NAMES, fileToolSchema } from "../../src/tools/file/schema";
import { CORE_TOOL_NAMES, TOOL_EXPOSURE_MANIFEST } from "../../src/tools/exposure/manifest";
import { registerAllTools } from "../../src/tools/register-all";

const AGENT_ROOT = join(import.meta.dir, "../..");
const FIXTURE_ROOT = join(AGENT_ROOT, "tests/fixtures/apply-patch/capability");

type GuidanceContract = {
  readonly version: number;
  readonly status: "guidance_complete";
  readonly scope: string;
  readonly baseline: {
    readonly topLevelApplyPatch: {
      readonly tool: "apply_patch";
      readonly registered: true;
      readonly core: true;
      readonly promptOrSkillGuidancePresent: true;
    };
    readonly historicalInternalFileApplyPatch: {
      readonly identifier: "file.apply_patch";
      readonly meaning: string;
    };
    readonly additionalUnifiedFileTool: {
      readonly tool: "file";
      readonly exposure: "discoverable";
      readonly core: false;
      readonly features: readonly ["glob", "grep", "read", "write", "history"];
      readonly commands: readonly string[];
      readonly discoveryPath: readonly ["discover_tools", "activate_tools", "file"];
    };
  };
  readonly requiredGuidance: {
    readonly supported: readonly { readonly tool: string; readonly when: string; readonly modes?: readonly string[]; readonly benefit?: string }[];
    readonly unsupported: readonly { readonly targets: readonly string[]; readonly route: string }[];
    readonly workflow: readonly string[];
  };
};

function readFixture(): GuidanceContract {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, "guidance-contract.json"), "utf8")) as GuidanceContract;
}

function createCatalog(): ToolCatalog {
  setConfigOverrides({ nautilo_office_enabled: false });
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { officeCliAvailable: () => true });
  return catalog;
}

function bundledSkillSource(): string {
  const bundledSkills = join(AGENT_ROOT, "src/skills/bundled");
  return readdirSync(bundledSkills)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(bundledSkills, name), "utf8"))
    .join("\n");
}

const contract = readFixture();

describe("D448 apply_patch guidance", () => {
  test("records the supported and unsupported decision table", () => {
    expect(contract.version).toBe(1);
    expect(contract.status).toBe("guidance_complete");
    expect(contract.scope).toMatch(/top-level apply_patch workflow/i);
    expect(contract.requiredGuidance.supported).toEqual([
      {
        tool: "file.write",
        when: "Create one new UTF-8 file or workspace artifact.",
        modes: ["overwrite", "append", "prepend"],
      },
      {
        tool: "file.write",
        when: "Intentionally replace the whole existing UTF-8 file.",
        modes: ["overwrite"],
      },
      {
        tool: "apply_patch",
        when: "Make contextual edits to existing Current Folder UTF-8 text after acquiring file context.",
        benefit: "Preserves untouched portions of large files.",
      },
      {
        tool: "apply_patch",
        when: "Make one coherent Current Folder UTF-8 Add, Update, Move, or Delete change across multiple files.",
        benefit: "Expresses the related operation set in one patch.",
      },
    ]);
    expect(contract.requiredGuidance.unsupported).toEqual([
      { targets: ["non-UTF-8", "binary"], route: "Do not use apply_patch." },
      {
        targets: ["images", "media", "fonts", "archives", "executables", "databases"],
        route: "Use a dedicated binary or format-aware tool.",
      },
      {
        targets: ["PDF", "OOXML containers"],
        route: "Use format-aware document tools, not apply_patch or raw file.write bytes.",
      },
      {
        targets: ["Workspace artifacts"],
        route: "Use file.list, file.read, and artifact-aware file mutation commands; Workspace glob, grep, and apply_patch are unsupported.",
      },
    ]);
  });

  test("exposes top-level apply_patch as core and documents it in the canonical prompt and skill", () => {
    const catalog = createCatalog();
    const templateSource = readFileSync(join(AGENT_ROOT, "src/prompts/templates.ts"), "utf8");
    const skillSource = bundledSkillSource();
    const historicalPipelineSource = readFileSync(join(AGENT_ROOT, "src/index.ts"), "utf8");

    expect(contract.baseline.topLevelApplyPatch).toEqual({
      tool: "apply_patch",
      registered: true,
      core: true,
      promptOrSkillGuidancePresent: true,
    });
    expect(catalog.has(contract.baseline.topLevelApplyPatch.tool)).toBe(true);
    expect(CORE_TOOL_NAMES).toContain(contract.baseline.topLevelApplyPatch.tool);
    expect(TOOL_EXPOSURE_MANIFEST.coreToolNames).toContain(contract.baseline.topLevelApplyPatch.tool);
    expect(templateSource).toContain("Core tools are an always-present baseline, never the complete inventory.");
    expect(templateSource).toContain("Eligible development requests receive it on the first call");
    expect(templateSource).toContain("Markdown, plain, and extensionless text; JSON/JSONL/YAML/TOML/INI/dotenv where policy permits");
    expect(templateSource).toContain("HTML/CSS/XML/text SVG; and CSV/TSV/SQL/GraphQL/shell");
    expect(templateSource).toContain("glob → grep → read → \\`apply_patch\\` → focused \\`run_shell\\` verification");
    expect(templateSource).toContain("historical internal \\`file.apply_patch(patchId)\\` pipeline");
    expect(templateSource).toContain("\\`file.glob\\`, \\`file.grep\\`, and top-level \\`apply_patch\\` are Desktop-local");
    expect(templateSource).toContain("For Workspace, use \\`file.list\\` with a logical path prefix");
    expect(templateSource).toContain("Workspace full-text search and multi-file patching are unavailable");
    expect(templateSource).toContain("\\`target:\"workspace\"\\` returns an unsupported-target error");
    expect(templateSource).toContain("Prefer repository-relative Current Folder paths");
    expect(templateSource).toContain("about three context lines by default");
    expect(templateSource).toContain("\\`@@\\` class/function anchors");
    expect(templateSource).toContain("generator, formatter, or script");
    expect(templateSource).not.toContain("Patch operations use relative paths under one authorized root");
    expect(templateSource).not.toContain("Do not include separate routing fields or absolute paths");
    expect(skillSource).toContain("# Developer Workstation — Skill");
    expect(skillSource).toContain("Core is an always-present baseline, never the complete inventory.");
    expect(skillSource).toContain("Markdown, plain, and extensionless\ntext; JSON/JSONL/YAML/TOML/INI/dotenv where policy permits");
    expect(skillSource).toContain("SVG; and CSV/TSV/SQL/GraphQL/shell");
    expect(skillSource).toContain("file.undo_turn");
    expect(skillSource).toContain("`file.glob`, `file.grep`, and top-level `apply_patch` are Desktop-local");
    expect(skillSource).toContain("For Workspace, use `file.list` with a");
    expect(skillSource).toContain("Workspace full-text search and multi-file patching are unavailable");
    expect(skillSource).toContain('`target:"workspace"` returns an unsupported-target error');
    expect(skillSource).toContain("repository-relative Current Folder paths");
    expect(skillSource).toContain("about three context lines by default");
    expect(skillSource).toContain("`@@` class/function anchors");
    expect(skillSource).toContain("generator, formatter, or script");
    expect(skillSource).not.toContain("Every `apply_patch` operation names a relative path beneath one authorized\nroot");
    expect(historicalPipelineSource).toContain(contract.baseline.historicalInternalFileApplyPatch.identifier);
    expect(contract.baseline.historicalInternalFileApplyPatch.meaning).toMatch(/not the model-callable top-level/i);
  });

  test("keeps file as an additional/projected discoverable surface rather than treating core as complete", () => {
    const catalog = createCatalog();
    const fileEntry = catalog.query({}).find((entry) => entry.name === contract.baseline.additionalUnifiedFileTool.tool);

    expect(contract.baseline.additionalUnifiedFileTool).toMatchObject({
      tool: "file",
      exposure: "discoverable",
      core: false,
      features: ["glob", "grep", "read", "write", "history"],
      discoveryPath: ["discover_tools", "activate_tools", "file"],
    });
    expect(fileEntry).toMatchObject({ name: "file", exposure: "discoverable", category: "files" });
    expect(CORE_TOOL_NAMES).not.toContain("file");
    expect(TOOL_EXPOSURE_MANIFEST.families.filesystem).toContain("file");
    for (const command of contract.baseline.additionalUnifiedFileTool.commands) {
      expect(FILE_TOOL_ALL_COMMAND_NAMES as readonly string[]).toContain(command);
      expect(fileToolSchema.safeParse({ command }).success).toBe(true);
    }
    expect(fileToolSchema.safeParse({ command: "list", glob: "**/*.ts" }).success).toBe(true);
  });

  test("records the required context, discovery, preservation, verification, and rollback rules", () => {
    expect(contract.requiredGuidance.workflow).toEqual([
      "Core tools are only a baseline, not a complete capability claim.",
      "Before patching, acquire file context with the applicable file reading/search command.",
      "When file is absent, call discover_tools and activate the filesystem family or file tool if eligible; do not assume the core set is complete.",
      "Preserve dirty changes, reread affected context, and run focused verification after changes.",
      "Use file.undo or file.undo_turn for rollback when available; do not promise atomic multi-file rollback.",
      "Use file.glob, file.grep, and apply_patch only for Desktop-local Current Folder work.",
      "For Workspace artifacts, use file.list with a logical path prefix, file.read, and artifact-aware file.str_replace, file.insert, file.write, file.move, or file.delete.",
      "The optional workspace target selector is compatibility-only and returns unsupported_target; omit target or select current for Current Folder work.",
      "Prefer repository-relative Current Folder paths for clarity and portability, while existing Desktop authority decides what can be reached.",
      "Keep patches coherent and focused; use about three context lines by default and @@ class/function anchors when snippets are ambiguous.",
      "Use a generator, formatter, or script for generated output or a broad mechanical rewrite when that better expresses the intended change.",
    ]);
  });

  test("keeps path authority and resource controls outside model guidance", () => {
    const toolSource = readFileSync(join(AGENT_ROOT, "src/tools/apply-patch/apply-patch-tool.ts"), "utf8");
    const templateSource = readFileSync(join(AGENT_ROOT, "src/prompts/templates.ts"), "utf8");
    const skillSource = bundledSkillSource();
    const modelFacingSources = [toolSource, templateSource, skillSource].join("\n");

    expect(modelFacingSources).toContain("existing Current Folder authority decides whether a path form can be reached");
    expect(modelFacingSources).not.toMatch(/relative paths under (?:that |one )?(?:authorized )?root/i);
    expect(modelFacingSources).not.toMatch(/forbid(?:s|ding)? absolute paths/i);
    expect(modelFacingSources).not.toMatch(/do not include .*absolute paths/i);
    expect(modelFacingSources).not.toMatch(/(?:patch|hunk|file|byte|deadline|timeout) (?:cap|limit|ceiling)\b/i);
  });

});
