import { expect, test } from "bun:test";
import { isCurrentMessageAttachmentSelection, isRetainedAttachment, sameMessageAttachmentScope, type MessageAttachmentScope } from "./message-attachment-source";

const scope: MessageAttachmentScope = { serverId: "s", serverUrl: "https://s.test", accountId: "u", roomId: "r", messageId: "m", attachmentId: "a", generation: 1 };

test("attachment scope includes every authority and operation dimension", () => {
  expect(sameMessageAttachmentScope(scope, { ...scope })).toBe(true);
  for (const changed of [{ serverId: "x" }, { serverUrl: "https://x.test" }, { accountId: "x" }, { roomId: "x" }, { messageId: "x" }, { attachmentId: "x" }, { generation: 2 }]) {
    expect(sameMessageAttachmentScope(scope, { ...scope, ...changed })).toBe(false);
  }
});

test("a selected retained ref is current only while its canonical message still carries it", () => {
  const attachment = { kind: "retained" as const, attachmentId: "a", filename: "a.png", mimeType: "image/png", sizeBytes: 2, uri: "https://s/a" };
  const selected = { messageId: "m", attachmentId: "a" };
  expect(isCurrentMessageAttachmentSelection([{ kind: "message", id: "m", attachments: [attachment] }], selected)).toBe(true);
  expect(isCurrentMessageAttachmentSelection([], selected)).toBe(false);
  expect(isCurrentMessageAttachmentSelection([{ kind: "message", id: "m", attachments: [] }], selected)).toBe(false);
  expect(isCurrentMessageAttachmentSelection([{ kind: "message", id: "other", attachments: [attachment] }], selected)).toBe(false);
});

test("every canonical retained ref qualifies while optimistic local previews remain inert", () => {
  for (const mimeType of ["image/png", "video/mp4", "application/pdf", "application/octet-stream"]) {
    const retained = { kind: "retained" as const, attachmentId: "a", filename: "file.bin", mimeType, sizeBytes: 2, uri: "https://s/a" };
    expect(isRetainedAttachment(retained)).toBe(true);
  }
  expect(isRetainedAttachment({ kind: "local", uri: "file:///draft.png" })).toBe(false);
});
