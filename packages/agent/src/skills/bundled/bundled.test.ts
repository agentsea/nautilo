import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { getBundledSkill, OFFICIAL_SKILLS } from "./index";
import { parseFrontmatter } from "./parse-frontmatter";
import { requiresToolsMet, selectSkillsForTurn } from "../select-skills-for-turn";
import { registerAllTools } from "../../tools/register-all";

describe("OFFICIAL_SKILLS registry", () => {
  test("loads the expected official skills with valid metadata", () => {
    expect(OFFICIAL_SKILLS).toHaveLength(15);
    for (const skill of OFFICIAL_SKILLS) {
      expect(skill.source).toBe("official");
      expect(Number.isFinite(skill.version)).toBe(true);
      expect(skill.id).toBe(`official:${skill.name}`);
      expect(skill.requiresTools.length).toBeGreaterThan(0);
    }
    expect(OFFICIAL_SKILLS.map((s) => s.name).sort()).toEqual([
      "computer-use",
      "connected-websites",
      "developer-workstation",
      "embedded-browser-control",
      "google-workspace-control",
      "interactive-artifact-authoring",
      "mcp-setup",
      "mini-app-authoring",
      "office-calc",
      "office-control",
      "office-generate",
      "office-impress",
      "public-browser-research",
      "shell-execution",
      "terminal-sessions",
    ]);
  });

  test("computer-use metadata + body", () => {
    const skill = getBundledSkill("computer-use")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(12);
    expect(skill.requiresTools).toEqual(["computer_observe"]);
    expect(skill.body).toContain("active Computer Use tools");
    expect(skill.body).toContain("do not invent");
    expect(skill.body).toContain("fresh state");
    expect(skill.body).not.toContain("computer_do");
    expect(skill.body).not.toContain("computer_observe");
  });

  test("office-generate documents the one-call native Markdown create contract", () => {
    const skill = getBundledSkill("office-generate")!;

    expect(skill.requiresTools).toEqual(["officecli"]);
    expect(skill.body).toContain('{ "command": "create", "out": "reports/brief.docx",');
    expect(skill.body).toContain('{ "command": "add", "parent": "/body", "type": "markdown",');
    expect(skill.body).toContain('"props": { "markdown": "# Brief\\n\\nA native paragraph.');
    expect(skill.body).toContain("`markdown` is **not** a `convert` format");
    expect(skill.body).toContain("Top-level `data` is for `merge` only.");
  });

  test("connected-websites metadata + foreground sign-in behavior", () => {
    const skill = getBundledSkill("connected-websites")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(6);
    expect(skill.requiresTools).toEqual([
      "read_connected_web_account",
      "manage_connected_web_operation",
      "control_connected_web_operation",
    ]);
    expect(skill.body).toContain("Try anonymous web research first");
    expect(skill.body).toContain("authoritative inventory");
    expect(skill.body).toContain("Do not search the public web");
    expect(skill.body).toContain("multiple active accounts genuinely match");
    expect(skill.body).toContain("Preset tiles are discovery shortcuts");
    expect(skill.body).toContain("resolve its canonical public `http` or `https` URL");
    expect(skill.body).toContain("Do not guess a domain");
    expect(skill.body).toContain("Do not encode login selectors");
    expect(skill.body).toContain("Never substitute `browser_*`");
    expect(skill.body).toContain("authentication_required");
    expect(skill.body).toContain("Never ask the Human for a password");
    expect(skill.body).toContain("Never construct an iframe");
    expect(skill.body).toContain("Wait while the Human completes");
    expect(skill.body).toContain("selects **Done**");
    expect(skill.body).toContain("retry the exact original account, request, and delivery once");
    expect(skill.body).toContain("Existing connected-website operations");
    expect(skill.body).toContain("An `active` read result means the work was admitted");
    expect(skill.body).toContain("Start with `inspect`");
    expect(skill.body).toContain("explicit ISO due time");
    expect(skill.body).toContain("Never use `browser_*`");
    expect(skill.body).toContain("Direct control by the Genie");
    expect(skill.body).toContain("successfully entered the `direct` driver through `take_control`");
    expect(skill.body).toContain("Begin with `snapshot`");
    expect(skill.body).toContain("belong only to the latest successful snapshot");
    expect(skill.body).toContain("never click through successive screens blindly");
    expect(skill.body).toContain("do not replay the mutation");
    expect(skill.body).toContain("the direct lease may be gone");
    expect(skill.body).toContain("no coordinates, screenshots, arbitrary JavaScript");
    expect(skill.body).toContain("legacy single-item save/bookmark/favorite contract");
    expect(skill.body).toContain("without asking them to approve it again");
  });

  test("connected-websites owns the outcome while keeping routine supervision out of chat", () => {
    const skill = getBundledSkill("connected-websites")!;
    expect(skill.body).toContain("Be the supervisor, not a status relay");
    expect(skill.body).toContain("give it a finishable assignment");
    expect(skill.body).toContain("smallest relevant scope");
    expect(skill.body).toContain("a stopping condition");
    expect(skill.body).toContain("A changed action description is not necessarily progress");
    expect(skill.body).toContain("issue a concrete `steer` instruction without asking the Human");
    expect(skill.body).toContain("not guaranteed live chat");
    expect(skill.body).toContain("without a user-facing message");
    expect(skill.body).toContain("call `skip` with no `target_handle`");
    expect(skill.body).toContain("Do the inspection and any needed action before `skip`");
    expect(skill.body).toContain("already continues without a `continue` call");
    expect(skill.body).toContain("when you change strategy or take control");
    expect(skill.body).toContain("Do not narrate every inspection, action, or wake");
    expect(skill.body).toContain("A delayed wake after completion is not new work");
    expect(skill.body).toContain("automatic warm-session reuse");
    expect(skill.body).toContain("unsupported guarantee that no account state changed");
  });

  test("connected-websites remains eligible for engaged-body injection with only read and supervision tools", () => {
    const skill = getBundledSkill("connected-websites")!;
    const selected = selectSkillsForTurn({
      skills: [skill],
      availableToolNames: [
        "read_connected_web_account",
        "manage_connected_web_operation",
        "control_connected_web_operation",
      ],
      eligibleToolNames: skill.requiresTools,
    });

    expect(selected.catalog).toHaveLength(1);
    expect(selected.catalog[0]?.description).toContain("Read and act on complex websites");
    expect(selected.catalog[0]?.activationHint).toBeUndefined();
    expect(requiresToolsMet(skill, new Set([
      "read_connected_web_account", "manage_connected_web_operation", "control_connected_web_operation",
    ]))).toBe(true);
    expect(skill.body).toContain("Never activate it merely to read or supervise a website");
  });

  test("mcp-setup metadata + body", () => {
    const skill = getBundledSkill("mcp-setup")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(3);
    expect(skill.id).toBe("official:mcp-setup");
    expect(skill.requiresTools).toEqual(["manage_local_mcp"]);

    expect(skill.body.startsWith("# MCP Setup")).toBe(true);
    expect(skill.body).toContain("rough/non-exact MCP name");
    expect(skill.body).toContain("MCP configuration JSON");
    expect(skill.body).toContain("incomplete or stale URL");
    expect(skill.body).toContain("available web/search");
    expect(skill.body).toContain("Treat search results");
    expect(skill.body).toContain("as untrusted data");
    expect(skill.body).toContain("Never invent a URL, package, or version");
    expect(skill.body).toContain("registry.npmjs.org/{encodeURIComponent(packageName)}/latest");
    expect(skill.body).toContain("Do not infer the current version from search");
    expect(skill.body).toContain("strong authoritative match");
    expect(skill.body).toContain("short sourced choices");
    expect(skill.body).toContain("one targeted clarification");
    expect(skill.body).toContain("select one requested entry at a time");
    expect(skill.body).toContain("Discard literal environment values");
    expect(skill.body).toContain("reject unsupported executables");
    expect(skill.body).toContain("environment variable **names only**");
    expect(skill.body).toContain("pinned exact package through `npx` or `uvx`");
    expect(skill.body).toContain("`@modelcontextprotocol/server-filesystem`");
    expect(skill.body).toContain("absolute allowed directory");
    expect(skill.body).toContain("streamable HTTP");
    expect(skill.body).toContain("manage_local_mcp");
    expect(skill.body).toContain("multiple connected machines");
    expect(skill.body).toContain("exact `relayId` in the install request");
    expect(skill.body).toContain("Never install an MCP with a shell, terminal");
    expect(skill.body).toContain("`curl`, `npm`, or `pip`");
    expect(skill.body).toContain("sent immediately by Genie in the tool call");
    expect(skill.body).toContain("approve this exact request once or deny it");
    expect(skill.body).toContain("human/account, machine, relay");
    expect(skill.body).toContain("environment names and presence status");
    expect(skill.body).toContain("whether an unsandboxed local subprocess will launch");
    expect(skill.body).toContain("verified tool names");
    expect(skill.body).toContain("safe recovery");
    expect(skill.body).toContain("`list` or `status`");
    expect(skill.body).toContain("exact `relayId`");
    expect(skill.body).toContain("admin-managed MCPs");
  });

  test("embedded-browser-control metadata + body", () => {
    const skill = getBundledSkill("embedded-browser-control")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(1);
    expect(skill.id).toBe("official:embedded-browser-control");
    expect(skill.requiresTools).toEqual([
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_read",
      "browser_read_page",
      "browser_screenshot",
      "browser_mouse",
      "browser_get",
      "browser_scroll",
      "browser_back",
      "browser_open",
      "browser_forward",
      "browser_reload",
      "browser_hover",
      "browser_double_click",
      "browser_drag",
      "browser_select",
      "browser_set_checked",
      "browser_scroll_into_view",
      "browser_wait",
    ]);

    expect(skill.body.startsWith("# Embedded Browser Control")).toBe(true);
    expect(skill.body).toContain("snapshot → refs → act → re-snapshot");
    expect(skill.body).toContain("staleness barrier");
    expect(skill.body).toContain("HUMAN handoff");
    expect(skill.body).toContain("untrusted");
    expect(skill.body).toContain("browser_read_page");
  });

  test("interactive-artifact-authoring metadata + body", () => {
    const skill = getBundledSkill("interactive-artifact-authoring")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(2);
    expect(skill.id).toBe("official:interactive-artifact-authoring");
    expect(skill.requiresTools).toEqual(["file", "read_artifact_events"]);

    expect(skill.body.startsWith("# Interactive Artifact Authoring")).toBe(true);
    expect(skill.body).toContain("## The Three-Channel Model");
    expect(skill.body).not.toContain("PROVENANCE");
  });

  test("mini-app-authoring metadata + body", () => {
    const skill = getBundledSkill("mini-app-authoring")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(1);
    expect(skill.id).toBe("official:mini-app-authoring");
    expect(skill.requiresTools).toEqual(["mini_app"]);

    expect(skill.body.startsWith("# Mini-App Authoring")).toBe(true);
    expect(skill.body).toContain("Use `mini_app`, Not `file`");
    expect(skill.body).toContain("window.nautiloApp");
    expect(skill.body).toContain("Dependency-Free");
  });

  test("google-workspace-control metadata + body", () => {
    const skill = getBundledSkill("google-workspace-control")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(1);
    expect(skill.id).toBe("official:google-workspace-control");
    expect(skill.requiresTools).toEqual(["google_workspace"]);

    expect(skill.body.startsWith("# Google Workspace Control")).toBe(true);
    expect(skill.body).toContain("google_workspace");
    expect(skill.body).not.toContain("gog auth");
    expect(skill.body).toContain("browser_*");
    expect(skill.body).toContain("dryRun:true");
    expect(skill.body).toContain("docs.insertImage");
    expect(skill.body).toContain("Gmail send");
    expect(skill.body).toContain("calendar.createDryRun");
    expect(skill.body).toContain("sheets.append");
    expect(skill.body).toContain("sheets.chartCreate");
    expect(skill.body).toContain("untrusted");
  });

  test("developer-workstation metadata + body", () => {
    const skill = getBundledSkill("developer-workstation")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(10);
    expect(skill.id).toBe("official:developer-workstation");
    expect(skill.requiresTools).toEqual(["exec_command", "write_stdin", "apply_patch"]);

    expect(skill.body.startsWith("# Developer Workstation")).toBe(true);
    expect(skill.body).toContain("Current Folder");
    expect(skill.body).toContain("`foreground.main`");
    expect(skill.body).toContain("exact initiating Nautilo Desktop");
    expect(skill.body).toContain("background tasks, subagents");
    expect(skill.body).toContain("Basic runs contained");
    expect(skill.body).toContain("isolated network");
    expect(skill.body).toContain("private temporary `HOME`");
    expect(skill.body).toContain("Development is contained and profile-bound");
    expect(skill.body).toContain("Full Mac accepts a one-shot pipe only");
    expect(skill.body).toContain("no `tty` and no later");
    expect(skill.body).toContain("It changes containment only");
    expect(skill.body).toContain("git rev-parse --show-toplevel");
    expect(skill.body).toContain("git status --short");
    expect(skill.body).toContain("apply_patch");
    expect(skill.body).toContain("Core tools");
    expect(skill.body).toContain("discover_tools");
    expect(skill.body).toContain("glob → grep → read → `apply_patch`");
    expect(skill.body).toContain("file.undo_turn");
    expect(skill.body).toContain("Never promise atomicity");
    expect(skill.body).toContain("Own setup instead of bouncing the Human to a terminal");
    expect(skill.body).toContain("Settings → Workstation");
    expect(skill.body).toContain("When `local_github` is offered");
    expect(skill.body).toContain("Publishing retains its separate Human review");
    expect(skill.body).toContain("Never copy credentials");
    expect(skill.body).not.toContain("gh auth setup-git");
    expect(skill.body).toContain("`curl | sh`");
    expect(skill.body).toContain("Use ordinary Development execution");
    expect(skill.body).toContain("When `local_git` is actually available");
    expect(skill.body).toContain("safe broker-created `worktree-remove`");
    expect(skill.body).toContain("<<'EOF'");
    expect(skill.body).toContain("/bin/bash <<'BASH'");
    expect(skill.body).toContain("Do not wrap a multiline payload in `/bin/bash -lc '…'`");
    expect(skill.body).toContain("An `exec_command` call may complete or return a live `session_id`");
    expect(skill.body).toContain("A quiet read is not completion");
    expect(skill.body).toContain("history recovery never reruns it");
    expect(skill.body).toContain("The legacy `terminal` tool may remain");
    expect(skill.body).toContain("If the optional `read_shell_output` tool is offered");
    expect(skill.body).toContain("hands over their existing terminal");
    expect(skill.body).toContain("local execution is unavailable here");
    expect(skill.body).toContain("Never weaken containment");
  });

  test("shell-execution metadata + body", () => {
    const skill = getBundledSkill("shell-execution")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(7);
    expect(skill.id).toBe("official:shell-execution");
    expect(skill.requiresTools).toEqual(["exec_command", "write_stdin"]);

    expect(skill.body.startsWith("# Shell Execution")).toBe(true);
    expect(skill.body).toContain("main foreground conversation (`foreground.main`)");
    expect(skill.body).toContain("standalone relays");
    expect(skill.body).toContain("unavailable in this context");
    expect(skill.body).toContain("isolated network");
    expect(skill.body).toContain("private temporary `HOME`");
    expect(skill.body).toContain("active Development profile");
    expect(skill.body).toContain("It accepts a one-shot pipe only");
    expect(skill.body).toContain("Full Mac refuses PTYs");
    expect(skill.body).toContain("live `session_id`");
    expect(skill.body).toContain("A quiet read does not mean the command completed");
    expect(skill.body).toContain("nextSearchCursor");
    expect(skill.body).toContain("saved final");
    expect(skill.body).toContain("optional `read_shell_output`");
    expect(skill.body).toContain("Use `local_git`");
    expect(skill.body).toContain("Use `human_terminal` only after");
    expect(skill.body).toContain("legacy `terminal` tool may still be offered");
  });

  test("terminal-sessions metadata + body", () => {
    const skill = getBundledSkill("terminal-sessions")!;
    expect(skill.source).toBe("official");
    expect(skill.version).toBe(3);
    expect(skill.id).toBe("official:terminal-sessions");
    expect(skill.requiresTools).toEqual(["terminal"]);

    expect(skill.body.startsWith("# Terminal Sessions")).toBe(true);
    expect(skill.body).toContain("PTY");
    expect(skill.body).toContain("spawn");
    expect(skill.body).toContain("run");
    expect(skill.body).toContain("write");
    expect(skill.body).toContain("read");
    expect(skill.body).toContain("kill");
    expect(skill.body).toContain("use_workstation");
    expect(skill.body).toContain("canUseTerminal");
    expect(skill.body).not.toContain("use_high_impact_tools");
    expect(skill.body).not.toContain("use_destructive_tools");
    expect(skill.body).not.toContain("use_terminal");
    expect(skill.body).not.toContain("use_workstation_profiles");
    expect(skill.body).toContain("capability-gated");
    expect(skill.body).toContain("managed `exec_command` and `write_stdin`");
    expect(skill.body).toContain("`human_terminal`, when offered");
    expect(skill.body).toContain("does not prove");
  });

  test("bundled skills neither require nor recommend the retired shell tool", () => {
    for (const skill of OFFICIAL_SKILLS) {
      expect(skill.requiresTools).not.toContain("run_shell");
      expect(skill.body).not.toContain("run_shell");
    }
  });

  test("getBundledSkill lookup", () => {
    const skill = getBundledSkill("interactive-artifact-authoring");
    expect(skill).toBeDefined();
    expect(skill?.id).toBe("official:interactive-artifact-authoring");

    expect(getBundledSkill("nope")).toBeUndefined();
  });
});

describe("parseFrontmatter", () => {
  test("throws on malformed frontmatter block", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow(
      "must start with a frontmatter block",
    );

    expect(() => parseFrontmatter("---\nname: foo\nno closing delimiter")).toThrow(
      "malformed or unclosed frontmatter block",
    );

    expect(() =>
      parseFrontmatter(`---
name: test-skill
description: A test
requiresTools: [file]
source: official
---
# Body
`),
    ).toThrow("missing required key: version");
  });

  test("parses valid frontmatter and body", () => {
    const { frontmatter, body } = parseFrontmatter(`---
name: test-skill
description: A test skill
requiresTools: [file, read_artifact_events]
source: official
version: 2
---

# Heading

Body text.
`);

    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("A test skill");
    expect(frontmatter.requiresTools).toBe("[file, read_artifact_events]");
    expect(frontmatter.source).toBe("official");
    expect(frontmatter.version).toBe("2");
    expect(body).toBe("# Heading\n\nBody text.\n");
  });
});

// ---------------------------------------------------------------------------
// D397 Wave 2 — R7: skill body / requiresTools consistency guardrails.
//
// Two regression tests so a future bundled skill can't silently ship with:
//   (a) a `requiresTools` entry that isn't a registered catalog tool, or
//   (b) a body that names a SPECIFIC other catalog tool outside its own
//       `requiresTools` set (the `google-workspace-control` Anomaly 1 class
//       from the D397 audit, had it been worded with a concrete tool name
//       instead of the `browser_*` wildcard).
//
// The check is intentionally a mechanical whole-word text scan, not an AST
// parse. Snake_case tool identifiers don't collide with English prose, so a
// `\b<tool>\b` match in a skill body is a strong signal the body is naming
// that tool. Allowlists below carve out the legitimate cases (generic
// English-word tool names; meta-tools; intentional pedagogical
// cross-references between sibling skills). A NEW skill added later with an
// unexplained cross-reference should fail the test — that's the guardrail.
// ---------------------------------------------------------------------------

// Tool names that are ALSO common English words would create false positives
// in a whole-word scan of skill prose (e.g. "use the `file` tool" in
// mini-app-authoring's "Not `file`" framing, or `convert` in office-control's
// format-conversion table). We accept the false negative to keep the test
// from drowning in English-word noise. The check still catches the bug class
// that matters — skills naming *specific* snake_case tool identifiers
// outside their requiresTools.
const GENERIC_WORD_TOOL_NAMES = new Set([
  "file",
  "task",
  "skip",
  "react",
  "convert",
  "schedule",
  "office",
]);

// Meta-tools the agent uses to discover / manage other skills, commands, and
// tools. Referencing these from any skill body is intentional and safe —
// they are the agent's own discovery/management primitives, not workflow
// tools the skill is instructing the agent to call as part of its workflow.
// Allowlisting them keeps the test focused on workflow-tool cross-references
// (the bug class R7 targets). Example: `google-workspace-control` tells the
// agent to confirm browser availability via `discover_tools` first — that's
// a meta-tool pointer, not a workflow dependency on `discover_tools`.
const META_TOOLS = new Set([
  "discover_tools",
  "discover_skills",
  "view_skill",
  "eject",
  "skill_manage",
  "command_manage",
  "view_command",
  "discover_commands",
  "eject_command",
]);

// Per-skill intentional cross-references to OTHER workflow tools, documented
// here so the test stays meaningful (a NEW skill added later with an
// unexplained cross-reference should fail the test). Each entry maps skill
// name → set of tool names that skill is allowed to name in its body even
// though they're not in its `requiresTools`.
const PER_SKILL_CROSS_REFERENCES: Record<string, Set<string>> = {
  // "terminal" is lifecycle vocabulary, not terminal-tool routing. The save
  // tool is explicitly optional and discovery-gated: requiring it would eject
  // read-only supervision guidance while that effect capability is deferred.
  // Research alternatives are optional; terminal describes operation state.
  // Task execution is an optional action alternative; research-only actors
  // must retain their read/supervision skill when that capability is absent.
  "public-browser-research": new Set(["terminal", "run_web_search", "read_webpage", "run_website_task"]),
  "connected-websites": new Set(["terminal", "act_connected_web_account", "run_website_task"]),
  // mcp-setup names terminal only to prohibit shell-based installation; the
  // dedicated manage_local_mcp tool is its sole dependency.
  "mcp-setup": new Set(["terminal"]),
  // developer-workstation requires the normal file + shell workflow. It also
  // names optional core/discovery routes so Genie can recover when a schema is
  // masked and use the multi-file primitive when present.
  "developer-workstation": new Set([
    "local_github",
    "terminal",
    "local_git",
    "read_shell_output",
    "human_terminal",
    "apply_patch",
    "discover_tools",
    "activate_tools",
  ]),
  // Managed execution names optional typed/history/handoff routes and the
  // legacy terminal only when those capabilities are actually offered.
  "shell-execution": new Set(["terminal", "local_git", "read_shell_output", "human_terminal"]),
  // Legacy terminal guidance explains the preferred managed and explicit
  // Human-handoff surfaces without requiring them.
  "terminal-sessions": new Set(["exec_command", "write_stdin", "human_terminal"]),
  // office-control (requiresTools: [edit_doc, office]) — the interactive
  // editing skill — teaches the interactive-vs-headless routing split by
  // pointing at `officecli` (see the office-generate skill) for
  // from-scratch generation. Landed with D396 (#475). Pedagogical
  // cross-reference, not a workflow dependency on `officecli`.
  "office-control": new Set(["officecli"]),
  // office-generate (requiresTools: [officecli]) — the headless generation
  // skill — mirrors the above in reverse, pointing at `edit_doc`/`office`
  // for interactive editing of a document the user has open. Landed with
  // D396 (#475). Pedagogical cross-reference, not a workflow dependency.
  "office-generate": new Set(["edit_doc"]),
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWordRegex(toolName: string): RegExp {
  return new RegExp(`\\b${escapeRegex(toolName)}\\b`);
}

describe("OFFICIAL_SKILLS × ToolCatalog contract (D397 Wave 2 R7)", () => {
  let catalog: ToolCatalog;
  let registeredToolNames: Set<string>;

  beforeAll(() => {
    // Enable the D362 office tooling flag so the office-* skills'
    // `requiresTools` ([office, edit_doc]) resolve to real catalog entries.
    // Default is false; restore in afterAll so this describe doesn't leak
    // config into sibling test files in the same bun test run.
    setConfigOverrides({ nautilo_office_enabled: true });
    catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => true, publicBrowserUseAvailable: () => true });
    registeredToolNames = new Set(catalog.query({}).map((e) => e.name));
  });

  afterAll(() => {
    setConfigOverrides({ nautilo_office_enabled: false });
  });

  test("every OFFICIAL_SKILLS entry's requiresTools is a registered catalog tool", () => {
    const missing: string[] = [];
    for (const skill of OFFICIAL_SKILLS) {
      for (const tool of skill.requiresTools) {
        if (!registeredToolNames.has(tool)) {
          missing.push(`${skill.name} → ${tool}`);
        }
      }
    }
    // Pinning the currently-true invariant: every bundled skill's
    // `requiresTools` resolves to a real catalog entry. No tool today is
    // missing catalog registration (the worst-case "broken discovery"
    // failure); this assertion makes that explicit so a future skill
    // naming a not-yet-registered tool fails CI at authoring time.
    expect(missing).toEqual([]);
  });

  test("google workspace capability restores its skill without bypassing actor policy", () => {
    const googleSkill = getBundledSkill("google-workspace-control")!;
    const selectWith = (
      toolPolicy: Readonly<Record<string, "allow" | "forbidden">> | undefined,
      relayCapabilities: Readonly<Record<string, boolean>> | undefined,
    ) => {
      const eligibleToolNames = catalog
        .getFiltered(toolPolicy, relayCapabilities)
        .entries.map((entry) => entry.name);
      return selectSkillsForTurn({
        skills: [googleSkill],
        availableToolNames: [],
        eligibleToolNames,
      }).catalog.map((entry) => entry.name);
    };

    expect(selectWith(undefined, { use_google_workspace: true })).toContain(
      "google-workspace-control",
    );
    expect(selectWith(undefined, undefined)).not.toContain("google-workspace-control");
    expect(
      selectWith(
        { google_workspace: "forbidden" },
        { use_google_workspace: true },
      ),
    ).not.toContain("google-workspace-control");
  });

  test("MCP setup appears in the automatic Genie catalog without Human skill selection", () => {
    const skill = getBundledSkill("mcp-setup")!;
    const selected = selectSkillsForTurn({
      skills: [skill],
      availableToolNames: ["manage_local_mcp"],
    });
    expect(selected.catalog.map((entry) => entry.name)).toEqual(["mcp-setup"]);
  });

  test("skill bodies do not casually name catalog tools outside their own requiresTools", () => {
    const violations: string[] = [];
    for (const skill of OFFICIAL_SKILLS) {
      const own = new Set(skill.requiresTools);
      const allowed = PER_SKILL_CROSS_REFERENCES[skill.name] ?? new Set<string>();
      for (const otherTool of registeredToolNames) {
        if (own.has(otherTool)) continue;
        if (allowed.has(otherTool)) continue;
        if (GENERIC_WORD_TOOL_NAMES.has(otherTool)) continue;
        if (META_TOOLS.has(otherTool)) continue;
        const re = wholeWordRegex(otherTool);
        if (re.test(skill.body)) {
          violations.push(
            `${skill.name} body names "${otherTool}" (not in requiresTools)`,
          );
        }
      }
    }
    // Would have caught a `google-workspace-control`-style anomaly had it
    // been worded with a concrete `browser_*` tool name (e.g.
    // `browser_snapshot`) instead of the `browser_*` wildcard. The Wave 1
    // fix intentionally retains the `browser_*` wildcard with a hedge —
    // the wildcard itself is NOT a registered catalog tool name, so this
    // scan does not flag it. See Wave 2 done-report for the
    // narrower-than-ideal-scope finding.
    expect(violations).toEqual([]);
  });
});
