import { describe, expect, test } from "bun:test";
import { defaultAgentResponseModeAtMint } from "../../src/queries";

describe("defaultAgentResponseModeAtMint", () => {
  test("no agents → null", () => {
    expect(defaultAgentResponseModeAtMint([{ kind: "user" }])).toBeNull();
    expect(
      defaultAgentResponseModeAtMint([{ kind: "user" }, { kind: "user" }]),
    ).toBeNull();
  });

  test("1 human + agent → active (DM default)", () => {
    expect(
      defaultAgentResponseModeAtMint([{ kind: "user" }, { kind: "agent" }]),
    ).toBe("active");
  });

  test("≥2 humans + agent → mention_only (group default)", () => {
    expect(
      defaultAgentResponseModeAtMint([
        { kind: "user" },
        { kind: "user" },
        { kind: "agent" },
      ]),
    ).toBe("mention_only");
    expect(
      defaultAgentResponseModeAtMint([
        { kind: "user" },
        { kind: "user" },
        { kind: "user" },
        { kind: "agent" },
      ]),
    ).toBe("mention_only");
  });

  test("agent-only room → null (no human composition rule)", () => {
    expect(defaultAgentResponseModeAtMint([{ kind: "agent" }])).toBeNull();
    expect(
      defaultAgentResponseModeAtMint([{ kind: "agent" }, { kind: "agent" }]),
    ).toBeNull();
  });

  test("NO-OP guard: ≥2 humans must not resolve to active", () => {
    const mode = defaultAgentResponseModeAtMint([
      { kind: "user" },
      { kind: "user" },
      { kind: "agent" },
    ]);
    expect(mode).not.toBe("active");
    expect(mode).toBe("mention_only");
  });
});
