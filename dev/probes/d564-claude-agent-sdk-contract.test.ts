import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("D564 Claude direct contract probe", () => {
  test("publishes its finite provider-turn budgets in the static receipt", () => {
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "d564-claude-agent-sdk-contract.ts"),
      "--static",
    ]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toMatchObject({
      static: "ok",
      streamTurnBudget: 4,
      childTurnBudget: 2,
      stopChildTurnBudget: 2,
      reviewTurnBudget: 2,
    });
  });
});
