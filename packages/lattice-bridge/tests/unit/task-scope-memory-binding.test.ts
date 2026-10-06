import { expect, test } from "bun:test";

import {
  copyTaskScopeMemoryBinding,
  type TaskScopeMemoryBinding,
} from "../../src/server/task/task-scope-memory-metadata.ts";

const SCOPE = "10000000-0000-4000-8000-000000000001";
const ROOM = "20000000-0000-4000-8000-000000000002";
const ORIGIN = "30000000-0000-4000-8000-000000000003";
const READABLE = "40000000-0000-4000-8000-000000000004";

test("copies and freezes one exact canonical Task Scope Memory binding", () => {
  const readableNamespaceIds = [ORIGIN, READABLE];
  const copied = copyTaskScopeMemoryBinding({
    scopeId: SCOPE,
    memoryRoomId: ROOM,
    originWritableNamespaceId: ORIGIN,
    readableNamespaceIds,
  });
  readableNamespaceIds[0] = READABLE;

  expect(copied).toEqual({
    scopeId: SCOPE,
    memoryRoomId: ROOM,
    originWritableNamespaceId: ORIGIN,
    readableNamespaceIds: [ORIGIN, READABLE],
  });
  expect(Object.isFrozen(copied)).toBe(true);
  expect(Object.isFrozen(copied.readableNamespaceIds)).toBe(true);
});

test("rejects omitted origin, noncanonical IDs, duplicates, and extra fields", () => {
  const exact: TaskScopeMemoryBinding = {
    scopeId: SCOPE,
    memoryRoomId: ROOM,
    originWritableNamespaceId: ORIGIN,
    readableNamespaceIds: [ORIGIN, READABLE],
  };
  for (const changed of [
    { ...exact, readableNamespaceIds: [READABLE] },
    { ...exact, readableNamespaceIds: [READABLE, ORIGIN] },
    { ...exact, readableNamespaceIds: [ORIGIN, ORIGIN] },
    { ...exact, memoryRoomId: "not-a-uuid" },
    { ...exact, extra: "not-bound" },
  ]) {
    expect(() => copyTaskScopeMemoryBinding(
      changed as TaskScopeMemoryBinding,
    )).toThrow(TypeError);
  }
});
