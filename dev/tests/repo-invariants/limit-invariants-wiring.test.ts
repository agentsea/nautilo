import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

type RootPackage = {
  scripts?: Record<string, string>;
};

async function read(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

async function productSourceFiles(): Promise<string[]> {
  const results: string[] = [];
  const pending = ["apps", "bin", "packages"].map((path) => join(repositoryRoot, path));
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".turbo"].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if ([".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
        const path = relative(repositoryRoot, absolute);
        if (!path.startsWith("packages/limit-invariants/")) results.push(path);
      }
    }
  }
  return results;
}

describe("limit-invariant wiring", () => {
  test("uses one blocking developer/CI gate", async () => {
    const [rootPackage, gates, hooks, workflow] = await Promise.all([
      read("package.json"),
      read("dev/scripts/ci-gates.sh"),
      read("lefthook.yml"),
      read(".github/workflows/ci.yml"),
    ]);
    const rootScripts = (JSON.parse(rootPackage) as RootPackage).scripts;
    expect(rootScripts).toMatchObject({
      "limits:inventory": "bun run --cwd packages/limit-invariants inventory",
      "limits:report": "bun run --cwd packages/limit-invariants report",
      "limits:check": "bun run --cwd packages/limit-invariants check",
      "limits:scout": "bun run --cwd packages/limit-invariants scout",
      "limits:eval-agent": "bun dev/tools/limit-preflight/evaluate-live-agent.ts",
    });
    expect(gates).toContain("run_cmd limit-invariants bun run limits:check");
    expect(gates).toMatch(/lint\)\s+run_gate lint-eslint\s+run_gate test-invariants\s+run_gate query-inventory\s+run_gate limit-invariants\s+run_gate lint-unused/u);
    expect(hooks).toContain("name: limit-invariants\n            run: bash dev/scripts/ci-gates.sh limit-invariants");
    expect(workflow).toContain("name: Limit invariants\n        run: bash dev/scripts/ci-gates.sh limit-invariants");
  });

  test("developer-only package is absent from product imports and Genie skill registration", async () => {
    const offenders: string[] = [];
    for (const path of await productSourceFiles()) {
      const content = await read(path);
      if (content.includes("@nautilo/limit-invariants")) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    expect(await read("packages/agent/src/skills/bundled/index.ts")).not.toContain("limit-preflight");
    const packageJson = JSON.parse(await read("packages/limit-invariants/package.json")) as Record<string, unknown>;
    expect(packageJson).not.toHaveProperty("main");
    expect(packageJson).not.toHaveProperty("exports");
  });

  test("developer skill keeps judgment with the agent and covers adversarial review cases", async () => {
    const skill = await read("dev/tools/limit-preflight/codex/skills/limit-preflight/SKILL.md");
    const scenarios = JSON.parse(await read("dev/tools/limit-preflight/fixtures/review-scenarios.json")) as {
      cases: Array<{
        id: string;
        expected: { classification: string; disposition: string };
        requiredReview: string[];
        forbiddenShortcut: string;
      }>;
    };
    expect(skill).toContain("scanner is deliberately dumb");
    expect(skill).toMatch(/perform the semantic\s+review yourself/u);
    expect(skill).toContain("surface the unresolved decision to the user");
    expect(skill).toMatch(/A literal,\s+comment, configuration knob, existing test, or legacy row is not authority/u);
    expect(skill).toContain("Neither an industry convention nor a \"field standard\" is authority");
    expect(skill).toContain("For terminal partial results");
    expect(skill).toContain("cursor or range semantics are stable");
    expect(skill).toContain("inspect every mechanically related");
    expect(new Set(scenarios.cases.map((item) => item.id))).toEqual(new Set([
      "arbitrary-semantic-crop",
      "lossless-frame",
      "provider-derived-maximum",
      "caller-policy",
      "soft-default",
      "ui-projection",
      "justified-process-timeout",
      "unjustified-round-timeout",
      "retry-exhaustion",
      "destructive-retention",
      "partial-result-without-continuation",
      "recoverable-partial-stable-continuation",
    ]));
    expect(scenarios.cases.every((item) => item.requiredReview.length !== 0 && item.forbiddenShortcut.trim() !== "")).toBe(true);
    expect(scenarios.cases.every((item) => item.expected.classification.trim() !== "" && item.expected.disposition.trim() !== "")).toBe(true);
  });
});
