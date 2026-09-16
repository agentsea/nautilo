import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { OFFICIAL_SKILLS } from "../skills/bundled";

// ---------------------------------------------------------------------------
// D397 Wave 2 — R8: skill-without-prompt-block coverage guard.
//
// For every bundled skill, asserts that at least one of its `requiresTools`
// appears inside a `toolNames.has("...")` call somewhere in `templates.ts`'s
// `buildSystemPrompt`. This is the "third surface" of the D397 three-surface
// checklist (catalog registration → skill → prompt block), and the surface
// that was silently missing for `google_workspace` / `browser_*` / `mini_app`
// before Wave 0 landed.
//
// The check is a deliberately un-fancy source-text scan of `templates.ts` —
// no AST parse. A skill satisfies the check iff at least one of its
// `requiresTools` appears as the argument to a `toolNames.has("...")` call
// in the templates source. This mirrors how `buildSystemPrompt` actually
// gates conditional prompt blocks (see lines 29–65 of `templates.ts`).
//
// Allowlisted skills (below) are ones that intentionally don't need a
// dedicated `toolNames.has(...)` prompt block in `templates.ts`, with the
// reason documented inline. A NEW skill added later without either prompt
// coverage OR an explicit allowlist entry should FAIL this test — that's
// the guardrail.
// ---------------------------------------------------------------------------

const TEMPLATES_SOURCE = readFileSync(join(import.meta.dir, "templates.ts"), "utf8");

/** Match `toolNames.has("X")` or `toolNames.has('X')` and capture the tool name. */
const TOOL_NAMES_HAS_REGEX = /toolNames\.has\(\s*["']([^"']+)["']\s*\)/g;

function collectGatedToolNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(TOOL_NAMES_HAS_REGEX)) {
    names.add(match[1]!);
  }
  return names;
}

const GATED_TOOLS = collectGatedToolNames(TEMPLATES_SOURCE);

// ---------------------------------------------------------------------------
// Allowlist — skills that intentionally don't need a `toolNames.has(...)`
// prompt block in `templates.ts`. Each entry MUST have an inline reason.
// Remove an entry when its underlying reason no longer holds.
// ---------------------------------------------------------------------------
const SKILLS_WITHOUT_PROMPT_BLOCK: ReadonlyArray<{
  skill: string;
  reason: string;
}> = [
  {
    skill: "computer-use",
    // Computer Use family guidance is signed catalogue metadata injected by
    // pre-model only when an exact active catalogue tool is actually bound.
    // It therefore has no compiled toolNames.has(...) gate in templates.ts.
    reason: "Computer Use guidance is owned by the signed catalogue and automatically injected by pre-model when an exact active catalogue tool is bound.",
  },
  {
    skill: "shell-execution",
    // run_shell is a common developer tool; a dedicated prompt nudge was
    // judged unnecessary in D397 Wave 1 — the skill body + the tool's own
    // description are sufficient. The shell-execution skill teaches the
    // prove_it / relay / timeout model, not "you have this tool" (the tool
    // description already says that).
    reason: "run_shell is a common developer tool; D397 Wave 1 judged a dedicated prompt block unnecessary (skill body + tool description suffice).",
  },
  {
    skill: "terminal-sessions",
    // terminal is a common developer tool; same Wave 1 decision as
    // shell-execution. The skill body teaches the PTY/session model and
    // the run_shell-vs-terminal contrast, not "you have this tool".
    reason: "terminal is a common developer tool; D397 Wave 1 judged a dedicated prompt block unnecessary (skill body + tool description suffice).",
  },
  {
    skill: "interactive-artifact-authoring",
    // OPEN QUESTION (D397 Wave 2): the `file` / `read_artifact_events`
    // family DOES have tool-name-gated prompt coverage, but the gate lives
    // in `packages/agent/src/nodes/pre-model.ts:425` via
    //   `if (tools.some((t) => t.name === "file")) {
    //      systemPrompt += buildFileEditsBlock();
    //      systemPrompt += HTML_WORKSPACE_RICH_ARTIFACT_PROMPT;
    //    }`
    // — NOT inside `buildSystemPrompt`'s `toolNames.has(...)` cascade in
    //   `templates.ts`. The family has real prompt coverage; this test
    //   scans `templates.ts` only by design (per the Wave 2 task spec).
    //   Tracking the consolidation as a follow-up: ideally the file-
    //   family gating would move into `buildSystemPrompt` so this
    //   allowlist entry can be removed. Until then, the family is
    //   allowlisted here with a pointer to the actual gating site.
    reason: "file-family prompt gating lives in pre-model.ts (`tools.some((t) => t.name === 'file')` + buildFileEditsBlock/HTML_WORKSPACE_RICH_ARTIFACT_PROMPT), not in templates.ts's buildSystemPrompt. Real coverage exists; this test scans templates.ts only. Remove once the gate is consolidated into buildSystemPrompt.",
  },
  {
    skill: "office-calc",
    // TEMPORARY — D397 Phase 4 is supposed to land a `toolNames.has("office")`
    // (and `toolNames.has("edit_doc")`) prompt block alongside the D396
    // office tools so the office skills don't inherit the Wave 0 gap on
    // day one. The block has not been authored yet (D396 stack is in
    // flight as of 2026-07-08). Remove this entry once D397 Phase 4 ships
    // the office prompt block in `templates.ts`.
    reason: "TEMPORARY: D397 Phase 4 will add a `toolNames.has(\"office\")` prompt block for the D396 office tool family; not yet authored. Remove this allowlist entry once Phase 4 lands.",
  },
  {
    skill: "office-control",
    // Same as office-calc — TEMPORARY, pending D397 Phase 4. office-control
    // requiresTools both `office` and `edit_doc`; either appearing in a
    // `toolNames.has(...)` gate would satisfy the contract. Phase 4 should
    // add a block gated on at least one of them.
    reason: "TEMPORARY: D397 Phase 4 will add a `toolNames.has(\"office\"|\"edit_doc\")` prompt block; not yet authored. Remove this allowlist entry once Phase 4 lands.",
  },
  {
    skill: "office-impress",
    // Same as office-calc — TEMPORARY, pending D397 Phase 4.
    reason: "TEMPORARY: D397 Phase 4 will add a `toolNames.has(\"office\")` prompt block; not yet authored. Remove this allowlist entry once Phase 4 lands.",
  },
  {
    skill: "office-generate",
    // D396 (#475, merged into main during this stack's rebase) landed the
    // headless `officecli` tool + this skill with no `toolNames.has("officecli")`
    // prompt block — the exact same gap class D397 Wave 0 fixed for
    // google_workspace/browser_*/mini_app. TEMPORARY, same as the other
    // office-* entries above: pending a decision (extend D397 Phase 4, or
    // have D396 add its own block). Remove this allowlist entry once a
    // `toolNames.has("officecli")` gate lands in templates.ts.
    reason: "TEMPORARY: officecli (D396 #475) has no toolNames.has(\"officecli\") prompt block yet — same gap class as the other office-* skills above. Remove this allowlist entry once one is authored.",
  },
];

const ALLOWLISTED_SKILLS = new Set(SKILLS_WITHOUT_PROMPT_BLOCK.map((e) => e.skill));

describe("OFFICIAL_SKILLS × templates.ts prompt-block coverage (D397 Wave 2 R8)", () => {
  test("every bundled skill has a toolNames.has(...) gate for at least one of its requiresTools, OR is explicitly allowlisted", () => {
    const uncovered: string[] = [];
    for (const skill of OFFICIAL_SKILLS) {
      const covered = skill.requiresTools.some((tool) => GATED_TOOLS.has(tool));
      if (covered) continue;
      if (ALLOWLISTED_SKILLS.has(skill.name)) continue;
      uncovered.push(
        `${skill.name} (requiresTools: [${skill.requiresTools.join(", ")}]) — no toolNames.has(...) gate in templates.ts and no allowlist entry`,
      );
    }
    expect(uncovered).toEqual([]);
  });

  test("allowlist is non-empty and each entry has a documented reason", () => {
    // Guard against accidentally emptying the allowlist to make the
    // coverage test pass. Each entry must carry a non-trivial reason.
    expect(SKILLS_WITHOUT_PROMPT_BLOCK.length).toBeGreaterThan(0);
    for (const entry of SKILLS_WITHOUT_PROMPT_BLOCK) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("every allowlisted skill is currently uncovered (the allowlist is doing real work)", () => {
    // If an allowlisted skill later gains a `toolNames.has(...)` gate in
    // templates.ts, the allowlist entry is stale and should be removed.
    // This test flags that state so the allowlist doesn't accumulate dead
    // entries.
    const stale: string[] = [];
    for (const entry of SKILLS_WITHOUT_PROMPT_BLOCK) {
      const skill = OFFICIAL_SKILLS.find((s) => s.name === entry.skill);
      if (!skill) {
        stale.push(`${entry.skill} — allowlisted but not in OFFICIAL_SKILLS (stale entry)`);
        continue;
      }
      const covered = skill.requiresTools.some((tool) => GATED_TOOLS.has(tool));
      if (covered) {
        stale.push(
          `${entry.skill} — allowlisted but now has a toolNames.has(...) gate; remove the allowlist entry`,
        );
      }
    }
    expect(stale).toEqual([]);
  });

  test("dedicated prompt-block gates are present for shipped tool families", () => {
    // Sanity check that the Wave 0 work and the D417 media-extraction
    // affordance these tests guard are actually landed.
    expect(GATED_TOOLS.has("google_workspace")).toBe(true);
    expect(GATED_TOOLS.has("browser_snapshot")).toBe(true);
    expect(GATED_TOOLS.has("mini_app")).toBe(true);
    expect(GATED_TOOLS.has("extract_audio_from_video")).toBe(true);
  });
});
