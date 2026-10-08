import { describe, expect, test } from "bun:test";
import { projectToolResultForEvent, TOOL_RESULT_MAX_BYTES } from "../../src/realtime";

function receipt(data: string, cursor = 0) {
  const end = cursor + new TextEncoder().encode(data).byteLength;
  return { executionId: "execution-fixture", session_id: "execution-fixture", generation: "generation-fixture",
    state: "completed", tty: false, pid: 123, exitCode: 7, signal: null,
    terminationScope: "owned_process_group", failureCode: null, expiresAt: 123456, resources: "released",
    output: { data, cursor, nextCursor: end, availableFrom: cursor, produced: end, gap: cursor > 0, hasMore: false } };
}
type Receipt = ReturnType<typeof receipt>;

for (const tool of ["exec_command", "write_stdin"]) {
  describe(`${tool} live event projection`, () => {
    for (const content of ["plain", "多字节😀", "\"\\\n\u0000"]) {
      test(`preserves receipt and exact recoverable output cursor for ${JSON.stringify(content)}`, () => {
        const original = receipt(content.repeat(TOOL_RESULT_MAX_BYTES), 12);
        const source = JSON.stringify(original);
        const projected = projectToolResultForEvent(tool, source);
        expect(projected.truncated).toBe(true);
        expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
        const parsed = JSON.parse(projected.result) as Receipt;
        expect({ ...parsed, output: undefined }).toEqual({ ...original, output: undefined });
        expect(parsed.output.data.length).toBeGreaterThan(0);
        expect(original.output.data.startsWith(parsed.output.data)).toBe(true);
        expect(parsed.output.data.endsWith("\ufffd")).toBe(false);
        const shownBytes = new TextEncoder().encode(parsed.output.data).byteLength;
        expect(parsed.output).toEqual({ ...original.output, data: parsed.output.data,
          nextCursor: original.output.cursor + shownBytes, hasMore: true });
        // The retained producer page can resume at exactly the projected cursor.
        const remainder = new TextDecoder("utf-8", { fatal: true }).decode(
          new TextEncoder().encode(original.output.data).subarray(parsed.output.nextCursor - original.output.cursor));
        expect(parsed.output.data + remainder).toBe(original.output.data);
        expect(source).toBe(JSON.stringify(original));
      });
    }
    test("preserves small receipts without projection", () => {
      const source = JSON.stringify(receipt("done\n"));
      expect(projectToolResultForEvent(tool, source)).toEqual({ result: source, truncated: false });
    });
    test("honors byte limits even when the character count fits", () => {
      const source = JSON.stringify(receipt("界".repeat(Math.floor(TOOL_RESULT_MAX_BYTES / 2))));
      expect(source.length).toBeLessThan(TOOL_RESULT_MAX_BYTES);
      const projected = projectToolResultForEvent(tool, source);
      expect(projected.truncated).toBe(true);
      expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
      expect((JSON.parse(projected.result) as Receipt).output.hasMore).toBe(true);
    });
    test("retains running state, resources, and existing continuation", () => {
      const original = { ...receipt("x".repeat(TOOL_RESULT_MAX_BYTES)), state: "running", exitCode: null,
        expiresAt: null, resources: "owned" };
      original.output.produced += 50;
      original.output.hasMore = true;
      const parsed = JSON.parse(projectToolResultForEvent(tool, JSON.stringify(original)).result) as Receipt;
      expect(parsed.state).toBe("running");
      expect(parsed.exitCode).toBeNull();
      expect(parsed.expiresAt).toBeNull();
      expect(parsed.resources).toBe("owned");
      expect(parsed.output.produced).toBe(original.output.produced);
      expect(parsed.output.hasMore).toBe(true);
    });
    test("does not preserve forged identities or inconsistent byte offsets", () => {
      const original = receipt("x".repeat(TOOL_RESULT_MAX_BYTES));
      for (const invalid of [
        { ...original, session_id: "different-execution" },
        { ...original, state: "invented" },
        { ...original, output: { ...original.output, nextCursor: 1 } },
        { ...original, output: { ...original.output, hasMore: true } },
        { ...original, extra: "untrusted" },
      ]) {
        expect(projectToolResultForEvent(tool, JSON.stringify(invalid)).result).toContain("bytes truncated");
      }
    });
    test("does not bypass the cap when metadata alone is oversized", () => {
      const original = { ...receipt("data"), generation: "x".repeat(TOOL_RESULT_MAX_BYTES) };
      expect(projectToolResultForEvent(tool, JSON.stringify(original)).result).toContain("bytes truncated");
    });
  });
}

test("an unrelated tool cannot opt into managed receipt projection", () => {
  const source = JSON.stringify(receipt("x".repeat(TOOL_RESULT_MAX_BYTES)));
  expect(projectToolResultForEvent("other_tool", source).result).toContain("bytes truncated");
});


test("historical output projection preserves read-only provenance and resumable Unicode byte range", () => {
  const original = { ...receipt("界🌊".repeat(TOOL_RESULT_MAX_BYTES), 17), historical: true, expiresAt: null };
  const source = JSON.stringify(original);
  const projected = projectToolResultForEvent("write_stdin", source);
  const value = JSON.parse(projected.result) as typeof original;
  expect(projected.truncated).toBe(true); expect(value.historical).toBe(true);
  expect(value.state).toBe("completed"); expect(value.exitCode).toBe(7);
  expect(value.output.nextCursor).toBe(17 + new TextEncoder().encode(value.output.data).byteLength);
  expect(value.output.hasMore).toBe(true); expect(value.output.produced).toBe(original.output.produced);
  expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  expect(source).toBe(JSON.stringify(original));
});
test("historical marker cannot disguise an active receipt or act as archive-overlay authority", () => {
  const original = { ...receipt("x".repeat(TOOL_RESULT_MAX_BYTES)), historical: true, expiresAt: null };
  for (const invalid of [{ ...original, state: "running" }, { ...original, resources: "owned" }, { ...original, resources: "release_failed" }, { ...original, expiresAt: 42 }, { ...original, historical: "true" }, { ...original, archived: true }]) {
    expect(projectToolResultForEvent("write_stdin", JSON.stringify(invalid)).result).toContain("bytes truncated");
  }
});

test("search projection preserves separate search continuation while bounding only displayed output", () => {
  for (const historical of [false, true]) {
    const base = receipt("界🌊".repeat(TOOL_RESULT_MAX_BYTES), 12);
    const original = { ...base, ...(historical ? { historical: true, expiresAt: null } : {}),
      search: { matchedAt: 12, nextSearchCursor: 15, complete: false, gap: true, availableFrom: 12, produced: base.output.produced } };
    const source = JSON.stringify(original);
    const projected = projectToolResultForEvent("write_stdin", source);
    const parsed = JSON.parse(projected.result) as typeof original;
    expect(projected.truncated).toBeTrue(); expect(parsed.search).toEqual(original.search);
    expect(parsed.output.nextCursor).toBeGreaterThan(parsed.search.nextSearchCursor);
    expect(parsed.output.nextCursor).toBe(12 + new TextEncoder().encode(parsed.output.data).byteLength);
    expect(new TextEncoder().encode(projected.result).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(source).toBe(JSON.stringify(original));
    for (const search of [{ ...original.search, nextSearchCursor: 11 }, { ...original.search, complete: true },
      { ...original.search, produced: 0 }, { ...original.search, extra: true }]) {
      expect(projectToolResultForEvent("write_stdin", JSON.stringify({ ...original, search })).result).toContain("bytes truncated");
    }
  }
});
