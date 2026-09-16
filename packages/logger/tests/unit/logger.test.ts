import { describe, expect, test, beforeEach } from "bun:test";
import {
  setLogLevel,
  setLogOutput,
  log,
  warn,
  debug,
  error,
  runWithTurn,
  getCurrentTurnId,
} from "../../src/logger";

describe("logger", () => {
  beforeEach(() => {
    setLogLevel("info");
    setLogOutput("silent");
  });

  test("debug is suppressed at info level", () => {
    let called = false;
    const original = console.error;
    console.error = () => { called = true; };
    setLogOutput("stderr");
    debug("should not appear");
    console.error = original;
    expect(called).toBe(false);
  });

  test("debug is emitted at debug level", () => {
    let output = "";
    const original = console.error;
    console.error = (msg: string) => { output = msg; };
    setLogLevel("debug");
    setLogOutput("stderr");
    debug("visible");
    console.error = original;
    expect(output).toContain("visible");
  });

  test("warn is emitted at info level", () => {
    let output = "";
    const original = console.error;
    console.error = (msg: string) => { output = msg; };
    setLogOutput("stderr");
    warn("warning message");
    console.error = original;
    expect(output).toContain("warning message");
  });

  test("silent mode suppresses all output", () => {
    let called = false;
    const original = console.error;
    console.error = () => { called = true; };
    setLogOutput("silent");
    log("test");
    warn("test");
    error("test");
    console.error = original;
    expect(called).toBe(false);
  });

  test("runWithTurn prefixes log lines with [turn=<id>]", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (msg: string) => { lines.push(msg); };
    setLogOutput("stderr");

    runWithTurn("abc123", () => {
      log("inside turn");
      warn("also inside");
    });
    log("outside turn");

    console.error = original;
    expect(lines[0]).toBe("[turn=abc123] inside turn");
    expect(lines[1]).toBe("[turn=abc123] [WARN] also inside");
    expect(lines[2]).toBe("outside turn");
  });

  test("runWithTurn context propagates across async boundaries", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (msg: string) => { lines.push(msg); };
    setLogOutput("stderr");

    await runWithTurn("async-turn", async () => {
      log("sync-before-await");
      await new Promise<void>((r) => setTimeout(r, 1));
      log("after-await");
      expect(getCurrentTurnId()).toBe("async-turn");
    });

    console.error = original;
    expect(lines[0]).toBe("[turn=async-turn] sync-before-await");
    expect(lines[1]).toBe("[turn=async-turn] after-await");
  });

  test("getCurrentTurnId returns undefined outside any runWithTurn scope", () => {
    expect(getCurrentTurnId()).toBeUndefined();
  });

  test("nested runWithTurn uses the innermost turnId", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (msg: string) => { lines.push(msg); };
    setLogOutput("stderr");

    runWithTurn("outer", () => {
      log("outer line");
      runWithTurn("inner", () => {
        log("inner line");
      });
      log("outer again");
    });

    console.error = original;
    expect(lines[0]).toBe("[turn=outer] outer line");
    expect(lines[1]).toBe("[turn=inner] inner line");
    expect(lines[2]).toBe("[turn=outer] outer again");
  });
});
