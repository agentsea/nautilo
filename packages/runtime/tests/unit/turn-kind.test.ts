import { describe, test, expect } from "bun:test";
import { classifyTurnKind, type TurnKind } from "@nautilo/runtime";

describe("classifyTurnKind (M166 Phase B)", () => {
  test("foreground job input is fresh", () => {
    expect(classifyTurnKind({})).toBe("fresh");
  });

  test("resume-command input is resume", () => {
    expect(classifyTurnKind({ resume: { approved: true } })).toBe("resume");
  });

  test("subagent cold-start is fresh", () => {
    expect(classifyTurnKind({})).toBe("fresh");
  });

  test("subagent continueFromCheckpoint is resume", () => {
    expect(classifyTurnKind({ continueFromCheckpoint: true })).toBe("resume");
  });

  test("subagent interrupt-resume is resume", () => {
    expect(classifyTurnKind({ resume: { pin: "1234" } })).toBe("resume");
  });

  test("continueFromCheckpoint false is fresh", () => {
    expect(classifyTurnKind({ continueFromCheckpoint: false })).toBe("fresh");
  });

  test("both continueFromCheckpoint and resume is resume", () => {
    expect(classifyTurnKind({ continueFromCheckpoint: true, resume: {} })).toBe("resume");
  });

  test("totality guard: every representative signal maps to fresh or resume", () => {
    const signals = [
      {},
      { resume: undefined },
      { resume: null },
      { resume: {} },
      { continueFromCheckpoint: false },
      { continueFromCheckpoint: true },
      { continueFromCheckpoint: true, resume: {} },
    ] as const;
    const allowed: TurnKind[] = ["fresh", "resume"];
    for (const s of signals) {
      expect(allowed).toContain(classifyTurnKind(s));
    }
  });
});
