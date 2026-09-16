import { describe, expect, test } from "bun:test";
import { readTextWindow, type TextWindowSource } from "../../src/text-window";

function source(bytes: Buffer): TextWindowSource & { reads: number[] } {
  const reads: number[] = [];
  return { size: bytes.length, version: "source-v1", reads,
    readRange: async (offset, length) => { reads.push(length); return bytes.subarray(offset, offset + length); },
    currentVersion: async () => "source-v1",
  };
}

describe("versioned text windows", () => {
  test("reads a small late range in a >16 MiB file with bounded allocations", async () => {
    const prefix = Buffer.from("skip\n".repeat(3_400_000));
    const input = source(Buffer.concat([prefix, Buffer.from("needle\r\nlast")]));
    const page = await readTextWindow(input, { from: 3_400_001, to: 3_400_001 });
    expect(page.content).toBe("needle\r\n");
    expect(page.startByte).toBe(prefix.length);
    expect(page.endByte).toBe(prefix.length + Buffer.byteLength(page.content));
    expect(Math.max(...input.reads)).toBeLessThanOrEqual(64 * 1024);
    expect(page.nextCursor).toBeNull();
    expect(page.nextLineOffset).toBe(3_400_002);
  });

  test("reconstructs every byte of a long Unicode line across arbitrary byte boundaries", async () => {
    const bytes = Buffer.from("x".repeat(65_535) + "🦊é漢".repeat(20_000) + "\r\nlast");
    const input = source(bytes);
    const parts: Buffer[] = [];
    let cursor: string | undefined;
    let offset = 0;
    do {
      const page = await readTextWindow(input, { from: 1, to: 2, ...(cursor ? { cursor } : {}) });
      const part = Buffer.from(page.content);
      expect(page.startByte).toBe(offset);
      expect(page.endByte).toBe(offset + part.length);
      expect(part.equals(bytes.subarray(offset, page.endByte))).toBe(true);
      expect(page.content).not.toContain("�");
      parts.push(part); offset = page.endByte;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(Buffer.concat(parts).equals(bytes)).toBe(true);
  });

  test("rejects version changes between pages and during a read", async () => {
    const input = source(Buffer.from("a".repeat(100_000)));
    const first = await readTextWindow(input, { from: 1, to: 1 });
    expect(first.nextCursor).not.toBeNull();
    expect(readTextWindow({ ...input, version: "source-v2" }, { from: 1, to: 1, cursor: first.nextCursor! })).rejects.toThrow("Source changed");
    expect(readTextWindow({ ...input, currentVersion: async () => "source-v2" }, { from: 1, to: 1 })).rejects.toThrow("Source changed");
  });

  test("handles empty text and cancellation without inventing content", async () => {
    expect((await readTextWindow(source(Buffer.alloc(0)), { from: 1, to: 1 })).content).toBe("");
    const controller = new AbortController(); controller.abort();
    const input = source(Buffer.from("abc"));
    expect(readTextWindow(input, { from: 1, to: 1, signal: controller.signal })).rejects.toThrow();
    expect(input.reads).toHaveLength(0);
  });
});


test("a forged cursor cannot relabel source bytes as a different citable line", async () => {
  const input = source(Buffer.from("x".repeat(100_000)));
  const page = await readTextWindow(input, { from: 1, to: 1 });
  const [payload, signature] = page.nextCursor!.split(".");
  const position = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as unknown[];
  position[2] = 100;
  position[3] = 100;
  const forged = `${Buffer.from(JSON.stringify(position)).toString("base64url")}.${signature}`;
  const readsBefore = input.reads.length;
  expect(readTextWindow(input, { from: 1, to: 1, cursor: forged })).rejects.toThrow("Invalid or expired");
  expect(input.reads).toHaveLength(readsBefore);
});


test("preserves UTF-8 BOM bytes at the start of a file and a continuation page", async () => {
  const bytes = Buffer.from("\uFEFF" + "x".repeat(65_533) + "\uFEFFtail");
  const input = source(bytes);
  const first = await readTextWindow(input, { from: 1, to: 1 });
  const second = await readTextWindow(input, { from: 1, to: 1, cursor: first.nextCursor! });
  expect(Buffer.from(first.content).length).toBe(first.endByte - first.startByte);
  expect(Buffer.from(second.content).length).toBe(second.endByte - second.startByte);
  expect(Buffer.from(first.content + second.content).equals(bytes)).toBeTrue();
});
