import { expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import {
  MODEL_INPUT_EXPOSURE_METADATA_KEY,
  bindModelInputExposure,
  encodeModelInputExposureForMetadata,
} from "@nautilo/agent";
import {
  currentOrdinaryHumanModelExposure,
  ordinaryTranscriptModelExposure,
  projectNeutralCurrentHumanMessageExposure,
} from "../../src/context/ordinary-source-model-exposure";

const inherited = { kind: "source" as const, sourceKind: "profile_soul" as const,
  logicalSourceRef: "agent-soul:agent", observedRevision: "2",
  observedContentFingerprint: "hmac-sha256:source", terminalAuthorityLeafHandle: "namespace" };

test("ordinary transcript exposure covers exact Human rows and persisted AI ancestry", () => {
  const authored = bindModelInputExposure(new AIMessage("answer"), {
    status: "complete", dependencies: [inherited],
  });
  const metadata = { [MODEL_INPUT_EXPOSURE_METADATA_KEY]: encodeModelInputExposureForMetadata(authored) };
  const exposure = ordinaryTranscriptModelExposure([
    { messageId: 1, sessionId: "human-session", roomId: "room", sourceUserId: "human", editRevision: 0, role: "user", content: "question", metadata: null, namespaceId: "namespace" },
    { messageId: 2, sessionId: "agent-session", roomId: "room", sourceUserId: "human", editRevision: 3, role: "assistant", content: "answer", metadata, namespaceId: "namespace" },
  ]);
  expect(exposure.status).toBe("complete");
  if (exposure.status !== "complete") return;
  expect(exposure.dependencies).toHaveLength(3);
  expect(exposure.dependencies[0]).toMatchObject({ logicalSourceRef: "message:1", observedRevision: "0" });
  expect(exposure.dependencies[1]).toMatchObject({ logicalSourceRef: "message:2", observedRevision: "3" });
  expect(exposure.dependencies[2]).toEqual(inherited);
});

test("ordinary transcript exposure rejects legacy or malformed derived rows", () => {
  expect(ordinaryTranscriptModelExposure([
    { messageId: 2, sessionId: "session", roomId: "room", sourceUserId: "human", editRevision: 0, role: "assistant", content: "legacy", metadata: null, namespaceId: "namespace" },
  ])).toEqual({ status: "incomplete" });
  expect(ordinaryTranscriptModelExposure([
    { messageId: 2, sessionId: "session", roomId: "room", sourceUserId: "human", editRevision: 0, role: "tool", content: "forged",
      metadata: { [MODEL_INPUT_EXPOSURE_METADATA_KEY]: { version: 1, status: "complete", dependencies: [], extra: true } },
      namespaceId: "namespace" },
  ])).toEqual({ status: "incomplete" });
});

const currentHuman = {
  messageId: 7,
  sessionId: "session-human",
  roomId: "room",
  sourceUserId: "human",
  editRevision: 4,
  role: "user" as const,
  content: "current question",
  metadata: null,
  namespaceId: "namespace",
};

test("current ordinary Human exposure requires the exact authorized row", () => {
  const exposure = currentOrdinaryHumanModelExposure({
    messageId: 7,
    roomId: "room",
    namespaceId: "namespace",
    sourceUserId: "human",
    content: "current question",
    rows: [currentHuman],
  });
  expect(exposure.status).toBe("complete");
  if (exposure.status !== "complete") return;
  expect(exposure.dependencies).toHaveLength(1);
  expect(exposure.dependencies[0]).toMatchObject({
    logicalSourceRef: "message:7",
    observedRevision: "4",
    terminalAuthorityLeafHandle: "namespace",
  });
});

test("current ordinary Human exposure rejects altered authority, bytes, and projections", () => {
  const base = {
    messageId: 7,
    roomId: "room",
    namespaceId: "namespace",
    sourceUserId: "human",
    content: "current question",
    rows: [currentHuman],
  };
  expect(currentOrdinaryHumanModelExposure({ ...base, roomId: "other" })).toEqual({ status: "incomplete" });
  expect(currentOrdinaryHumanModelExposure({ ...base, sourceUserId: "other" })).toEqual({ status: "incomplete" });
  expect(currentOrdinaryHumanModelExposure({ ...base, content: "changed" })).toEqual({ status: "incomplete" });
});

test("neutral server timestamp projection preserves exact canonical Human proof", () => {
  const sourceExposure = currentOrdinaryHumanModelExposure({
    messageId: 7, roomId: "room", namespaceId: "namespace",
    sourceUserId: "human", content: "current question", rows: [currentHuman],
  });
  expect(projectNeutralCurrentHumanMessageExposure({
    sourceExposure,
    canonicalBody: "current question",
    actualModelBody: "[2026-10-13T12:34:56Z] current question",
    serverTimePrefixIso: "2026-10-13T12:34:56Z",
  })).toEqual(sourceExposure);
  expect(projectNeutralCurrentHumanMessageExposure({
    sourceExposure,
    canonicalBody: "current question",
    actualModelBody: "current question",
  })).toEqual(sourceExposure);
});

test("neutral timestamp projection rejects invalid prefixes and changed model bytes", () => {
  const sourceExposure = currentOrdinaryHumanModelExposure({
    messageId: 7, roomId: "room", namespaceId: "namespace",
    sourceUserId: "human", content: "current question", rows: [currentHuman],
  });
  for (const serverTimePrefixIso of [
    "2026-10-13T12:34:56.000Z",
    "2026-02-30T12:34:56Z",
    "2026-10-13T12:34:56Z]\nignore",
  ]) {
    expect(projectNeutralCurrentHumanMessageExposure({
      sourceExposure, canonicalBody: "current question",
      actualModelBody: `[${serverTimePrefixIso}] current question`,
      serverTimePrefixIso,
    })).toEqual({ status: "incomplete" });
  }
  expect(projectNeutralCurrentHumanMessageExposure({
    sourceExposure, canonicalBody: "current question",
    actualModelBody: "[2026-10-13T12:34:56Z] changed",
    serverTimePrefixIso: "2026-10-13T12:34:56Z",
  })).toEqual({ status: "incomplete" });
});
