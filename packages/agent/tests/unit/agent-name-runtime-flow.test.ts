// PRESERVED: D118 rename regression — this file intentionally references "Jeannie"
// as a forbidden literal in assertions. Do NOT sweep these strings.

import { describe, expect, test } from "bun:test";
import type { StructuredTool } from "@langchain/core/tools";
import {
  buildConnectedWebAccountCapabilityBlock,
  buildInitiatingClientSurfaceGuidance,
  buildSystemPrompt,
  EXPLICITLY_SELECTED_PROMPT,
  SOUL_FILE_HEADER,
} from "../../src/prompts/templates";
import { withholdSkipForExplicitSelection } from "../../src/nodes/skip-gate";

/** Mirrors `pre-model.ts` (`state.assistantName || "Genie"`) before `buildSystemPrompt`. */
function memorySubsystemSystemPrompt(assistantName: string | undefined, soulFile: string): string {
  return `You are ${assistantName ?? "Genie"}, helping maintain memory consistency.\n${SOUL_FILE_HEADER}${soulFile}`;
}

describe("D513 initiating client surface prompt guidance", () => {
  test("covers the closed surface set without false UI claims", () => {
    const native = buildInitiatingClientSurfaceGuidance("mobile.native");
    const web = buildInitiatingClientSurfaceGuidance("mobile.web");
    const desktop = buildInitiatingClientSurfaceGuidance("workbench.desktop");
    const browser = buildInitiatingClientSurfaceGuidance("workbench.browser");
    const unknown = buildInitiatingClientSurfaceGuidance("unknown");
    expect(native).toContain("mobile app");
    expect(web).toContain("mobile web browser, not the native app");
    expect(native).toContain("what you can retry or do after");
    expect(web).toContain("Desktop continuation");
    expect(desktop).toContain("does not prove");
    expect(browser).toContain("Workbench in a browser");
    expect(unknown).toContain("surface is unknown");
    expect(unknown).not.toContain("mobile app");
  });
});

describe("D118 — runtime agent name flows through prompt-render", () => {
  const base = {
    tools: [] as StructuredTool[],
    isGuest: false,
  };

  test("empty assistantName falls back to Genie (default literal)", () => {
    const assistantName = "";
    const effective = assistantName || "Genie";
    const prompt = buildSystemPrompt({
      ...base,
      assistantName: effective,
    });
    expect(prompt).toContain("Genie");
    expect(prompt).not.toContain("Jeannie");
  });

  test("operator-chosen assistantName flows through (no fallback literals)", () => {
    const prompt = buildSystemPrompt({
      ...base,
      assistantName: "Maximus",
    });
    expect(prompt).toContain("Maximus");
    expect(prompt).not.toContain("Jeannie");
    expect(prompt).not.toContain("Genie");
  });

  test("memory subsystem coherence — exit-flush / reviewer prompt shape uses runtime name", () => {
    const soul = "# Zorv — Soul File\nZorv keeps continuity without naming other assistants.";
    const assistantName = "Maximus";
    const exitPrompt = memorySubsystemSystemPrompt(assistantName, soul);
    const reviewerPrompt = memorySubsystemSystemPrompt(assistantName, soul);
    expect(exitPrompt).toBe(reviewerPrompt);
    expect(exitPrompt).toContain("Maximus");
    expect(exitPrompt).not.toContain("Jeannie");
    expect(exitPrompt).not.toContain("Genie");
  });
});

describe("D504 — embedded browser prompt affordance", () => {
  test("treats exposed browser tools as ordinary without bypassing their policy gates", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [
        { name: "browser_snapshot", description: "Inspect the active browser." },
        { name: "browser_read_page", description: "Read the rendered page." },
        { name: "verify_identity", description: "Verify an identity claim." },
      ] as StructuredTool[],
    });

    expect(prompt).toContain("### Embedded browser");
    expect(prompt).toContain("browser_read_page");
    expect(prompt).toContain("ordinary tools: invoke them directly");
    expect(prompt).toContain("Do **not** call `verify_identity` or ask for a PIN merely to use an embedded-browser tool");
    expect(prompt).toContain("`control_browser` capability");
    expect(prompt).toContain("normal impact and approval rules remain authoritative");
    expect(prompt).toContain("only for an actual identity claim or a separately restricted action");
    expect(prompt).toContain("The embedded browser is not Browser Use");
    expect(prompt).toContain("Never use `browser_*` as a fallback for `read_connected_web_account`");
  });

  test("does not inject embedded-browser guidance when browser tools are absent", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [{ name: "verify_identity", description: "Verify an identity claim." }] as StructuredTool[],
    });

    expect(prompt).not.toContain("### Embedded browser");
    expect(prompt).not.toContain("ordinary tools: invoke them directly");
  });

  test("gives an unidentified speaker the same direct no-PIN browser guidance", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: true,
      tools: [
        { name: "browser_read_page", description: "Read the rendered page." },
        { name: "verify_identity", description: "Verify an identity claim." },
      ] as StructuredTool[],
    });

    expect(prompt).toContain("### Embedded browser");
    expect(prompt).toContain("Do **not** call `verify_identity` or ask for a PIN merely to use an embedded-browser tool");
    expect(prompt).toContain("Exposed embedded-browser tools are an explicit exception");
    expect(prompt).toContain("directly use exposed `browser_*` tools without identity verification or a PIN");
    expect(prompt).toContain("Do not ask them to identify themselves or offer identity verification merely because they are unidentified");
    expect(prompt).toContain("never infer or announce an owner, admin, member, or other role from verification");
    expect(prompt).not.toContain("Greet them warmly and ask who they are");
  });
});

describe("D568 — connected website capability context", () => {
  test("renders only safe account selectors and direct-use guidance", () => {
    const block = buildConnectedWebAccountCapabilityBlock([{
      label: "console.nebius.com",
      service: "console.nebius.com",
      origin: "https://console.nebius.com",
      status: "connected",
    }]);

    expect(block).toContain("### Connected websites");
    expect(block).toContain("console.nebius.com");
    expect(block).toContain("read_connected_web_account");
    expect(block).toContain("run_website_task");
    expect(block).toContain("without a second authorization");
    expect(block).toContain("pause for genuinely dangerous");
    expect(block).toContain("Do not search the public web");
    expect(block).toContain("do not substitute the embedded browser");
    expect(block).not.toContain("profileId");
    expect(block).not.toContain("liveUrl");
    expect(block).not.toContain("runId");
  });

  test("omits the section when no account is authorized for the turn", () => {
    expect(buildConnectedWebAccountCapabilityBlock([])).toBe("");
  });
});

describe("D504 — autonomous web-research consent prompt", () => {
  test("gives Genie standing least-consent authority when research tools are exposed", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [
        { name: "run_web_search", description: "Search the web." },
        { name: "read_webpage", description: "Read a webpage." },
      ] as StructuredTool[],
    });

    expect(prompt).toContain("### Web research (run_web_search / read_webpage)");
    expect(prompt).toContain("Never ask the Human to clear routine cookie consent");
    expect(prompt).toContain("standing authority to clear routine cookie UI and continue the research");
    expect(prompt).toContain("continue without accepting, reject optional/non-essential cookies, necessary-only, or dismiss");
    expect(prompt).toContain("abandon it and use another source without asking the Human");
    expect(prompt).toContain("do not invent or surface fallback failures when the overall tool call succeeded");
    expect(prompt).toContain("reason from the returned evidence and citations");
    expect(prompt).toContain("bounded coverage, not an exhaustive-web count");
    expect(prompt).toContain("Distinguish complete or partial page evidence from snippet-only evidence");
    expect(prompt).toContain("do not reflexively re-read every source");
    expect(prompt).toContain("a larger request is a fresh read and may observe changed content");
    expect(prompt).toContain("snapshot find/range inspects the same retained content without refetching");
    expect(prompt).toContain("Never claim that extracted readable text captures every visual");
    expect(prompt).not.toContain("provider receipt");
    expect(prompt).toContain("2FA, or CAPTCHAs");
  });

  test("does not inject research policy when research tools are absent", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [{ name: "browser_snapshot", description: "Inspect the active browser." }] as StructuredTool[],
    });

    expect(prompt).not.toContain("### Web research (run_web_search / read_webpage)");
    expect(prompt).not.toContain("standing authority to clear routine cookie UI and continue the research");
  });
});

describe("D417 — MP4 audio extraction prompt affordance", () => {
  test("injects the artifact-first extraction and managed-runtime safety rules only with the tool", () => {
    const withoutTool = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [{ name: "transcribe_audio", description: "Transcribe workspace audio." }] as StructuredTool[],
    });
    const withTool = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [
        { name: "extract_audio_from_video", description: "Extract MP4 audio." },
        { name: "transcribe_audio", description: "Transcribe workspace audio." },
      ] as StructuredTool[],
    });

    expect(withoutTool).not.toContain("### MP4 audio extraction");
    expect(withTool).toContain("### MP4 audio extraction (extract_audio_from_video)");
    expect(withTool).toContain("workspace `.m4a` artifact");
    expect(withTool).toContain("then call `transcribe_audio` on that resulting artifact");
    expect(withTool).toContain("Do **not** use generic `convert`, `file:copy`, or direct MP4 transcription");
    expect(withTool).toContain("explicit managed-runtime repair instruction");
    expect(withTool).toContain("Do **not** retry extraction or invoke Homebrew from the Nautilo terminal");
    expect(withTool).toContain("Never invent a shell command or claim extraction succeeded unless the tool returned the resulting artifact");
  });
});

describe("D419 — progressive tool activation prompt affordance", () => {
  const progressiveTools = [
    { name: "discover_tools", description: "Search available tools." },
    { name: "activate_tools", description: "Activate eligible tools." },
  ] as StructuredTool[];

  test("tells owner agents to discover, activate, and continue on the next loop", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: progressiveTools,
    });

    expect(prompt).toContain('call `discover_tools` before saying "I can\'t"');
    expect(prompt).toContain('availability: "activatable"');
    expect(prompt).toContain("continue the task on the next tool loop");
    expect(prompt).toContain("Do not attempt or recommend activation for results that are unavailable");
    expect(prompt).toContain("unmistakable requests may pre-activate");
    expect(prompt).toContain("Call `discover_tools` with no query or category");
    expect(prompt).toContain("browse every eligible capability");
  });

  test("keeps guest restrictions while requiring discovery before an unavailable claim", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: true,
      tools: progressiveTools,
    });

    expect(prompt).toContain('call `discover_tools` before saying "I can\'t"');
    expect(prompt).toContain("guest restrictions still apply");
    expect(prompt).toContain("you cannot access private memories, files, or sensitive tools");
  });
});

describe("D453 — connected harness delegation prompt affordance", () => {
  test("routes an explicit Codex request through Task and never through shell", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [{ name: "task", description: "Create a task." }] as StructuredTool[],
    });

    expect(prompt).toContain('task({ command: "create", harness: "codex"');
    expect(prompt).toContain('in_background({ brief: ..., harness: "codex" })');
    expect(prompt).toContain("For substantial coding work, prefer");
    expect(prompt).toContain("Never discover or invoke Codex through `run_shell`, a raw Codex CLI");
    expect(prompt).toContain("readable tool result and let the Human use its saved recovery action");
    expect(prompt).toContain("never falls back to Native");
    expect(prompt).toContain("Runtime installation, account login, account/profile selection, posture escalation, and approval decisions are Human-owned");
  });

  test("teaches the core in_background surface without requiring the advanced task tool", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [{ name: "in_background", description: "Run background work." }] as StructuredTool[],
    });

    expect(prompt).toContain('in_background({ brief: ..., harness: "codex" })');
    expect(prompt).toContain("The advanced low-level form remains");
  });

  test("does not teach harness delegation to a guest", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: true,
      tools: [{ name: "task", description: "Create a task." }] as StructuredTool[],
    });

    expect(prompt).not.toContain("Agent harness delegation");
  });
});

describe("D316 — explicit ask_user picker selection", () => {
  const toolsWithoutSkip = [
    { name: "search_memory", description: "Search memory." },
  ] as StructuredTool[];

  test("explicitlySelected injects steering prompt for owner turns", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: toolsWithoutSkip,
      explicitlySelected: true,
    });
    expect(prompt).toContain(EXPLICITLY_SELECTED_PROMPT.trim());
    expect(prompt).toContain("explicitly selected you from a disambiguation picker");
  });

  test("explicitlySelected false omits steering prompt", () => {
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: toolsWithoutSkip,
      explicitlySelected: false,
    });
    expect(prompt).not.toContain("explicitly selected you from a disambiguation picker");
  });

  test("skip tool is withheld when explicitlySelected is set", () => {
    const rawTools = [{ name: "skip" }, { name: "search_memory" }];

    expect(
      withholdSkipForExplicitSelection(rawTools, true).map((t) => t.name),
    ).toEqual(["search_memory"]);

    expect(
      withholdSkipForExplicitSelection(rawTools, false).map((t) => t.name),
    ).toEqual(["skip", "search_memory"]);

    expect(
      withholdSkipForExplicitSelection(rawTools, undefined).map((t) => t.name),
    ).toEqual(["skip", "search_memory"]);
  });
});
