import { describe, expect, test } from "bun:test";
import type { LegacyLimitDebt, LimitDetectorCoverage, LimitInvestigationLink, LimitObservation, ReviewedLimitDecision } from "../../src/model";
import {
  checkRegistry,
  legacyLockFor,
  parseDecisions,
  renderInvestigationMap,
  renderInventory,
  renderMatrix,
  renderScout,
} from "../../src/node/registry";

const observation: LimitObservation = {
  locator: "packages/example/src/a.ts#run:call:slice:1",
  fingerprint: "abc",
  path: "packages/example/src/a.ts",
  line: 4,
  symbol: "run",
  owner: "packages/example",
  sourceKind: "typescript",
  detector: "call:slice",
  effect: "truncate",
  value: "16384",
  unit: "count",
  reachability: "live",
  extractionConfidence: "high",
  mechanicalPriority: "high",
  reasonCode: "sequence_reduction_sink",
  effects: ["truncate"],
  reasonCodes: ["sequence_reduction_sink"],
  lane: "primary",
  siteCount: 1,
  sites: [{
    path: "packages/example/src/a.ts",
    line: 4,
    symbol: "run",
    detector: "call:slice",
    expression: "value.slice(0, 16384)",
    reasonCode: "sequence_reduction_sink",
  }],
};

const debt: LegacyLimitDebt = {
  locator: observation.locator,
  fingerprint: observation.fingerprint,
  owner: observation.owner,
  mechanicalPriority: observation.mechanicalPriority,
};

const decision: ReviewedLimitDecision = {
  locator: observation.locator,
  fingerprint: observation.fingerprint,
  classification: "arbitrary",
  disposition: "remove",
  authority: "No provider or caller owns this local crop.",
  owner: "packages/example",
  lossAndCompleteness: "Silently loses the remainder.",
  visibility: "Caller sees a complete-looking partial result.",
  continuationOrRecovery: "Remove the crop and preserve bounded transport framing.",
  evidence: ["packages/example/tests/a.test.ts"],
  rationale: "The local literal is not policy authority.",
};

describe("limit decision reconciliation", () => {
  test("accepts exact frozen legacy debt and rejects debt laundering", () => {
    expect(checkRegistry({
      current: [observation],
      committedInventory: [observation],
      decisions: [],
      legacy: [debt],
      legacyLock: legacyLockFor([debt]),
    }).ok).toBe(true);
    expect(checkRegistry({
      current: [{ ...observation, fingerprint: "changed" }],
      committedInventory: [observation],
      decisions: [],
      legacy: [debt],
      legacyLock: legacyLockFor([debt]),
    }).errors.join("\n")).toContain("legacy debt cannot absorb changed limits");
  });

  test("keeps facts and decisions separate in generated artifacts", () => {
    expect(renderInventory([observation])).not.toContain("arbitrary");
    const matrix = renderMatrix({ observations: [observation], decisions: [decision], legacy: [] });
    expect(matrix).toContain("arbitrary");
    expect(matrix).toContain("reviewed");
    expect(matrix).toContain("Behavioral evidence");
    expect(matrix).toContain(decision.authority);
  });

  test("refuses approval-shaped rows without behavioral proof", () => {
    const content = [
      JSON.stringify({ type: "reviewed-limit-decisions", schemaVersion: 2, purpose: "test" }),
      JSON.stringify({ ...decision, evidence: ["packages/example/src/a.ts"] }),
      "",
    ].join("\n");
    expect(() => parseDecisions(content)).toThrow("behavioral test evidence");
  });

  test("refuses permanent arbitrary approval and empty decision rationale", () => {
    const header = JSON.stringify({ type: "reviewed-limit-decisions", schemaVersion: 2, purpose: "test" });
    expect(() => parseDecisions([
      header,
      JSON.stringify({ ...decision, disposition: "retain" }),
      "",
    ].join("\n"))).toThrow("cannot permanently retain an arbitrary limit");
    expect(() => parseDecisions([
      header,
      JSON.stringify({ ...decision, rationale: "" }),
      "",
    ].join("\n"))).toThrow("invalid rationale");
  });

  test("reports duplicate and orphaned reviewed decisions", () => {
    const result = checkRegistry({
      current: [],
      committedInventory: [],
      decisions: [decision, decision],
      legacy: [],
      legacyLock: legacyLockFor([]),
    });
    expect(result.errors).toContain(`reviewed decisions contains duplicate locator ${decision.locator}`);
    expect(result.errors).toContain(`ORPHANED decision ${decision.locator}`);
  });

  test("reports unreviewed observations instead of manufacturing a verdict", () => {
    const result = checkRegistry({
      current: [observation],
      committedInventory: [observation],
      decisions: [],
      legacy: [],
      legacyLock: legacyLockFor([]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`UNREVIEWED observation ${observation.locator}; remove/derive/redesign it or add an evidence-backed reviewed decision (legacy debt cannot grow)`);
  });

  test("focus map shows linked named semantic-loss junctions without a top-N cutoff", () => {
    const junction: LimitObservation = {
      ...observation,
      locator: "packages/agent/src/tools/read.ts#binding:<module>:MAX_OUTPUT_CHARS:1",
      path: "packages/agent/src/tools/read.ts",
      detector: "named:MAX_OUTPUT_CHARS",
      effects: ["truncate", "bound"],
      reasonCodes: ["named_boundary_declaration", "sequence_reduction_sink"],
      siteCount: 2,
      sites: [
        {
          path: "packages/agent/src/tools/read.ts",
          line: 1,
          symbol: "<module>",
          detector: "named:MAX_OUTPUT_CHARS",
          expression: "16_000",
          reasonCode: "named_boundary_declaration",
        },
        {
          path: "packages/agent/src/tools/read.ts",
          line: 4,
          symbol: "read",
          detector: "call:slice",
          expression: "value.slice(0, MAX_OUTPUT_CHARS)",
          reasonCode: "sequence_reduction_sink",
        },
      ],
    };
    const map = renderInvestigationMap({ observations: [observation, junction], decisions: [], legacy: [] });
    expect(map).toContain("Reusable semantic-loss and producer junctions: 1");
    expect(map).toContain(junction.locator);
    expect(map).toContain("not machine verdicts or a numerically capped top-N list");
  });

  test("types every scout record and carries mechanical coverage and navigation evidence", () => {
    const coverage: LimitDetectorCoverage = {
      recordType: "coverage",
      supportedSourceKinds: ["typescript"],
      supportedSyntax: ["direct numeric returns"],
      unsupportedSyntax: ["semantic legitimacy"],
    };
    const links = new Map<string, readonly LimitInvestigationLink[]>([[observation.locator, [{
      kind: "consumer",
      path: observation.path,
      line: observation.line,
      symbol: observation.symbol,
      reasonCode: observation.reasonCode,
      detail: observation.sites[0]!.expression,
    }]]]);
    const rows = renderScout({ observations: [observation], coverage, linksByLocator: links })
      .trim().split("\n").map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(rows.map((row) => row["recordType"])).toEqual(["header", "coverage", "observation"]);
    expect(rows[1]?.["unsupportedSyntax"]).toContain("semantic legitimacy");
    expect(rows[2]?.["investigationLinks"]).toEqual(links.get(observation.locator));
  });

  test("redacts private planning identifiers and personal data from public scout evidence", () => {
    const planningId = ["D", "999"].join("");
    const issueId = ["ISSUE", "M", "999"].join("-").replace("M-", "M");
    const email = ["example", "example.invalid"].join("@");
    const userPath = ["", "Users", "example", "project"].join("/");
    const sensitiveObservation = {
      ...observation,
      sites: [{ ...observation.sites[0]!, expression: `describe("legacy ${planningId} scenario")` }],
    };
    const links = new Map<string, readonly LimitInvestigationLink[]>([[observation.locator, [{
      kind: "caller",
      path: observation.path,
      line: observation.line,
      symbol: observation.symbol,
      reasonCode: observation.reasonCode,
      detail: `${issueId} historical fixture by ${email} from ${userPath}`,
    }]]]);
    const rendered = renderScout({
      observations: [sensitiveObservation],
      coverage: {
        recordType: "coverage",
        supportedSourceKinds: ["typescript"],
        supportedSyntax: ["direct numeric returns"],
        unsupportedSyntax: ["semantic legitimacy"],
      },
      linksByLocator: links,
    });
    expect(rendered).not.toContain(planningId);
    expect(rendered).not.toContain(issueId);
    expect(rendered).toContain("[private planning reference]");
    expect(rendered).not.toContain(email);
    expect(rendered).not.toContain(userPath);
    expect(rendered).toContain("[email]");
    expect(rendered).toContain("/[user-home]/project");
  });
});
