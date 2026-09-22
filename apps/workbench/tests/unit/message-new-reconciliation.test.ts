import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY,
  reconcileCanonicalHumanMessage,
  settleHumanMessageVerification,
} from "../../src/adapters/message-new-reconciliation";

const canonical = { messageId: "42", content: "hello", sourceUserId: "taylor" };

const artifact = {
  roomId: "room-1",
  artifactInternalId: "artifact-1",
  basename: "master-plan.md",
  mimeType: "text/markdown",
  sizeBytes: 120,
};

const imageAttachment = {
  attachmentId: "attachment-image",
  filename: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 42,
};

const optimisticImageMetadata = (authoredText: string, ...attachmentIds: string[]) => ({
  optimisticAuthoredText: authoredText,
  [OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY]: attachmentIds,
});

function textMessage(id: string, text: string): ThreadMessageLike {
  return { id, role: "user", content: [{ type: "text", text }] };
}

describe("protected Human receive display", () => {
  const pending = () => reconcileCanonicalHumanMessage([], {
    ...canonical, verificationPending: true,
  }, "another-user");

  test("withholds ordinary content and records progress outside message text", () => {
    const messages = pending();
    expect(messages[0]?.content).toEqual([{ type: "text", text: "" }]);
    expect(messages[0]?.metadata?.custom?.humanMessageVerification).toBe("pending");
    expect(JSON.stringify(messages)).not.toContain(canonical.content);
  });

  test("verified content replaces the existing pending bubble, even when canonical metadata matches", () => {
    const waiting = pending();
    const reconciled = reconcileCanonicalHumanMessage(waiting, canonical, "another-user");
    const verified = settleHumanMessageVerification(reconciled, "42", {
      status: "verified", content: "locally decrypted content",
    });
    expect(verified).toHaveLength(1);
    expect(verified[0]?.content).toEqual([{ type: "text", text: "locally decrypted content" }]);
    expect(verified[0]?.metadata?.custom?.humanMessageVerification).toBe("verified");
    expect(verified[0]?.id).toBe(waiting[0]?.id);
    expect(reconcileCanonicalHumanMessage(verified, {
      ...canonical, verificationPending: true,
    }, "another-user")).toBe(verified);
    expect(settleHumanMessageVerification(verified, "42", { status: "failed" })).toBe(verified);
  });

  test("a strict pending projection also withholds an already-present ordinary row", () => {
    const ordinary = reconcileCanonicalHumanMessage([], {
      ...canonical,
      attachments: [imageAttachment],
    }, "another-user");
    const waiting = reconcileCanonicalHumanMessage(ordinary, { ...canonical, verificationPending: true }, "another-user");
    expect(waiting[0]?.content).toEqual([{ type: "text", text: "" }]);
    expect(waiting[0]?.metadata?.custom?.humanMessageVerification).toBe("pending");
    expect(waiting[0]?.metadata?.custom?.messageAttachments).toBeUndefined();
  });

  test("failure stops progress without exposing plaintext; a later verified result can recover", () => {
    const failed = settleHumanMessageVerification(pending(), "42", { status: "failed" });
    expect(failed[0]?.content).toEqual([{ type: "text", text: "" }]);
    expect(failed[0]?.metadata?.custom?.humanMessageVerification).toBe("failed");
    const recovered = settleHumanMessageVerification(failed, "42", { status: "verified", content: "opened" });
    expect(recovered[0]?.content).toEqual([{ type: "text", text: "opened" }]);
    expect(recovered[0]?.metadata?.custom?.humanMessageVerification).toBe("verified");
    expect(recovered[0]?.metadata?.custom?.messageAttachments).toBeUndefined();
  });

  test("late results do not insert a message into a cleared Room", () => {
    const cleared: ThreadMessageLike[] = [];
    expect(settleHumanMessageVerification(cleared, "42", { status: "failed" })).toBe(cleared);
    expect(settleHumanMessageVerification(cleared, "42", { status: "verified", content: "opened" })).toBe(cleared);
  });
});

describe("reconcileCanonicalHumanMessage", () => {
  test("appends a same-user event on a second desktop with no optimistic bubble", () => {
    const result = reconcileCanonicalHumanMessage([], canonical, "taylor");
    expect(result).toEqual([expect.objectContaining({ id: "42", role: "user" })]);
  });

  test("replaces the matching local optimistic bubble with the canonical id", () => {
    const result = reconcileCanonicalHumanMessage([textMessage("user-local", "hello")], canonical, "taylor");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "42" });
  });

  test("reconciles one sender bubble with deduped canonical image descriptors", () => {
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", "📎 Attached: screenshot.png\n\nhello"),
      metadata: { custom: optimisticImageMetadata("hello", imageAttachment.attachmentId) },
    };
    const result = reconcileCanonicalHumanMessage(
      [optimistic],
      { ...canonical, attachments: [imageAttachment, imageAttachment] },
      "taylor",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "42",
      content: [{ type: "text", text: "hello" }],
      metadata: { custom: { messageAttachments: [imageAttachment] } },
    });
    expect(result[0]?.metadata?.custom?.optimisticAuthoredText).toBeUndefined();
  });

  test("replaces an HTTP-first image-only filename summary with authored empty text", () => {
    const httpRekeyed: ThreadMessageLike = {
      ...textMessage("42", "📎 Attached: screenshot.png (ok)"),
      metadata: { custom: optimisticImageMetadata("", imageAttachment.attachmentId) },
    };
    const initial = [httpRekeyed];
    const result = reconcileCanonicalHumanMessage(
      initial,
      { ...canonical, content: "internal expanded attachment text", attachments: [imageAttachment] },
      "taylor",
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toEqual([{
      type: "text", text: "(User attached images.)",
    }]);
    expect(result[0]?.metadata?.custom?.messageAttachments).toEqual([imageAttachment]);
    expect(result[0]?.metadata?.custom?.optimisticAuthoredText).toBeUndefined();
  });

  test("consumes the temporary summary when HTTP-first metadata already has image refs", () => {
    const httpRekeyed: ThreadMessageLike = {
      ...textMessage("42", "📎 Attached: screenshot.png (ok)\n\ncaption"),
      metadata: {
        custom: {
          optimisticAuthoredText: "caption",
          [OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY]: [imageAttachment.attachmentId],
          sourceUserId: "taylor",
          editRevision: 0,
          messageAttachments: [imageAttachment],
        },
      },
    };
    const initial = [httpRekeyed];
    const result = reconcileCanonicalHumanMessage(
      initial,
      { ...canonical, content: "internal expanded attachment text", editRevision: 0, attachments: [imageAttachment] },
      "taylor",
    );

    expect(result).not.toBe(initial);
    expect(result[0]?.content).toEqual([{ type: "text", text: "caption" }]);
    expect(result[0]?.metadata?.custom?.optimisticAuthoredText).toBeUndefined();
  });

  test("replaces a WS-first image summary with the exact authored caption", () => {
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", "📎 Attached: screenshot.png\n\nA caption"),
      metadata: { custom: optimisticImageMetadata("A caption", imageAttachment.attachmentId) },
    };
    const result = reconcileCanonicalHumanMessage(
      [optimistic],
      { ...canonical, content: "internal expanded attachment text", attachments: [imageAttachment] },
      "taylor",
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("42");
    expect(result[0]?.content).toEqual([{ type: "text", text: "A caption" }]);
    expect(result[0]?.metadata?.custom?.messageAttachments).toEqual([imageAttachment]);
  });

  test("preserves authored attachment-like prose verbatim", () => {
    const authored = "📎 Attached: this sentence is mine";
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", `📎 Attached: screenshot.png\n\n${authored}`),
      metadata: { custom: optimisticImageMetadata(authored, imageAttachment.attachmentId) },
    };
    const result = reconcileCanonicalHumanMessage(
      [optimistic],
      { ...canonical, content: "internal expanded attachment text", attachments: [imageAttachment] },
      "taylor",
    );

    expect(result[0]?.content).toEqual([{ type: "text", text: authored }]);
  });

  test("keeps temporary status text for non-image and rejected attachments", () => {
    const audio = { ...imageAttachment, attachmentId: "audio", mimeType: "audio/mpeg" };
    const optimistic = (
      id: string,
      text: string,
      ...attachmentIds: string[]
    ): ThreadMessageLike => ({
      ...textMessage(id, text),
      metadata: { custom: optimisticImageMetadata("caption", ...attachmentIds) },
    });
    const audioResult = reconcileCanonicalHumanMessage(
      [optimistic("user-audio", "📎 Attached: note.mp3 (ok)\n\ncaption", audio.attachmentId)],
      { ...canonical, attachments: [audio] },
      "taylor",
    );
    const rejectedResult = reconcileCanonicalHumanMessage(
      [optimistic(
        "user-rejected",
        "📎 Attached: screenshot.png (rejected)\n\ncaption",
        imageAttachment.attachmentId,
      )],
      { ...canonical, attachments: [] },
      "taylor",
    );
    const mixedResult = reconcileCanonicalHumanMessage(
      [optimistic(
        "user-mixed",
        "📎 Attached: screenshot.png (ok), note.mp3 (ok)\n\ncaption",
        imageAttachment.attachmentId,
        audio.attachmentId,
      )],
      { ...canonical, attachments: [imageAttachment, audio] },
      "taylor",
    );

    expect(audioResult[0]?.content).toEqual([{
      type: "text", text: "📎 Attached: note.mp3 (ok)\n\ncaption",
    }]);
    expect(rejectedResult[0]?.content).toEqual([{
      type: "text", text: "📎 Attached: screenshot.png (rejected)\n\ncaption",
    }]);
    expect(mixedResult[0]?.content).toEqual([{
      type: "text", text: "📎 Attached: screenshot.png (ok), note.mp3 (ok)\n\ncaption",
    }]);
  });

  test("correlates simultaneous image sends by uploaded attachment id", () => {
    const secondImage = {
      ...imageAttachment,
      attachmentId: "attachment-second",
      filename: "second.png",
    };
    const first = {
      ...textMessage("user-first", "📎 Attached: screenshot.png\n\nsame caption"),
      metadata: { custom: optimisticImageMetadata("same caption", imageAttachment.attachmentId) },
    };
    const second = {
      ...textMessage("user-second", "📎 Attached: second.png\n\nsame caption"),
      metadata: { custom: optimisticImageMetadata("same caption", secondImage.attachmentId) },
    };

    const result = reconcileCanonicalHumanMessage(
      [first, second],
      { ...canonical, content: "same caption", attachments: [imageAttachment] },
      "taylor",
    );

    expect(result).toHaveLength(2);
    expect(result.map((message) => message.id)).toEqual(["42", "user-second"]);
    expect(result[0]?.content).toEqual([{ type: "text", text: "same caption" }]);
    expect(result[1]?.content).toEqual(second.content);
  });

  test("does not steal a newer text-only optimistic row for a delayed image event", () => {
    const image = {
      ...textMessage("user-image", "📎 Attached: screenshot.png\n\nimage caption"),
      metadata: { custom: optimisticImageMetadata("image caption", imageAttachment.attachmentId) },
    };
    const textOnly = {
      ...textMessage("user-text", "image caption"),
      metadata: { custom: { optimisticAuthoredText: "image caption" } },
    };

    const result = reconcileCanonicalHumanMessage(
      [image, textOnly],
      { ...canonical, content: "image caption", attachments: [imageAttachment] },
      "taylor",
    );

    expect(result.map((message) => message.id)).toEqual(["42", "user-text"]);
    expect(result[1]?.content).toEqual(textOnly.content);
  });

  test("does not let a stale image event replace newer edited text", () => {
    const edited: ThreadMessageLike = {
      ...textMessage("42", "newer edit"),
      metadata: {
        custom: {
          optimisticAuthoredText: "old caption",
          [OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY]: [imageAttachment.attachmentId],
          editRevision: 2,
        },
      },
    };
    const result = reconcileCanonicalHumanMessage(
      [edited],
      { ...canonical, content: "old caption", editRevision: 0, attachments: [imageAttachment] },
      "taylor",
    );

    expect(result[0]?.content).toEqual([{ type: "text", text: "newer edit" }]);
    expect(result[0]?.metadata?.custom?.messageAttachments).toEqual([imageAttachment]);
    expect(result[0]?.metadata?.custom?.editRevision).toBe(2);
  });

  test("patches a peer row when image descriptors arrive late without duplicating it", () => {
    const initial = reconcileCanonicalHumanMessage([], canonical, "alex");
    const patched = reconcileCanonicalHumanMessage(
      initial,
      { ...canonical, attachments: [imageAttachment] },
      "alex",
    );

    expect(patched).toHaveLength(1);
    expect(patched).not.toBe(initial);
    expect(patched[0]?.metadata?.custom?.messageAttachments).toEqual([imageAttachment]);
    expect(reconcileCanonicalHumanMessage(
      patched,
      { ...canonical, attachments: [imageAttachment] },
      "alex",
    )).toBe(patched);
  });

  test("preserves a reply pointer when replacing the matching optimistic bubble", () => {
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", "hello"),
      metadata: { custom: { replyToMessageId: 7 } },
    };
    const result = reconcileCanonicalHumanMessage(
      [optimistic],
      { ...canonical, replyToMessageId: 7 },
      "taylor",
    );
    expect(result[0]).toMatchObject({
      id: "42",
      metadata: { custom: { replyToMessageId: 7 } },
    });
  });

  test("reconciles optimistic whitespace normalized by the server", () => {
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", "hello\n"),
      metadata: { custom: { optimisticAuthoredText: "hello\n" } },
    };
    const result = reconcileCanonicalHumanMessage([optimistic], canonical, "taylor");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "42" });
  });

  test("replaces an attachment-shaped optimistic bubble using its authored text", () => {
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", "📎 Attached: brief.pdf\n\nhello"),
      metadata: { custom: { optimisticAuthoredText: "hello" } },
    };
    const result = reconcileCanonicalHumanMessage([optimistic], canonical, "taylor");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "42" });
  });

  test("appends peer delivery and treats a replayed canonical id as a no-op", () => {
    const first = reconcileCanonicalHumanMessage([textMessage("user-local", "hello")], canonical, "alex");
    expect(first.map((message) => message.id)).toEqual(["user-local", "42"]);
    expect(reconcileCanonicalHumanMessage(first, canonical, "alex")).toBe(first);
  });

  test("adds the reply pointer to a peer delivery", () => {
    const result = reconcileCanonicalHumanMessage(
      [],
      { ...canonical, replyToMessageId: 7 },
      "alex",
    );
    expect(result[0]).toMatchObject({
      metadata: { custom: { replyToMessageId: 7 } },
    });
  });

  test("repairs a canonical message when a replay supplies its reply pointer", () => {
    const existing = reconcileCanonicalHumanMessage([], canonical, "alex");
    const repaired = reconcileCanonicalHumanMessage(
      existing,
      { ...canonical, replyToMessageId: 7 },
      "alex",
    );
    expect(repaired).not.toBe(existing);
    expect(repaired[0]).toMatchObject({
      metadata: { custom: { replyToMessageId: 7 } },
    });
    expect(
      reconcileCanonicalHumanMessage(
        repaired,
        { ...canonical, replyToMessageId: 7 },
        "alex",
      ),
    ).toBe(repaired);
  });

  test("appends peer delivery with server-authored document pointers, deduped by room and artifact", () => {
    const result = reconcileCanonicalHumanMessage(
      [],
      { ...canonical, artifacts: [artifact, artifact] },
      "alex",
    );

    expect(result[0]).toMatchObject({
      metadata: { custom: { artifactOpenRefs: [artifact] } },
    });
  });

  test("patches an existing canonical id when only the document pointers arrived later", () => {
    const existing = reconcileCanonicalHumanMessage([], canonical, "alex");
    const patched = reconcileCanonicalHumanMessage(
      existing,
      { ...canonical, artifacts: [artifact] },
      "alex",
    );

    expect(patched).not.toBe(existing);
    expect(patched[0]).toMatchObject({
      id: "42",
      metadata: { custom: { artifactOpenRefs: [artifact] } },
    });
  });

  test("an event that omits document pointers preserves already-authorized metadata", () => {
    const withArtifacts = reconcileCanonicalHumanMessage(
      [],
      { ...canonical, artifacts: [artifact] },
      "alex",
    );

    const replayWithoutArtifacts = reconcileCanonicalHumanMessage(
      withArtifacts,
      canonical,
      "alex",
    );

    expect(replayWithoutArtifacts).toBe(withArtifacts);
    expect(replayWithoutArtifacts[0]).toMatchObject({
      metadata: { custom: { artifactOpenRefs: [artifact] } },
    });
  });

  test("does not clear an optimistic reply pointer when an older event omits it", () => {
    const optimistic: ThreadMessageLike = {
      ...textMessage("user-local", "hello"),
      metadata: { custom: { replyToMessageId: 7 } },
    };
    const result = reconcileCanonicalHumanMessage([optimistic], canonical, "taylor");
    expect(result[0]).toMatchObject({
      metadata: { custom: { replyToMessageId: 7 } },
    });
  });

  test("ignores a non-positive reply pointer", () => {
    const result = reconcileCanonicalHumanMessage(
      [],
      { ...canonical, replyToMessageId: 0 },
      "alex",
    );
    expect(result[0]).toMatchObject({ metadata: { custom: {} } });
  });
});
