import { z } from "zod";
import { describe, expect, test } from "bun:test";
import { readResultWindow, resultVersion, type ResultReadArgs } from "../../src/tools/result-reader/result-window";

const parsePage = (text: string) => z.object({ startByte: z.number().optional(), endByte: z.number().optional(), text: z.string().optional(), nextCursor: z.string().nullable().optional(), type: z.string().optional(), fields: z.array(z.string()).optional(), records: z.number().optional(), match: z.object({ startByte: z.number() }).nullable().optional(), complete: z.boolean() }).parse(JSON.parse(text));

function args(source: string, operation: ResultReadArgs["operation"] = "read"): ResultReadArgs {
  return { reference: { kind: "call", callId: "synthetic-call", sourceVersion: resultVersion(source) }, operation };
}

describe("retained result windows", () => {
  test("long records and Unicode reassemble without loss and every page fits", () => {
    const source = JSON.stringify({ rows: ["first", "é🐢".repeat(12000), "last"] });
    let input = args(source);
    let recovered = "", previous = 0;
    do {
      const output = readResultWindow(source, input, 1800);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1800);
      const page = parsePage(output);
      expect(page.startByte).toBe(previous);
      expect(page.endByte).toBeGreaterThan(previous);
      recovered += page.text!;
      previous = page.endByte!;
      input = { ...input, cursor: page.nextCursor ?? undefined };
    } while (input.cursor);
    expect(recovered).toBe(source);
  });

  test("inspection pages keys and exposes array sizes without source values", () => {
    const source = JSON.stringify(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`column${i}`, "private value"])));
    let input = args(source, "inspect");
    const keys: string[] = [];
    do {
      const output = readResultWindow(source, input, 900);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(900);
      expect(output).not.toContain("private value");
      const page = parsePage(output);
      keys.push(...page.fields!);
      input = { ...input, cursor: page.nextCursor ?? undefined };
    } while (input.cursor);
    expect(keys).toHaveLength(100);
    const array = JSON.stringify({ rows: ["a", "b"] });
    expect(parsePage(readResultWindow(array, { ...args(array, "inspect"), path: ["rows"] }, 1200)).records).toBe(2);
  });

  test("search finds late evidence and advances independently of page overlap", () => {
    const source = "x".repeat(20000) + "needle one\nneedle two";
    const input = { ...args(source, "search"), query: "needle" };
    const first = parsePage(readResultWindow(source, input, 1500));
    expect(first.match!.startByte).toBe(20000);
    expect(first.text).toContain("needle");
    const second = parsePage(readResultWindow(source, { ...input, cursor: first.nextCursor ?? undefined }, 1500));
    expect(second.match!.startByte).toBe(20011);
    const end = parsePage(readResultWindow(source, { ...input, cursor: second.nextCursor ?? undefined }, 1500));
    expect(end.match).toBeNull();
    expect(end.complete).toBe(true);
  });

  test("large diagnostic output supports bounded late search and structured selection", () => {
    const source = JSON.stringify({ format: "xlsx", diagnostics: "layout warning\n".repeat(1_800_000), tail: { row: 18000, evidence: "late finding" } });
    expect(Buffer.byteLength(source)).toBeGreaterThan(25_000_000);
    const search = readResultWindow(source, { ...args(source, "search"), query: "late finding" }, 4096);
    expect(Buffer.byteLength(search)).toBeLessThanOrEqual(4096);
    expect(parsePage(search).text).toContain("late finding");
    const selected = parsePage(readResultWindow(source, { ...args(source), path: ["tail"] }, 4096));
    expect(selected.text).toBe(JSON.stringify({ row: 18000, evidence: "late finding" }));
    expect(selected.complete).toBe(true);
  });

  test("changed sources, mismatched selection and absent budget fail explicitly", () => {
    const source = "a".repeat(8000);
    const input = args(source);
    const page = parsePage(readResultWindow(source, input, 1200));
    expect(() => readResultWindow(source + "b", input, 1200)).toThrow("changed");
    expect(() => readResultWindow(source, { ...input, operation: "inspect", cursor: page.nextCursor ?? undefined }, 1200)).toThrow("another");
    expect(() => readResultWindow(source, input, 0)).toThrow("budget");
    expect(() => readResultWindow(source, input, 10)).toThrow("budget");
  });

  test("JSON selection permits own fields only and handles empty text", () => {
    const source = JSON.stringify({ rows: [{ name: "example", bio: "", numericText: "42" }] });
    expect(parsePage(readResultWindow(source, { ...args(source, "inspect"), path: ["rows", "0", "numericText"] }, 1500)).type).toBe("string");
    expect(parsePage(readResultWindow(source, { ...args(source), path: ["rows", "0", "name"] }, 1500)).text).toBe("example");
    expect(parsePage(readResultWindow(source, { ...args(source), path: ["rows", "0", "bio"] }, 1500)).complete).toBe(true);
    expect(() => readResultWindow(source, { ...args(source), path: ["__proto__"] }, 1500)).toThrow("unavailable");
  });
});
