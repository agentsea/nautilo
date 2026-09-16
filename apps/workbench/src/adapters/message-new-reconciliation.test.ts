import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  reconcileAdvancedVideoWorkcardMessage,
  reconcileCanonicalHumanMessage,
} from "./message-new-reconciliation";

function optimisticMessage(id = "user-local"): ThreadMessageLike {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: "fresh message" }],
    metadata: {
      custom: {
        optimisticAuthoredText: "fresh message",
      },
    },
  } as ThreadMessageLike;
}

const canonical = {
  messageId: "42",
  content: "fresh message",
  sourceUserId: "user-1",
  logicalMessageKey: "turn:fingerprint-1",
  editRevision: 0,
};

const artifact = {
  roomId: "room-1",
  artifactInternalId: "artifact-1",
  basename: "master-plan.md",
  mimeType: "text/markdown",
  sizeBytes: 120,
};

describe("live Human message reconciliation (M230)", () => {
  test("reconciles an optimistic Advanced video workcard row without exposing its machine instruction", () => {
    const raw = "Continue the Advanced Seedance reference-to-video brief from the workcard.";
    const optimistic = {
      id: "user-local",
      role: "system",
      content: [{ type: "text", text: "Advanced video workcard · Requested exact quote with 2 references." }],
      metadata: { custom: { workcardContinuationRequestText: raw } },
    } as ThreadMessageLike;
    const reconciled = reconcileAdvancedVideoWorkcardMessage([optimistic], {
      messageId: "42",
      content: raw,
      continuation: { kind: "advanced_video", referenceCount: 2 },
    });
    expect(reconciled).toMatchObject([{
      id: "42",
      role: "system",
      content: [{ type: "text", text: "Advanced video workcard · Requested exact quote with 2 references." }],
    }]);
    expect(JSON.stringify(reconciled)).not.toContain(raw);
  });

  test("adds the same neutral row for a live workcard event on another client", () => {
    const reconciled = reconcileAdvancedVideoWorkcardMessage([], {
      messageId: "43",
      content: "private instruction",
      continuation: { kind: "advanced_video", referenceCount: 1 },
    });
    expect(reconciled).toMatchObject([{
      id: "43",
      role: "system",
      content: [{ type: "text", text: "Advanced video workcard · Requested exact quote with 1 reference." }],
    }]);
  });

  test("stamps logical edit metadata while replacing an optimistic id", () => {
    const reconciled = reconcileCanonicalHumanMessage(
      [optimisticMessage()],
      canonical,
      "user-1",
    );

    expect(reconciled[0]?.id).toBe("42");
    expect(reconciled[0]?.metadata).toMatchObject({
      custom: {
        sourceUserId: "user-1",
        logicalMessageKey: "turn:fingerprint-1",
        editRevision: 0,
      },
    });
  });

  test("repairs metadata when the HTTP response reconciled the id first", () => {
    const reconciled = reconcileCanonicalHumanMessage(
      [optimisticMessage("42")],
      canonical,
      "user-1",
    );

    expect(reconciled[0]?.metadata).toMatchObject({
      custom: {
        sourceUserId: "user-1",
        logicalMessageKey: "turn:fingerprint-1",
        editRevision: 0,
      },
    });
  });

  test("updates an already-canonical sender bubble with live document pointers", () => {
    const reconciled = reconcileCanonicalHumanMessage(
      [optimisticMessage("42")],
      { ...canonical, artifacts: [artifact, artifact] },
      "user-1",
    );

    expect(reconciled[0]?.metadata).toMatchObject({
      custom: {
        artifactOpenRefs: [artifact],
      },
    });
  });

  test("replaces a duplicate physical row by logical turn key", () => {
    const duplicate = {
      ...optimisticMessage("3546"),
      metadata: {
        custom: {
          sourceUserId: "user-1",
          logicalMessageKey: "turn:fingerprint-1",
          editRevision: 0,
        },
      },
    } as ThreadMessageLike;

    const reconciled = reconcileCanonicalHumanMessage(
      [duplicate],
      { ...canonical, messageId: "3548", content: "canonical text" },
      "someone-else",
    );

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.id).toBe("3548");
    expect(reconciled[0]?.content).toEqual([
      { type: "text", text: "canonical text" },
    ]);
  });

  test("does not collapse identical text from different logical turns", () => {
    const first = reconcileCanonicalHumanMessage([], canonical, "user-1");
    const second = reconcileCanonicalHumanMessage(
      first,
      {
        ...canonical,
        messageId: "43",
        logicalMessageKey: "turn:fingerprint-2",
      },
      "user-1",
    );

    expect(second.map((message) => message.id)).toEqual(["42", "43"]);
  });
});
