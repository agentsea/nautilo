import { describe, expect, test } from "bun:test";
import { assertChatAttachmentImageSupport, ImageAttachmentModelError } from "../../src/messaging/attachments";
import type { findPendingMessageAttachmentForSender } from "@nautilo/db";

const textModel = { id: "fireworks:accounts/fireworks/models/glm-5p3", label: "GLM 5.3" };
const visionModel = { id: "anthropic:claude-sonnet-4-6" };
const args = { attachmentIds: ["upload"], uploaderActorId: "sender", writableNamespaceId: "room-namespace" };
function lookup(mimeType: string | null, calls: unknown[]) {
  return (async (input) => {
    calls.push(input);
    return mimeType ? { mimeType } : null;
  }) as typeof findPendingMessageAttachmentForSender;
}

describe("new image admission", () => {
  test("rejects a sender-scoped image for a text-only model with both recovery options", async () => {
    const calls: unknown[] = [];
    const error: unknown = await assertChatAttachmentImageSupport({ ...args, models: [textModel] }, lookup("image/png", calls))
      .then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(ImageAttachmentModelError);
    expect((error as Error).message).toBe("GLM 5.3 can’t read the images attached to this message. Remove them or choose a model that supports images.");
    expect(calls).toEqual([{ attachmentId: "upload", uploaderActorId: "sender", namespaceId: "room-namespace" }]);
  });
  test.each(["fireworks:accounts/fireworks/models/minimax-m2p7", "openrouter:z-ai/glm-5.3", "venice:z-ai-glm-5-3"])("catalog capability rejects images for %s", async (id) => {
    let rejected = false;
    try { await assertChatAttachmentImageSupport({ ...args, models: [{ id }] }, lookup("image/png", [])); }
    catch (error) { rejected = error instanceof ImageAttachmentModelError; }
    expect(rejected).toBe(true);
  });
  test("allows nonimage uploads for a text-only model", async () => {
    for (const mime of ["text/plain", "audio/wav"]) {
      await assertChatAttachmentImageSupport({ ...args, models: [textModel] }, lookup(mime, []));
    }
  });
  test("allows vision models and human-only sharing without lookup", async () => {
    const calls: unknown[] = [];
    for (const models of [[visionModel], []]) {
      await assertChatAttachmentImageSupport({ ...args, models }, lookup("image/png", calls));
    }
    expect(calls).toEqual([]);
  });
  test("unavailable/foreign uploads remain unavailable to capability checks", async () => {
    await assertChatAttachmentImageSupport({ ...args, models: [textModel] }, lookup(null, []));
  });
  test("checks every potential group responder", async () => {
    const error: unknown = await assertChatAttachmentImageSupport({ ...args, models: [visionModel, textModel] }, lookup("image/png", []))
      .then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(ImageAttachmentModelError);
    expect((error as Error).message).toContain("GLM 5.3");
  });
  test("historical images do not enter new-upload admission", async () => {
    const calls: unknown[] = [];
    await assertChatAttachmentImageSupport({ ...args, attachmentIds: [], models: [textModel] }, lookup("image/png", calls));
    expect(calls).toEqual([]);
  });
});
