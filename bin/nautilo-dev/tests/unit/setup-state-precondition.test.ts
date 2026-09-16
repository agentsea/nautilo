import { describe, expect, test } from "bun:test";
import {
  buildSetupStatePreconditionMessage,
  SETUP_STATES_CLAIMED_OR_LATER,
  SETUP_STATE_CLI_HINTS,
} from "../../src/lib/setup-state-precondition";

describe("setup-state-precondition (D112 Phase 5.2)", () => {
  test("fresh-unclaimed message cites setupState and nautilo-dev hint", () => {
    const m = buildSetupStatePreconditionMessage("migrate-to-logto", "fresh-unclaimed");
    expect(m).toContain("setupState=fresh-unclaimed");
    expect(m).toContain("migrate-to-logto");
    expect(m).toContain("bun run dev:setup-status");
  });

  test("every setupState has a non-empty hint except ready", () => {
    const states = Object.keys(SETUP_STATE_CLI_HINTS) as (keyof typeof SETUP_STATE_CLI_HINTS)[];
    for (const s of states) {
      if (s === "ready") {
        expect(SETUP_STATE_CLI_HINTS[s]).toBe("");
      } else {
        expect(SETUP_STATE_CLI_HINTS[s].length).toBeGreaterThan(20);
      }
    }
  });

  test("CLAIMED_OR_LATER contains all post-claim states", () => {
    expect(SETUP_STATES_CLAIMED_OR_LATER.has("fresh-unclaimed")).toBe(false);
    expect(SETUP_STATES_CLAIMED_OR_LATER.has("claimed-needs-auth")).toBe(true);
    expect(SETUP_STATES_CLAIMED_OR_LATER.has("server-needs-keys")).toBe(true);
    expect(SETUP_STATES_CLAIMED_OR_LATER.has("ready")).toBe(true);
  });
});
