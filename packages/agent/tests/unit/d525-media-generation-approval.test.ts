import { afterEach, describe, expect, test } from "bun:test";
import { isMediaGenerationApproval, isMediaGenerationPreparedApproval } from "@nautilo/types";
import {
  createMediaGenerationPreparedApproval,
  mediaGenerationApprovalFromPrepared,
  prepareMediaGenerationApproval,
  resetMediaGenerationApprovalRuntimeForTests,
  setMediaGenerationApprovalRuntime,
  submitMediaGenerationApproval,
  verifyMediaGenerationPreparedApproval,
} from "../../src/tools/media/media-generation-approval-runtime";
import { interruptValueToServerEvent } from "../../src/graph/interrupt-mapping";
import {
  interruptToolEntry,
  matchesMediaGenerationResumeBinding,
} from "../../src/nodes/post-model";
import type { NautiloState } from "../../src/agent/state";

const actor = { userId: "user-1", roomId: "room-1", agentId: "agent-1" } as const;
const facts = {
  toolName: "generate_video",
  approvalId: "approval-1",
  threadId: "thread-1",
  turnId: "turn-1",
  laneKey: "lane-1",
  toolCallId: "call-1",
} as const;
const intent = {
  model: "seedance-2-5-text-to-video-basic",
  prompt: `Ocean at dusk https://provider.example/queue/secret ${"x".repeat(200)}`,
  durationSeconds: 5,
  aspectRatio: "16:9",
  resolution: "720p",
  audio: true,
} as const;

afterEach(() => resetMediaGenerationApprovalRuntimeForTests());

describe("D525 prepared paid media approval", () => {
  test("returns an actionable no-spend failure when the server has no media runtime", async () => {
    const valid = await prepareMediaGenerationApproval({ actor, intent, ...facts });
    expect(valid).toEqual({
      ok: false,
      code: "quote_unavailable",
      recovery: "Configure Venice for media generation, then request a fresh quote. No generation was started.",
    });
    expect(valid).not.toHaveProperty("prepared");
    expect(valid).not.toHaveProperty("receiptId");
    expect(JSON.stringify(valid)).not.toContain("provider");

    const invalid = await prepareMediaGenerationApproval({
      actor,
      intent: { ...intent, durationSeconds: -1 },
      ...facts,
      approvalId: "approval-invalid",
    });
    expect(invalid).toMatchObject({ ok: false, code: "request_invalid" });

    let prepares = 0;
    setMediaGenerationApprovalRuntime({
      async prepare(ctx, preparation) {
        prepares += 1;
        return {
          ok: true,
          prepared: createMediaGenerationPreparedApproval({
            actor: ctx,
            preparation,
            receiptId: "mg_1234567890abcdef",
            quoteUsdMicros: 100_000,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        };
      },
      async submit() {
        throw new Error("not used");
      },
    });
    expect((await prepareMediaGenerationApproval({ actor, intent, ...facts })).ok).toBe(true);
    expect(prepares).toBe(1);
  });

  test("explains incompatible model settings before quote or spend", async () => {
    let prepares = 0;
    setMediaGenerationApprovalRuntime({
      async prepare() {
        prepares += 1;
        throw new Error("must not quote an invalid request");
      },
      async submit() { throw new Error("must not submit an invalid request"); },
    });
    const result = await prepareMediaGenerationApproval({
      actor,
      intent: {
        model: "minimax-music-v26",
        prompt: "Warm analog pulse with a gentle rise",
        durationSeconds: 10,
        lyrics: "",
        forceInstrumental: true,
      },
      toolName: "generate_music",
      approvalId: "approval-invalid-music",
      threadId: "thread-1",
      turnId: "turn-1",
      laneKey: "lane-1",
      toolCallId: "call-invalid-music",
    });
    expect(result).toEqual({
      ok: false,
      code: "request_invalid",
      recovery: "MiniMax Music does not accept a requested duration. Remove durationSeconds or choose Sonilo to preserve the duration. No generation was started.",
    });
    expect(prepares).toBe(0);
  });

  test("routes an explicit ordinary video action to exact quote preparation without submitting", async () => {
    let preparedRequest: unknown;
    let submits = 0;
    setMediaGenerationApprovalRuntime({
      async prepare(ctx, preparation) {
        preparedRequest = preparation.request;
        return {
          ok: true,
          prepared: createMediaGenerationPreparedApproval({
            actor: ctx,
            preparation,
            receiptId: "mg_1234567890abcdef",
            quoteUsdMicros: 250_000,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        };
      },
      async submit() {
        submits += 1;
        throw new Error("quote preparation must not submit");
      },
    });
    const result = await prepareMediaGenerationApproval({
      actor,
      intent: {
        action: "generate",
        model: "seedance-2-5-text-to-video-basic",
        prompt: "A kitten playing in soft daylight",
        durationSeconds: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        audio: false,
        filename: "kitten.mp4",
        referenceImages: [],
        referenceVideos: [],
      },
      ...facts,
      approvalId: "approval-generate-video",
    });
    expect(result.ok).toBe(true);
    expect(preparedRequest).toEqual({
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A kitten playing in soft daylight",
      durationSeconds: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: false,
      filename: "kitten.mp4",
    });
    expect(submits).toBe(0);
  });

  test("normalizes, quotes once across replay, and exposes only a bounded safe preview", async () => {
    let prepares = 0;
    setMediaGenerationApprovalRuntime({
      async prepare(ctx, input) {
        prepares++;
        return {
          ok: true,
          prepared: createMediaGenerationPreparedApproval({
            actor: ctx,
            preparation: input,
            receiptId: "mg_1234567890abcdef",
            quoteUsdMicros: 1_250_000,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        };
      },
      async submit() {
        throw new Error("not used");
      },
    });
    const input = { actor, intent, ...facts };
    const [first, replay] = await Promise.all([
      prepareMediaGenerationApproval(input),
      prepareMediaGenerationApproval(input),
    ]);
    expect(prepares).toBe(1);
    expect(first).toEqual(replay);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const approval = mediaGenerationApprovalFromPrepared(first.prepared);
    expect(approval.preview.quote).toEqual({
      currency: "USD", amountMicros: 1_250_000, display: "USD 1.250000",
    });
    expect(approval.preview.prompt.summary).not.toContain("provider.example");
    expect(approval.preview.prompt.summary.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(approval)).not.toContain("queue/secret");
    expect(JSON.stringify(approval)).not.toContain("mg_1234567890abcdef");
    expect(JSON.stringify(approval)).not.toContain(facts.threadId);
  });

  test.each([512, 513, 4096])("Human and Genie reference paths of %i characters survive review and checkpoint replay", async (length) => {
    const imagePath = "refs/" + "a".repeat(length - 9) + ".png";
    const videoPath = imagePath.replace(/png$/, "mp4");
    const audioPath = imagePath.replace(/png$/, "wav");
    const referenceIntent = { ...intent, model: "seedance-2-5-reference-to-video-basic" as const,
      durationSeconds: 4, resolution: "480p" as const, audio: false,
      referenceImages: [{ path: imagePath }],
      referenceVideos: [{ path: videoPath }],
      referenceAudios: [{ path: audioPath }],
    };
    let prepares = 0;
    let submits = 0;
    setMediaGenerationApprovalRuntime({
      async prepare(ctx, input) {
        prepares++;
        expect(input.request).toEqual(referenceIntent);
        expect(() => createMediaGenerationPreparedApproval({ actor: ctx, preparation: input,
          receiptId: "mg_1234567890abcdef", quoteUsdMicros: 100_000, expiresAt: "2099-01-01T00:00:00.000Z" })).toThrow();
        const bound = { artifactId: "image-public", artifactInternalId: "11111111-1111-4111-8111-111111111111",
          revision: 1, sizeBytes: 100, sha256: "a".repeat(64) };
        return { ok: true, prepared: createMediaGenerationPreparedApproval({ actor: ctx,
          preparation: { ...input, request: { ...referenceIntent,
            referenceImages: [{ ...bound, path: imagePath, mimeType: "image/png" }],
            referenceVideos: [{ ...bound, artifactId: "video-public", path: videoPath, mimeType: "video/mp4", durationSeconds: 4 }],
            referenceAudios: [{ ...bound, artifactId: "audio-public", path: audioPath, mimeType: "audio/wav", durationSeconds: 3 }],
          } }, receiptId: "mg_1234567890abcdef", quoteUsdMicros: 100_000, expiresAt: "2099-01-01T00:00:00.000Z" }) };
      },
      async submit() { submits++; throw new Error("No approval was given"); },
    });
    const result = await prepareMediaGenerationApproval({ actor, intent: referenceIntent, approvalId: "video:references",
      origin: { kind: "video_app", projectArtifactId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222" } });
    expect(result.ok).toBe(true);
    expect(prepares).toBe(1);
    expect(submits).toBe(0);
    if (result.ok) {
      expect(result.prepared.preview.settings).toMatchObject({ durationSeconds: 4, resolution: "480p", audio: false });
      expect(result.prepared.preview.referenceImages?.[0]?.content).toEqual({ sha256: "a".repeat(64), sizeBytes: 100, mimeType: "image/png" });
      expect(result.prepared.preview.referenceVideos?.[0]?.content).toEqual({ sha256: "a".repeat(64), sizeBytes: 100, mimeType: "video/mp4" });
      expect(result.prepared.preview.referenceAudios?.[0]?.content).toEqual({ sha256: "a".repeat(64), sizeBytes: 100, mimeType: "audio/wav" });
      expect(result.prepared.preview.settings).toMatchObject({ referenceAudios: 1, referenceAudioSeconds: 3 });
      expect(isMediaGenerationApproval(mediaGenerationApprovalFromPrepared(result.prepared))).toBe(true);
      expect(isMediaGenerationPreparedApproval(JSON.parse(JSON.stringify(result.prepared)))).toBe(true);
    }
    const genie = await prepareMediaGenerationApproval({ actor, intent: referenceIntent, ...facts });
    expect(genie.ok).toBe(true);
    if (!genie.ok) throw new Error("Genie review failed");
    expect(isMediaGenerationApproval(mediaGenerationApprovalFromPrepared(genie.prepared))).toBe(true);
    const restored: unknown = JSON.parse(JSON.stringify(genie.prepared));
    expect(isMediaGenerationPreparedApproval(restored)).toBe(true);
    expect(restored).toMatchObject({ request: { referenceImages: [{ path: imagePath }], referenceVideos: [{ path: videoPath }], referenceAudios: [{ path: audioPath }] } });
    expect(verifyMediaGenerationPreparedApproval(restored, { ...actor, ...facts,
      digest: genie.prepared.binding.approvalDigest, quoteDigest: genie.prepared.binding.quoteDigest,
      receiptId: genie.prepared.binding.receiptId, revision: 1, now: new Date("2098-01-01T00:00:00.000Z") })).toBe(true);
    expect(submits).toBe(0);
  });

  test("fails closed on scope, revision, expiry, request, and quote mismatch", () => {
    const prepared = createMediaGenerationPreparedApproval({
      actor,
      preparation: {
        ...facts,
        request: { ...intent, prompt: "Ocean at dusk" },
      },
      receiptId: "mg_1234567890abcdef",
      quoteUsdMicros: 1_250_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const expected = {
      ...actor,
      ...facts,
      digest: prepared.binding.approvalDigest,
      quoteDigest: prepared.binding.quoteDigest,
      receiptId: prepared.binding.receiptId,
      revision: 1,
      now: new Date("2098-01-01T00:00:00.000Z"),
    };
    expect(verifyMediaGenerationPreparedApproval(prepared, expected)).toBe(true);
    expect(verifyMediaGenerationPreparedApproval(prepared, { ...expected, roomId: "other-room" })).toBe(false);
    expect(verifyMediaGenerationPreparedApproval(prepared, { ...expected, revision: 2 })).toBe(false);
    expect(verifyMediaGenerationPreparedApproval(prepared, { ...expected, now: new Date("2100-01-01T00:00:00.000Z") })).toBe(false);
    expect(verifyMediaGenerationPreparedApproval({ ...prepared, quoteUsdMicros: 2_000_000 }, expected)).toBe(false);
    expect(verifyMediaGenerationPreparedApproval({ ...prepared, request: { ...prepared.request, prompt: "changed" } }, expected)).toBe(false);
    expect(verifyMediaGenerationPreparedApproval(prepared, { ...expected, receiptId: "mg_abcdefghijklmnop" })).toBe(false);
  });

  test("binds a first-party Video request without inventing a Genie turn", () => {
    const origin = {
      kind: "video_app" as const,
      projectArtifactId: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222",
    };
    const prepared = createMediaGenerationPreparedApproval({
      actor,
      preparation: { request: { ...intent, prompt: "Ocean at dusk" }, approvalId: "video:22222222-2222-4222-8222-222222222222", origin },
      receiptId: "mg_1234567890abcdef",
      quoteUsdMicros: 750_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(prepared.binding.origin).toEqual(origin);
    expect(prepared.binding.threadId).toBeUndefined();
    expect(verifyMediaGenerationPreparedApproval(prepared, {
      ...actor, origin, approvalId: prepared.binding.approvalId, receiptId: prepared.binding.receiptId,
      digest: prepared.binding.approvalDigest, quoteDigest: prepared.binding.quoteDigest, revision: 1,
      now: new Date("2098-01-01T00:00:00.000Z"),
    })).toBe(true);
  });

  test("submits the reserved local receipt and rejects changed or separately minted receipts", async () => {
    const prepared = createMediaGenerationPreparedApproval({
      actor,
      preparation: { ...facts, request: { ...intent, prompt: "Ocean at dusk" } },
      receiptId: "mg_1234567890abcdef",
      quoteUsdMicros: 750_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const receiptIds: string[] = [];
    setMediaGenerationApprovalRuntime({
      async prepare() { throw new Error("not used"); },
      async submit(_ctx, input) {
        receiptIds.push(input.receiptId);
        return {
          kind: "generated_media",
          version: 1,
          receiptId: input.receiptId,
          queueStarted: true,
          mediaKind: "video",
          state: "queued",
          model: prepared.request.model,
          promptSummary: prepared.preview.prompt.summary,
          settings: prepared.preview.settings,
          recoveryActions: [],
        };
      },
    });
    const submit = {
      prepared,
      approvalId: facts.approvalId,
      receiptId: prepared.binding.receiptId,
      digest: prepared.binding.approvalDigest,
      quoteDigest: prepared.binding.quoteDigest,
      revision: prepared.binding.revision,
      toolCallId: facts.toolCallId,
    };
    expect((await submitMediaGenerationApproval(actor, submit)).queueStarted).toBe(true);
    expect((await submitMediaGenerationApproval(actor, submit)).queueStarted).toBe(true);
    expect(receiptIds).toEqual([prepared.binding.receiptId, prepared.binding.receiptId]);
    expect((await submitMediaGenerationApproval(actor, {
      ...submit,
      receiptId: "mg_abcdefghijklmnop",
    })).queueStarted).toBe(false);
    expect(receiptIds).toHaveLength(2);

    setMediaGenerationApprovalRuntime({
      async prepare() { throw new Error("not used"); },
      async submit() {
        return {
          kind: "generated_media",
          version: 1,
          receiptId: "mg_separatelyminted1",
          queueStarted: true,
          mediaKind: "video",
          state: "queued",
          model: prepared.request.model,
          promptSummary: prepared.preview.prompt.summary,
          settings: prepared.preview.settings,
          recoveryActions: [],
        };
      },
    });
    const mismatch = await submitMediaGenerationApproval(actor, submit);
    expect(mismatch).toMatchObject({
      kind: "generated_media",
      queueStarted: null,
      state: "unknown",
      failure: { code: "SUBMISSION_RESULT_INVALID" },
    });

    setMediaGenerationApprovalRuntime({
      async prepare() { throw new Error("not used"); },
      async submit() {
        return {
          kind: "generated_media",
          version: 1,
          receiptId: prepared.binding.receiptId,
          queueStarted: null,
          mediaKind: "video",
          state: "unknown",
          model: prepared.preview.model,
          promptSummary: prepared.preview.prompt.summary,
          settings: prepared.preview.settings,
          failure: {
            code: "ADMISSION_UNKNOWN",
            message: "Check status before starting another generation.",
          },
          recoveryActions: [],
        };
      },
    });
    expect(await submitMediaGenerationApproval(actor, submit)).toMatchObject({
      receiptId: prepared.binding.receiptId,
      queueStarted: null,
      state: "unknown",
    });

    setMediaGenerationApprovalRuntime({
      async prepare() { throw new Error("not used"); },
      async submit() {
        return {
          kind: "generated_media",
          version: 1,
          queueStarted: false,
          mediaKind: "video",
          state: "needs-action",
          model: prepared.preview.model,
          promptSummary: prepared.preview.prompt.summary,
          settings: prepared.preview.settings,
          failure: { code: "CONTENT_POLICY", message: "Revise the request before trying again." },
          recoveryActions: [],
        };
      },
    });
    expect(await submitMediaGenerationApproval(actor, submit)).toMatchObject({
      receiptId: prepared.binding.receiptId,
      queueStarted: null,
      failure: { code: "SUBMISSION_RESULT_INVALID" },
    });

    setMediaGenerationApprovalRuntime({
      async prepare() { throw new Error("not used"); },
      async submit() {
        return {
          kind: "generated_media",
          version: 1,
          receiptId: prepared.binding.receiptId,
          queueStarted: true,
          mediaKind: "video",
          state: "queued",
          model: prepared.preview.model,
          promptSummary: prepared.preview.prompt.summary,
          settings: prepared.preview.settings,
          recoveryActions: [],
          providerUrl: "https://provider.example/private",
        };
      },
    });
    const topology = await submitMediaGenerationApproval(actor, submit);
    expect(topology).toMatchObject({
      queueStarted: null,
      failure: { code: "SUBMISSION_RESULT_INVALID" },
    });
    expect(JSON.stringify(topology)).not.toContain("provider.example");
  });

  test("maps only a strict preview and forces once/deny", () => {
    const prepared = createMediaGenerationPreparedApproval({
      actor,
      preparation: { ...facts, request: { ...intent, prompt: "Ocean at dusk" } },
      receiptId: "mg_1234567890abcdef",
      quoteUsdMicros: 500_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const mediaGeneration = mediaGenerationApprovalFromPrepared(prepared);
    const event = interruptValueToServerEvent({
      type: "approval_ask",
      approvalId: facts.approvalId,
      tools: [{ name: "generate_video", args: {} }],
      reason: "Paid generation",
      reasonCode: "destructive-tool",
      allowedVerbs: ["once", "room", "always", "deny"],
      mediaGeneration,
    }, facts.threadId, facts.laneKey);
    expect(event?.type).toBe("approval.ask");
    if (event?.type !== "approval.ask") return;
    expect(event.allowedVerbs).toEqual(["once", "deny"]);
    expect(event.mediaGeneration).toEqual(mediaGeneration);
    expect(event.requiresExplicitReview).toBe(true);
    expect(interruptValueToServerEvent({
      type: "approval_ask",
      mediaGeneration: { ...mediaGeneration, digest: "forged" },
    }, facts.threadId, facts.laneKey)).toBeNull();
  });

  test("projects a trusted checkpoint ToolCall without private prepared authority", async () => {
    const privatePrompt = `${"visible ".repeat(30)}full-secret-prompt-tail blob:provider-private`;
    const privateActor = { userId: "private-user-id", roomId: "private-room-id", agentId: "private-agent-id" } as const;
    const preparation = {
      ...facts,
      turnId: "private-turn-id",
      request: { ...intent, prompt: privatePrompt },
    } as const;
    const prepared = createMediaGenerationPreparedApproval({
      actor: privateActor,
      preparation,
      receiptId: "mg_checkpointprivate1",
      quoteUsdMicros: 500_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const trustedCall = {
      name: "generate_video",
      id: facts.toolCallId,
      args: {
        approvalId: facts.approvalId,
        receiptId: prepared.binding.receiptId,
        digest: prepared.binding.approvalDigest,
        quoteDigest: prepared.binding.quoteDigest,
        revision: prepared.binding.revision,
        prepared,
        providerUrl: "https://provider.example/private-queue",
        queueId: "provider-queue-private",
      },
      type: "tool_call",
    } as const;
    const publicTool = await interruptToolEntry(
      trustedCall,
      {} as NautiloState,
    );
    expect(publicTool.args).toEqual({});

    const event = interruptValueToServerEvent({
      type: "approval_ask",
      approvalId: facts.approvalId,
      tools: [publicTool],
      reason: "Paid generation",
      reasonCode: "destructive-tool",
      allowedVerbs: ["once", "deny"],
      mediaGeneration: mediaGenerationApprovalFromPrepared(prepared),
    }, facts.threadId, facts.laneKey);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("full-secret-prompt-tail");
    expect(serialized).not.toContain(prepared.binding.receiptId);
    expect(serialized).not.toContain("private-user-id");
    expect(serialized).not.toContain("private-room-id");
    expect(serialized).not.toContain("private-turn-id");
    expect(serialized).not.toContain("prepared");
    expect(serialized).not.toContain("provider.example");
    expect(serialized).not.toContain("provider-queue-private");
  });

  test("accepts only an exact once resume bound to the checkpoint and quote", () => {
    const prepared = createMediaGenerationPreparedApproval({
      actor,
      preparation: { ...facts, request: { ...intent, prompt: "Ocean at dusk" } },
      receiptId: "mg_1234567890abcdef",
      quoteUsdMicros: 500_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const input = {
      state: {
        ...actor,
        turnId: facts.turnId,
        langgraphThreadId: facts.threadId,
        currentThreadId: facts.threadId,
        approvalLaneKey: facts.laneKey,
      },
      decision: {
        mediaGenerationApprovalId: facts.approvalId,
        mediaGenerationDigest: prepared.binding.approvalDigest,
        mediaGenerationQuoteDigest: prepared.binding.quoteDigest,
        mediaGenerationLaneKey: facts.laneKey,
        mediaGenerationRevision: 1,
      },
      prepared,
      laneKey: facts.laneKey,
      toolCallId: facts.toolCallId,
      toolName: facts.toolName,
      approvalId: facts.approvalId,
      digest: prepared.binding.approvalDigest,
      quoteDigest: prepared.binding.quoteDigest,
      revision: 1,
      verb: "once",
      now: new Date("2098-01-01T00:00:00.000Z"),
    } as const;
    expect(matchesMediaGenerationResumeBinding(input)).toBe(true);
    expect(matchesMediaGenerationResumeBinding({ ...input, verb: "room" })).toBe(false);
    expect(matchesMediaGenerationResumeBinding({
      ...input,
      decision: { ...input.decision, mediaGenerationDigest: "f".repeat(64) },
    })).toBe(false);
  });
});
