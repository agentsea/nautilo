import { describe, expect, test } from "bun:test";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import {
  countUserTurns,
  shouldRunExitFlush,
} from "../../src/memory/exit-flush";
import { setConfigOverrides } from "@nautilo/config";

describe("exit-flush", () => {
  test("counts only human turns", () => {
    const turns = countUserTurns([
      new HumanMessage("hi"),
      new AIMessage("hello"),
      new HumanMessage("second"),
    ]);
    expect(turns).toBe(2);
  });

  test("skips flush under min turn threshold", () => {
    setConfigOverrides({
      nautilo_exit_flush_enabled: true,
      nautilo_flush_min_turns: 3,
    });

    const shouldRun = shouldRunExitFlush([
      new HumanMessage("hi"),
      new AIMessage("hello"),
      new HumanMessage("bye"),
    ]);

    expect(shouldRun).toBe(false);
  });

  test("runs flush at or above threshold", () => {
    setConfigOverrides({
      nautilo_exit_flush_enabled: true,
      nautilo_flush_min_turns: 3,
    });

    const shouldRun = shouldRunExitFlush([
      new HumanMessage("one"),
      new HumanMessage("two"),
      new HumanMessage("three"),
    ]);

    expect(shouldRun).toBe(true);
  });

  test("respects disabled flag", () => {
    setConfigOverrides({
      nautilo_exit_flush_enabled: false,
      nautilo_flush_min_turns: 0,
    });

    const shouldRun = shouldRunExitFlush([new HumanMessage("one")]);
    expect(shouldRun).toBe(false);
    setConfigOverrides({});
  });
});
