import { expect, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";
import { ClassifiedDataOperationError } from "@nautilo/lattice-bridge";
import { restoreRoomReadOutcome } from "./room-read-outcome";

test("policy-free Room read preserves terminal and retry outcomes without an ordinary retry", async () => {
  for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"],
    [404, "not-found"], [500, "failed"]] as const) {
    let calls = 0;
    expect(await restoreRoomReadOutcome(() => {
      calls++;
      return Promise.reject(new ApiError(status, "unavailable"));
    })).toEqual({ status: expected, restored: null });
    expect(calls).toBe(1);
  }
  expect(await restoreRoomReadOutcome(() => Promise.reject(new Error("unclassified"))))
    .toEqual({ status: "failed", restored: null });
});

test("Room read preserves only retryable key convergence as a typed wait", async () => {
  expect(await restoreRoomReadOutcome(() => Promise.reject(
    new ClassifiedDataOperationError("key_waiting", "Domain authority is converging"),
  ))).toEqual({
    status: "failed",
    restored: null,
    failureClass: "key_waiting",
  });

  for (const failureClass of ["authority", "integrity"] as const) {
    expect(await restoreRoomReadOutcome(() => Promise.reject(
      new ClassifiedDataOperationError(failureClass, "not a key wait"),
    ))).toEqual({ status: "failed", restored: null });
  }
});

test("Room read restoration retains empty and successful page cursors", async () => {
  const pageInfo = { hasMoreBefore: false, oldestCursor: null };
  expect(await restoreRoomReadOutcome(() => Promise.resolve({ messages: [], pageInfo })))
    .toEqual({ status: "empty", restored: null, pageInfo });
  const read = await restoreRoomReadOutcome(() => Promise.resolve({
    messages: [{ id: "1", role: "user", content: "verified" }], pageInfo,
  }));
  expect(read.status).toBe("ok");
  expect(read.pageInfo).toEqual(pageInfo);
  expect(read.restored?.[0]?.content).toEqual([{ type: "text", text: "verified" }]);
});

test("Room read restoration carries the trusted unavailable reason into local metadata", async () => {
  const read = await restoreRoomReadOutcome(() => Promise.resolve({ messages: [{
    id: "1",
    role: "user",
    content: "Encrypted history is unavailable on this device.",
    historyUnavailable: true as const,
    historyUnavailableReason: "key_waiting" as const,
  }] }));
  expect(read.restored?.[0]?.metadata?.custom).toMatchObject({
    historyUnavailable: true,
    historyUnavailableReason: "key_waiting",
  });
});

test("Room read restoration preserves server-authorized artifact pointers", async () => {
  const read = await restoreRoomReadOutcome(() => Promise.resolve({ messages: [{
    id: "u1", role: "user", content: "Please review this", artifacts: [{
      roomId: "room-1", artifactInternalId: "artifact-1", basename: "master-plan.md",
      mimeType: "text/markdown", sizeBytes: 120,
    }],
  }] }));
  expect(read.restored?.[0]).toMatchObject({ metadata: { custom: { artifactOpenRefs: [{
    roomId: "room-1", artifactInternalId: "artifact-1", basename: "master-plan.md",
  }] } } });
});
