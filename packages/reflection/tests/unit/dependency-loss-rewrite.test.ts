import { describe, expect, test } from "bun:test";

import {
  DEPENDENCY_LOSS_REWRITE_CONTRACT,
  runDependencyLossRewrite,
} from "../../src/organizer/dependency-loss-rewrite";

describe("grounded dependency-loss rewrite", () => {
  test("rewrites only from remaining untrusted support", async () => {
    let prompt = "";
    const result = await runDependencyLossRewrite({
      previousStatement: "Postgres was chosen for portability and cost.",
      remainingSupportStatements: ["The team required portable SQL."],
      invoke: (value) => {
        prompt = value;
        return Promise.resolve(JSON.stringify({
          statement: "The team required portable SQL.",
        }));
      },
    });
    expect(result).toEqual({
      ok: true,
      statement: "The team required portable SQL.",
      attempts: 1,
    });
    expect(prompt.startsWith(DEPENDENCY_LOSS_REWRITE_CONTRACT)).toBe(true);
    expect(prompt).toContain("[Untrusted remaining support]");
  });

  test("repairs once and rejects unsupported response fields", async () => {
    let calls = 0;
    const result = await runDependencyLossRewrite({
      previousStatement: "Old statement",
      remainingSupportStatements: ["Remaining evidence"],
      invoke: () => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? JSON.stringify({ statement: "Remaining evidence", confidence: 1 })
          : JSON.stringify({ statement: "Remaining evidence" }));
      },
    });
    expect(result).toEqual({
      ok: true,
      statement: "Remaining evidence",
      attempts: 2,
    });
  });

  test("rejects empty support without invoking a model", async () => {
    let calls = 0;
    const result = await runDependencyLossRewrite({
      previousStatement: "Old statement",
      remainingSupportStatements: [],
      invoke: () => {
        calls += 1;
        return Promise.resolve("{}");
      },
    });
    expect(result).toEqual({
      ok: false,
      errorCode: "invalid_input",
      attempts: 0,
    });
    expect(calls).toBe(0);
  });
});
