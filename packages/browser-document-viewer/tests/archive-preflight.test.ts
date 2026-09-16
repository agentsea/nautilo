import { describe, expect, test } from "bun:test";
import { preflightOoxmlArchive } from "../src/ooxml/archive-preflight";

const limits = {
  maxEntries: 1,
  maxDeclaredTotalUncompressedBytes: 8n,
  maxDeclaredPerEntryUncompressedBytes: 8n,
};

describe("OOXML archive preflight", () => {
  test("fails closed without mutating a caller-owned view", () => {
    const backing = new Uint8Array(32);
    const source = backing.subarray(4, 28);
    source.set([0x50, 0x4b, 0x05, 0x06], 2);
    const before = backing.slice();
    expect(preflightOoxmlArchive(source, limits)).toEqual({
      ok: false,
      reason: "invalid_central_directory",
    });
    expect(backing).toEqual(before);
  });
});
