import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY,
  reconcileCanonicalHumanMessage,
} from "../../src/adapters/message-new-reconciliation";
import {
  buildUserBubbleText,
  markMessageSendFailedInList,
  reconcileOptimisticMessageId,
  resolveBoundRoomIdForSend,
  updateMessageTextInList,
} from "../../src/adapters/nautilo-runtime";

type TestAttachment = Parameters<typeof buildUserBubbleText>[0]["queuedAttachments"][number];

function attachment(
  id: string,
  name: string,
  attachmentId = id,
): TestAttachment {
  return {
    id,
    name,
    attachmentId,
    status: "ready",
  } as TestAttachment;
}

function textMessage(
  id: string,
  text: string,
  metadata?: ThreadMessageLike["metadata"],
): ThreadMessageLike {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    ...(metadata ? { metadata } : {}),
  };
}

const repoRoot = join(import.meta.dir, "../../");
const runtimeSource = readFileSync(
  join(repoRoot, "src/adapters/nautilo-runtime.tsx"),
  "utf8",
);
const conversationSource = readFileSync(
  join(repoRoot, "src/components/conversation.tsx"),
  "utf8",
);

function sendTextBlock(): string {
  const start = runtimeSource.indexOf("const sendText = useCallback(");
  const end = runtimeSource.indexOf("const onNew = useCallback(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return runtimeSource.slice(start, end);
}

describe("optimistic outbound user message helpers", () => {
  test("plain text bubble preserves the authored text exactly", () => {
    expect(buildUserBubbleText({ text: "  hello  ", queuedAttachments: [] })).toBe("  hello  ");
  });

  test("attachment bubble uses local filenames before the server responds", () => {
    expect(
      buildUserBubbleText({
        text: "please read",
        queuedAttachments: [
          attachment("local-a", "file-a.txt", "att-a"),
          attachment("local-b", "file-b.png", "att-b"),
        ],
      }),
    ).toBe("📎 Attached: file-a.txt, file-b.png\n\nplease read");
  });

  test("attachment bubble updates to server-confirmed attachment decisions", () => {
    expect(
      buildUserBubbleText({
        text: "",
        queuedAttachments: [
          attachment("local-a", "file-a.txt", "att-a"),
          attachment("local-b", "file-b.png", "att-b"),
        ],
        attachmentStatuses: [
          { id: "att-a", decision: "accept" },
          { id: "att-b", decision: "blocked" },
        ],
      }),
    ).toBe("📎 Attached: file-a.txt (ok), file-b.png (blocked)");
  });

  test("response reconcile replaces a local user id with the persisted id", () => {
    const messages = [textMessage("user-local", "hello")];
    const next = reconcileOptimisticMessageId(messages, "user-local", "123");
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("123");
  });

  test("response reconcile removes a leftover optimistic bubble when message.new arrived first", () => {
    const messages = [
      textMessage("123", "hello"),
      textMessage("user-local", "hello"),
    ];
    const next = reconcileOptimisticMessageId(messages, "user-local", "123");
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("123");
  });

  test("legacy fallback leaves the local id until a later reconcile event", () => {
    const messages = [textMessage("user-local", "hello")];
    const unchanged = reconcileOptimisticMessageId(messages, "missing-local", "123");
    expect(unchanged).toBe(messages);
    expect(messages[0]?.id).toBe("user-local");
  });

  test("success path can update the same optimistic bubble text without duplicating it", () => {
    const messages = [textMessage("user-local", "📎 Attached: file-a.txt")];
    const next = updateMessageTextInList(
      messages,
      "user-local",
      "📎 Attached: file-a.txt (ok)",
    );
    expect(next).toHaveLength(1);
    expect((next[0]?.content[0] as { text?: string } | undefined)?.text).toBe(
      "📎 Attached: file-a.txt (ok)",
    );
  });

  test("send failure marks the same user bubble failed and preserves existing custom metadata", () => {
    const messages = [
      textMessage("user-local", "hello", {
        custom: { replyToMessageId: 42 },
      }),
    ];
    const next = markMessageSendFailedInList(messages, "user-local", "network down");
    expect(next).toHaveLength(1);
    expect(next[0]?.metadata).toEqual({
      custom: {
        replyToMessageId: 42,
        sendFailed: true,
        sendFailureReason: "network down",
      },
    });
  });
});

describe("attachment outcomes after live delivery", () => {
  const image = {
    attachmentId: "image-id", filename: "screen.png", mimeType: "image/png", sizeBytes: 42,
  };
  const queuedAttachments = [
    attachment("local-image", image.filename, image.attachmentId),
    attachment("local-file", "notes.txt", "file-id"),
  ];
  const attachmentIds = [image.attachmentId, "file-id"];
  const optimistic = () => textMessage(
    "user-local",
    buildUserBubbleText({ text: "caption", queuedAttachments }),
    { custom: {
      optimisticAuthoredText: "caption",
      [OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY]: attachmentIds,
    } },
  );
  const event = {
    messageId: "42", sourceUserId: "sender", content: "expanded server content",
    editRevision: 0, attachments: [image],
  };

  test.each(["reject", "accept"] as const)(
    "WS-first preserves the HTTP %s outcome for a non-retained file beside an image",
    (decision) => {
      const unrelated = textMessage("user-other", "same caption", { custom: {
        optimisticAuthoredText: "caption",
        [OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY]: ["other-image", "other-file"],
      } });
      const live = reconcileCanonicalHumanMessage([optimistic(), unrelated], event, "sender");
      expect(live[0]?.id).toBe("42");
      const outcome = buildUserBubbleText({
        text: "caption", queuedAttachments,
        attachmentStatuses: [
          { id: image.attachmentId, filename: image.filename, decision: "accept" },
          { id: "file-id", filename: "notes.txt", decision },
        ],
      });
      const updated = updateMessageTextInList(live, "user-local", outcome, attachmentIds);
      const result = reconcileOptimisticMessageId(updated, "user-local", "42");
      expect(result).toHaveLength(2);
      expect(result[0]?.content).toEqual([{ type: "text", text:
        `📎 Attached: screen.png (ok), notes.txt (${decision === "reject" ? "rejected" : "ok"})\n\ncaption`,
      }]);
      expect(result[0]?.metadata?.custom?.messageAttachments).toEqual([image]);
      expect(result[1]).toBe(unrelated);
      expect(reconcileCanonicalHumanMessage(result, event, "sender")[0]?.content)
        .toEqual(result[0]?.content);
    },
  );

  test("HTTP-first mixed outcomes survive the later live projection", () => {
    const outcome = "📎 Attached: screen.png (ok), notes.txt (rejected)\n\ncaption";
    const updated = updateMessageTextInList([optimistic()], "user-local", outcome, attachmentIds);
    const rekeyed = reconcileOptimisticMessageId(updated, "user-local", "42");
    const result = reconcileCanonicalHumanMessage(rekeyed, event, "sender");
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toEqual([{ type: "text", text: outcome }]);
    expect(result[0]?.metadata?.custom?.messageAttachments).toEqual([image]);
  });

  test("late HTTP outcomes do not restore filenames after an image preview settles", () => {
    const local = textMessage("user-local", "📎 Attached: screen.png\n\ncaption", { custom: {
      optimisticAuthoredText: "caption",
      [OPTIMISTIC_ATTACHMENT_IDS_METADATA_KEY]: [image.attachmentId],
    } });
    const live = reconcileCanonicalHumanMessage([local], event, "sender");
    expect(live[0]?.content).toEqual([{ type: "text", text: "caption" }]);
    expect(updateMessageTextInList(live, "user-local", "📎 Attached: screen.png (ok)", [image.attachmentId]))
      .toBe(live);
  });

  test("late HTTP outcomes cannot overwrite edits or protected projections", () => {
    const live = reconcileCanonicalHumanMessage([optimistic()], event, "sender");
    for (const guard of [
      { editRevision: 1 }, { humanMessageVerification: "pending" }, { historyUnavailable: true },
    ]) {
      const guarded = [{ ...live[0]!, metadata: { custom: {
        ...live[0]?.metadata?.custom, ...guard,
      } } }];
      expect(updateMessageTextInList(guarded, "user-local", "late summary", attachmentIds))
        .toBe(guarded);
    }
  });

  test("late HTTP outcomes do not target another upload set or repopulate a cleared room", () => {
    const live = reconcileCanonicalHumanMessage([optimistic()], event, "sender");
    expect(updateMessageTextInList(live, "user-local", "wrong summary", [image.attachmentId]))
      .toBe(live);
    const empty: ThreadMessageLike[] = [];
    expect(updateMessageTextInList(empty, "user-local", "late summary", attachmentIds)).toBe(empty);
  });
});

describe("sendText optimistic ordering (source contract)", () => {
  test("room sends are rejected until the visible transcript is bound to the active room", () => {
    const block = sendTextBlock();
    const bindingGuard = block.indexOf("resolveBoundRoomIdForSend(");
    const optimisticAdd = block.indexOf("id: optimisticId");
    expect(bindingGuard).toBeGreaterThanOrEqual(0);
    expect(bindingGuard).toBeLessThan(optimisticAdd);
  });

  test("DM/group room sends add the user bubble before awaiting sendRoomMessage", () => {
    const block = sendTextBlock();
    const optimisticAdd = block.indexOf("id: optimisticId");
    const roomAwait = block.indexOf("await roomMessageOperations.sendRoomMessage");
    expect(optimisticAdd).toBeGreaterThanOrEqual(0);
    expect(roomAwait).toBeGreaterThan(optimisticAdd);
  });

  test("legacy /api/chat sends also add the user bubble before awaiting sendMessage", () => {
    const block = sendTextBlock();
    const optimisticAdd = block.indexOf("id: optimisticId");
    const legacyAwait = block.indexOf("await apiClient.sendMessage");
    expect(legacyAwait).toBeGreaterThan(optimisticAdd);
  });

  test("attachments clear only after the optimistic bubble is visible", () => {
    const block = sendTextBlock();
    const optimisticAdd = block.indexOf("id: optimisticId");
    const clear = block.indexOf("clearAttachments();", optimisticAdd);
    const roomAwait = block.indexOf("await roomMessageOperations.sendRoomMessage");
    expect(clear).toBeGreaterThan(optimisticAdd);
    expect(clear).toBeLessThan(roomAwait);
  });

  test("composer cleanup callback fires after the optimistic bubble but before network I/O", () => {
    const block = sendTextBlock();
    const optimisticAdd = block.indexOf("id: optimisticId");
    const callback = block.indexOf("options?.onOptimisticUserMessage?.()", optimisticAdd);
    const roomAwait = block.indexOf("await roomMessageOperations.sendRoomMessage");
    expect(callback).toBeGreaterThan(optimisticAdd);
    expect(callback).toBeLessThan(roomAwait);
  });

  test("thinking indicator is not set before the send response resolves", () => {
    const block = sendTextBlock();
    const optimisticAdd = block.indexOf("id: optimisticId");
    const roomAwait = block.indexOf("await roomMessageOperations.sendRoomMessage");
    const preAwait = block.slice(optimisticAdd, roomAwait);
    expect(preAwait).not.toMatch(/setIsRunning\(true\)/);
  });

  test("success path reconciles the optimistic id instead of appending a second user bubble", () => {
    const block = sendTextBlock();
    const postAwait = block.slice(block.indexOf("const rid = roomIdForSend;"));
    expect(postAwait).toMatch(/reconcileMessageId\(optimisticId, String\(pending\.userMessageId\)\)/);
    expect(postAwait).not.toMatch(/addMessage\(\{[^}]*\brole:\s*"user"/);
  });

  test("message.new delegates optimistic reconciliation to the shared helper", () => {
    expect(runtimeSource).toMatch(
      /import \{[^}]*\breconcileCanonicalHumanMessage\b[^}]*\} from "\.\/message-new-reconciliation"/,
    );
    expect(runtimeSource).toMatch(/reconcileCanonicalHumanMessage\(/);
  });

  test("ordinary send failures mark the user bubble instead of adding an assistant error", () => {
    const block = sendTextBlock();
    const catchBlock = block.slice(block.lastIndexOf("} catch (err) {"));
    expect(catchBlock).toMatch(/markMessageSendFailed\(/);
    expect(catchBlock).not.toMatch(/role: "assistant"/);
  });
});

describe("room-bound send admission", () => {
  test("admits only the room whose transcript finished hydrating", () => {
    expect(resolveBoundRoomIdForSend("room-b", "room-b", "room-b")).toBe("room-b");
    expect(resolveBoundRoomIdForSend("room-b", "room-a", "room-b")).toBeUndefined();
    expect(resolveBoundRoomIdForSend("room-b", undefined, "room-b")).toBeUndefined();
  });

  test("route identity can bridge a briefly unresolved navigation selection", () => {
    expect(resolveBoundRoomIdForSend(null, "room-b", "room-b")).toBe("room-b");
    expect(resolveBoundRoomIdForSend(null, "room-a", "room-b")).toBeUndefined();
  });

  test("preserves the legacy non-room chat path", () => {
    expect(resolveBoundRoomIdForSend(null, null, null)).toBeNull();
  });
});

describe("conversation failed-send rendering (source contract)", () => {
  test("composer clears via the optimistic-send callback, not only after server confirmation", () => {
    expect(conversationSource).toMatch(/onOptimisticUserMessage: cleanupComposer/);
    expect(conversationSource).toMatch(
      /if \(sent\) \{\s*if \(!composerCleaned\) cleanupComposer\(\);/,
    );
  });

  test("user messages read metadata.custom.sendFailed and render the failure caption", () => {
    expect(conversationSource).toMatch(/sendFailed/);
    expect(conversationSource).toMatch(/sendFailureReason/);
    expect(conversationSource).toContain("Didn't get through");
  });

  test("failed user bubbles do not render the reaction strip branch", () => {
    expect(conversationSource).toMatch(/sendFailed \? \([\s\S]*Didn't get through[\s\S]*\) : \([\s\S]*<ReactionStrip/);
  });
});
