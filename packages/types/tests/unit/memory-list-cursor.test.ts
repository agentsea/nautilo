import { expect, test } from "bun:test";
import { decodeMemoryListCursor, encodeMemoryListCursor } from "../../src/memory-list-cursor";

test("Memory pagination preserves the existing ordinary wire position", () => {
  const position = { createdAt: "2026-09-07T10:11:12.345Z", id: "91000000-0000-4000-8000-000000000001" };
  const cursor = encodeMemoryListCursor(new Date(position.createdAt), position.id);
  expect(cursor).toBe(Buffer.from(JSON.stringify(position)).toString("base64url"));
  expect(decodeMemoryListCursor(cursor)).toEqual({ ...position, createdAt: new Date(position.createdAt) });
});

test("invalid Memory cursor positions are rejected", () => {
  for (const value of ["?", "null", "{}", '{"createdAt":12,"id":"x"}',
    '{"createdAt":"invalid","id":"x"}', '{"createdAt":"2026-01-01","id":12}']) {
    expect(decodeMemoryListCursor(Buffer.from(value).toString("base64url"))).toBeNull();
  }
});
