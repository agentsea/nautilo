import { describe, expect, test } from "bun:test";
import type { MindSwapperChatModel } from "@nautilo/agent";
import { assertChatAttachmentImageSupport, ImageAttachmentModelError, pendingChatAttachmentsAreImages } from "../../src/messaging/attachments";
import { resolveCallerImageInput } from "../../src/lib/image-assistance";
import type { ModelFundingDecision, resolveModelFunding } from "../../src/lib/model-funding";
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
  test("uses the admitted MindSwapper key's image and tools offer without an ambient catalogue", async () => {
    const model: MindSwapperChatModel = {
      id: "mindswapper:maker/model",
      displayName: "Model",
      offers: [{ inputModalities: ["text", "image"], supportedParameters: ["tools"], maxInputTokens: 2000, maxOutputTokens: 1000 }],
    };
    const humanUserId = "synthetic-human";
    const funding: ModelFundingDecision = { kind: "personal", humanUserId, payerHumanId: humanUserId,
      modelId: model.id, workload: "foreground_text_chat", providerRoute: "mindswapper",
      credentialId: "synthetic-credential", credentialRevision: 1 };
    const resolveImage: typeof resolveCallerImageInput = (input) => resolveCallerImageInput(input, {
      readMindSwapperModel: async (admitted, tools) => {
        expect(admitted).toBe(funding);
        expect(tools).toBe(true);
        return model;
      },
    });
    await assertChatAttachmentImageSupport({ ...args, models: [{ id: model.id, funding }], humanUserId },
      lookup("image/png", []), resolveImage, async () => {
        throw new Error("must use the admitted funding decision");
      });
    await assertChatAttachmentImageSupport({ ...args, models: [{ id: model.id }], humanUserId },
      lookup("image/png", []), resolveImage, async (request) => {
        expect(request.mindSwapperTools).toBe(true);
        return funding;
      });
  });

  test("accepts a caller-authorized auxiliary route while retaining native capability", async () => {
    const calls: unknown[] = [];
    const funding: typeof resolveModelFunding = async (input) => ({
      kind: "personal", humanUserId: input.humanUserId, payerHumanId: input.humanUserId,
      modelId: input.modelId, workload: input.workload, providerRoute: "fireworks",
      credentialId: "synthetic-credential", credentialRevision: 1,
    });
    await assertChatAttachmentImageSupport({ ...args, models: [textModel], humanUserId: "synthetic-human",
      fundingKind: "personal" }, lookup("image/png", calls), async () => "assisted", funding);
    expect(calls).toHaveLength(1);
  });

  test("a revoked auxiliary rejects before normalization with original upload retained", async () => {
    const calls: unknown[] = [];
    const funding: typeof resolveModelFunding = async (input) => ({
      kind: "server", humanUserId: input.humanUserId, modelId: input.modelId,
      workload: input.workload, providerRoute: "fireworks",
    });
    const error = await assertChatAttachmentImageSupport({ ...args, models: [textModel], humanUserId: "synthetic-human" },
      lookup("image/png", calls), async () => "unavailable", funding).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(ImageAttachmentModelError);
    expect(calls).toEqual([{ attachmentId: "upload", uploaderActorId: "sender", namespaceId: "room-namespace" }]);
  });

  test("the narrow personal-image exception excludes foreign, missing, and nonimage uploads", async () => {
    expect(await pendingChatAttachmentsAreImages(args, lookup("image/png", []))).toBe(true);
    for (const mime of [null, "text/plain", "audio/wav"]) {
      expect(await pendingChatAttachmentsAreImages(args, lookup(mime, []))).toBe(false);
    }
    expect(await pendingChatAttachmentsAreImages({ ...args, writableNamespaceId: null }, lookup("image/png", []))).toBe(false);
  });
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
