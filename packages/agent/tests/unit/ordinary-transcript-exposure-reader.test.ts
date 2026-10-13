import { expect, test } from "bun:test";
import { projectCurrentOrdinaryTranscriptExposureRows } from "../../src/store/session-store";

test("ordinary exposure mapper retains exact current canonical coordinates", () => {
  const metadata = { trusted: true };
  const rows = projectCurrentOrdinaryTranscriptExposureRows([8, 3], [
    { messageId: 3, sessionId: "session-human", roomId: "room", sourceUserId: "human", editRevision: 2, role: "user", content: "human", metadata: null, namespaceId: "ns" },
    { messageId: 8, sessionId: "session-agent", roomId: "room", sourceUserId: "human", editRevision: 4, role: "assistant", content: "answer", metadata, namespaceId: "ns" },
  ]);
  expect(rows).toEqual([
    { messageId: 3, sessionId: "session-human", roomId: "room", sourceUserId: "human", editRevision: 2, role: "user", content: "human", metadata: null, namespaceId: "ns" },
    { messageId: 8, sessionId: "session-agent", roomId: "room", sourceUserId: "human", editRevision: 4, role: "assistant", content: "answer", metadata, namespaceId: "ns" },
  ]);
  expect(Object.isFrozen(rows)).toBe(true);
});

test("ordinary exposure mapper rejects missing, bodyless, or unsupported current rows", () => {
  expect(() => projectCurrentOrdinaryTranscriptExposureRows([3, 8], [
    { messageId: 3, sessionId: "session", roomId: "room", sourceUserId: "human", editRevision: 1, role: "user", content: "human", metadata: null, namespaceId: "ns" },
  ])).toThrow("source changed");
  expect(() => projectCurrentOrdinaryTranscriptExposureRows([3], [
    { messageId: 3, sessionId: "session", roomId: "room", sourceUserId: "human", editRevision: 1, role: "user", content: null, metadata: null, namespaceId: "ns" },
  ])).toThrow("source changed");
  expect(() => projectCurrentOrdinaryTranscriptExposureRows([3], [
    { messageId: 3, sessionId: "session", roomId: "room", sourceUserId: "human", editRevision: 1, role: "developer", content: "body", metadata: null, namespaceId: "ns" },
  ])).toThrow("source changed");
});
