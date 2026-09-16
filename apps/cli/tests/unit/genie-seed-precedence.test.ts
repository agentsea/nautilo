import { describe, test, expect } from "bun:test";
import { randomizeGenie } from "../../src/lib/genie-randomize.ts";

const providers = [{ key: "OPENAI_API_KEY", value: { value: "sk-x" } }];

/** Mirrors `handleGenie` seed precedence: CLI `--seed` > template `genie.seed` > time-based. */
function effectiveGenieSeed(
  argvSeed: number | undefined,
  blockSeed: number | undefined,
  timeFallback: number,
): number | undefined {
  return argvSeed ?? blockSeed ?? timeFallback;
}

describe("Genie seed precedence", () => {
  test("--seed wins over template genie.seed", () => {
    const block = { mode: "randomize" as const, seed: 13 };
    const eff = effectiveGenieSeed(7, block.seed, 999);
    expect(eff).toBe(7);
    const a = randomizeGenie(block, providers, eff);
    const b = randomizeGenie(block, providers, 7);
    expect(a).toEqual(b);
    expect(eff).not.toBe(13);
  });

  test("template seed used when argv absent", () => {
    const block = { mode: "randomize" as const, seed: 13 };
    const eff = effectiveGenieSeed(undefined, block.seed, 999);
    expect(eff).toBe(13);
  });

  test("neither flag nor template seed still produces stable identity within one call", () => {
    const block = { mode: "randomize" as const };
    const eff = effectiveGenieSeed(undefined, undefined, 555);
    const once = randomizeGenie(block, providers, eff);
    const twice = randomizeGenie(block, providers, eff);
    expect(once).toEqual(twice);
  });
});
