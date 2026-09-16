import { describe, expect, test } from "bun:test";
import type {
  CreateMediaGenerationInput,
  MediaGenerationAdmissionProof,
  MediaGenerationAdmissionRefusal,
  MediaGenerationSafeFailure,
  MediaGenerationScope,
} from "@nautilo/db";
import type { MediaGenerationPreparedApproval } from "@nautilo/types";
import type {
  MediaGenerationPreparationInput,
  MediaGenerationSubmitInput,
} from "../tools/media/media-generation-approval-runtime";
import {
  resetMediaGenerationApprovalRuntimeForTests,
  setMediaGenerationApprovalRuntime,
  submitMediaGenerationApproval,
} from "../tools/media/media-generation-approval-runtime";
import { MediaGenerationValidationError, type NormalizedMediaGenerationRequest } from "./contracts";
import { classifyVeniceMediaFailure } from "./errors";
import { VeniceQuoteLifecycleError } from "./quote";
import {
  createMediaGenerationServerCore,
  type MediaGenerationCoreReceipt,
  type MediaGenerationCoreRepository,
} from "./server-core";
import { VeniceMediaLifecycleError } from "./venice-lifecycle";

const NOW = new Date("2030-01-02T03:04:05.000Z");
const actor = { userId: "11111111-1111-4111-8111-111111111111", roomId: "22222222-2222-4222-8222-222222222222", agentId: "33333333-3333-4333-8333-333333333333" };
const scope: MediaGenerationScope = {
  ownerId: actor.userId,
  roomId: actor.roomId,
  namespaceId: "33333333-3333-4333-8333-333333333333",
};
const request: NormalizedMediaGenerationRequest = {
  model: "seedance-2-5-text-to-video-basic",
  prompt: "A small red sailboat crosses a moonlit harbor.",
  durationSeconds: 8,
  aspectRatio: "16:9",
  resolution: "720p",
  audio: true,
};
const preparation: MediaGenerationPreparationInput = {
  request,
  toolName: "generate_video",
  approvalId: "approval-1",
  threadId: "thread-1",
  turnId: "turn-1",
  laneKey: "lane-1",
  toolCallId: "tool-call-1",
};

class FakeRepository implements MediaGenerationCoreRepository {
  receipt: MediaGenerationCoreReceipt | null = null;
  reserveCalls = 0;
  beginCalls = 0;
  acceptedCalls = 0;
  unknownFailures: MediaGenerationSafeFailure[] = [];
  refusedFailures: MediaGenerationSafeFailure[] = [];
  refusalWriteFailure: "null" | "throw" | null = null;

  async find(_scope: MediaGenerationScope, receiptId: string): Promise<MediaGenerationCoreReceipt | null> {
    return this.receipt?.receiptId === receiptId ? this.receipt : null;
  }

  async reserve(input: CreateMediaGenerationInput): Promise<MediaGenerationCoreReceipt> {
    this.reserveCalls += 1;
    if (!this.receipt) {
      this.receipt = {
        receiptId: input.receiptId,
        ownerId: input.ownerId,
        roomId: input.roomId,
        namespaceId: input.namespaceId,
        initiatingAgentId: input.initiatingAgentId,
        initiatingThreadId: input.initiatingThreadId,
        state: "prequeue",
        revision: 0,
        approvalDigest: input.approvalDigest,
        quoteDigest: input.quoteDigest,
        providerAccountFingerprint: input.providerAccountFingerprint,
        requestPayload: input.requestPayload,
        quotedUsdMicros: input.quotedUsdMicros,
        safeFailure: null,
      };
    }
    return this.receipt;
  }

  async beginAdmission(
    _scope: MediaGenerationScope,
    receiptId: string,
    expectedRevision: number,
  ): Promise<MediaGenerationAdmissionProof | null> {
    this.beginCalls += 1;
    if (!this.receipt || this.receipt.receiptId !== receiptId ||
        this.receipt.state !== "prequeue" || this.receipt.revision !== expectedRevision) return null;
    this.receipt = { ...this.receipt, state: "admitting", revision: expectedRevision + 1 };
    return {
      ...scope,
      receiptId,
      revision: expectedRevision + 1,
      admissionToken: "44444444-4444-4444-8444-444444444444",
      kind: "video",
      providerModel: this.receipt.requestPayload.model,
      requestPayload: this.receipt.requestPayload,
    } as unknown as MediaGenerationAdmissionProof;
  }

  async recordAccepted(
    proof: MediaGenerationAdmissionProof,
    _providerQueueId: string,
  ): Promise<MediaGenerationCoreReceipt | null> {
    this.acceptedCalls += 1;
    if (!this.receipt || this.receipt.state !== "admitting" || this.receipt.revision !== proof.revision) return null;
    this.receipt = { ...this.receipt, state: "queued", revision: proof.revision + 1, safeFailure: null };
    return this.receipt;
  }

  async recordUnknown(
    proof: MediaGenerationAdmissionProof,
    failure: MediaGenerationSafeFailure,
  ): Promise<MediaGenerationCoreReceipt | null> {
    this.unknownFailures.push(failure);
    if (!this.receipt || this.receipt.state !== "admitting" || this.receipt.revision !== proof.revision) return null;
    this.receipt = { ...this.receipt, state: "unknown", revision: proof.revision + 1, safeFailure: failure };
    return this.receipt;
  }

  async recordRefused(
    proof: MediaGenerationAdmissionProof,
    refusal: MediaGenerationAdmissionRefusal,
  ): Promise<MediaGenerationCoreReceipt | null> {
    this.refusedFailures.push(refusal.safeFailure);
    if (this.refusalWriteFailure === "throw") throw new Error("simulated refusal write failure");
    if (this.refusalWriteFailure === "null") return null;
    if (!this.receipt || this.receipt.state !== "admitting" || this.receipt.revision !== proof.revision) return null;
    this.receipt = {
      ...this.receipt,
      state: refusal.state,
      revision: proof.revision + 1,
      safeFailure: refusal.safeFailure,
    };
    return this.receipt;
  }
}

function submitInput(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
): MediaGenerationSubmitInput {
  return {
    prepared,
    approvalId: prepared.binding.approvalId,
    receiptId: prepared.binding.receiptId,
    digest: prepared.binding.approvalDigest,
    quoteDigest: prepared.binding.quoteDigest,
    revision: prepared.binding.revision,
    toolCallId: prepared.binding.toolCallId,
  };
}

function harness(input?: {
  readonly quote?: () => Promise<{ amountUsdMicros: number }>;
  readonly resolveRequest?: () => Promise<NormalizedMediaGenerationRequest>;
  readonly queue?: (proof: MediaGenerationAdmissionProof) => Promise<{
    receiptId: string;
    model: "seedance-2-5-text-to-video-basic";
    kind: "video";
    providerQueueId: string;
    signedDeliveryUrl?: string;
  }>;
  readonly refusalWriteFailure?: "null" | "throw";
}) {
  const repository = new FakeRepository();
  repository.refusalWriteFailure = input?.refusalWriteFailure ?? null;
  const quoteInputs: unknown[] = [];
  let queueCalls = 0;
  const core = createMediaGenerationServerCore({
    repository,
    quotes: {
      async quote(value) {
        quoteInputs.push(value);
        if (input?.quote) return input.quote();
        return { amountUsdMicros: 410_000 };
      },
    },
    venice: {
      async queueVeniceMediaGeneration(proof, referenceActor) {
        expect(referenceActor).toEqual(actor);
        queueCalls += 1;
        if (input?.queue) return input.queue(proof);
        return {
          receiptId: proof.receiptId,
          model: "seedance-2-5-text-to-video-basic",
          kind: "video",
          providerQueueId: "provider-queue-secret",
          signedDeliveryUrl: "https://delivery.example/private?signature=secret",
        };
      },
    },
    resolveScope: async () => scope,
    ...(input?.resolveRequest ? { resolveRequest: async (_scope, _request, referenceActor) => {
      expect(referenceActor).toEqual(actor);
      return input.resolveRequest!();
    } } : {}),
    providerAccountFingerprint: "a".repeat(32),
    now: () => NOW,
  });
  return { core, repository, quoteInputs, queueCalls: () => queueCalls };
}

async function preparedFrom(core: ReturnType<typeof createMediaGenerationServerCore>) {
  const result = await core.prepare(actor, preparation);
  if (!result.ok) throw new Error(result.recovery);
  return result.prepared;
}

describe("D525 media generation server core", () => {
  test("preserves safe reference validation recovery without reaching quote", async () => {
    const { core, quoteInputs } = harness({
      resolveRequest: async () => {
        throw new MediaGenerationValidationError("Reference image aspect ratio must be between 0.4 and 2.5.");
      },
    });
    expect(await core.prepare(actor, preparation)).toEqual({
      ok: false,
      code: "request_invalid",
      recovery: "Reference image aspect ratio must be between 0.4 and 2.5. No generation was started.",
    });
    expect(quoteInputs).toEqual([]);
  });

  test("preserves classified quote evidence instead of inventing a provider failure", async () => {
    const rejected = harness({
      quote: async () => {
        throw new VeniceQuoteLifecycleError(classifyVeniceMediaFailure({ phase: "quote", status: 400 }));
      },
    });
    expect(await rejected.core.prepare(actor, preparation)).toEqual({
      ok: false,
      code: "quote_rejected",
      recovery: "Venice rejected these settings. Refresh the available choices and correct the request before trying again.",
    });

    const credentials = harness({
      quote: async () => {
        throw new VeniceQuoteLifecycleError(classifyVeniceMediaFailure({ phase: "quote", status: 401 }));
      },
    });
    expect(await credentials.core.prepare(actor, { ...preparation, approvalId: "approval-credentials" })).toEqual({
      ok: false,
      code: "quote_rejected",
      recovery: "Venice credentials need attention before this generation can be retried.",
    });

    const unclassified = harness({ quote: async () => { throw new Error("private provider detail"); } });
    const result = await unclassified.core.prepare(actor, { ...preparation, approvalId: "approval-unclassified" });
    expect(result).toEqual({
      ok: false,
      code: "quote_unavailable",
      recovery: "The exact quote is unavailable. Try again later; no generation was started.",
    });
    expect(JSON.stringify(result)).not.toContain("private provider detail");
  });

  test("memoizes an exact quote and one durable receipt for approval replay", async () => {
    const { core, repository, quoteInputs } = harness();
    const [left, right] = await Promise.all([
      core.prepare(actor, preparation),
      core.prepare(actor, preparation),
    ]);

    expect(left).toEqual(right);
    expect(left.ok).toBe(true);
    expect(quoteInputs).toEqual([{
      endpoint: "/video/quote",
      pricingRequest: {
        model: request.model,
        duration: "8s",
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
      },
    }]);
    expect(JSON.stringify(quoteInputs)).not.toContain(request.prompt);
    expect(repository.reserveCalls).toBe(1);
    expect(repository.receipt?.receiptId).toMatch(/^mg_[a-f0-9]{64}$/);
    if (!left.ok) return;
    expect(repository.receipt?.approvalDigest).toBe(left.prepared.binding.approvalDigest);
    expect(repository.receipt?.quoteDigest).toBe(left.prepared.binding.quoteDigest);
    expect(repository.receipt?.quotedUsdMicros).toBe(410_000);
    expect(left.prepared.preview.quote).toEqual({
      currency: "USD",
      amountMicros: 410_000,
      display: "USD 0.410000",
    });
  });

  test("queues exactly once and replays from the durable accepted receipt", async () => {
    const testHarness = harness();
    const prepared = await preparedFrom(testHarness.core);
    setMediaGenerationApprovalRuntime(testHarness.core);
    const first = await submitMediaGenerationApproval(actor, submitInput(prepared));
    const replay = await submitMediaGenerationApproval(actor, submitInput(prepared));
    resetMediaGenerationApprovalRuntimeForTests();

    expect(first).toEqual(replay);
    expect(first).toEqual({
      kind: "generated_media",
      version: 1,
      receiptId: prepared.binding.receiptId,
      queueStarted: true,
      mediaKind: "video",
      state: "queued",
      model: request.model,
      promptSummary: request.prompt,
      settings: {
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        audio: true,
      },
      recoveryActions: [],
    });
    expect(testHarness.queueCalls()).toBe(1);
    expect(testHarness.repository.beginCalls).toBe(1);
    expect(testHarness.repository.acceptedCalls).toBe(1);
    expect(JSON.stringify(first)).not.toContain("provider-queue-secret");
    expect(JSON.stringify(first)).not.toContain("delivery.example");
  });

  test("records a known policy refusal and provider refund without using the unknown fence", async () => {
    const testHarness = harness({
      queue: async (proof) => {
        throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
          phase: "admission",
          status: 422,
          code: "content_policy_violation",
          creditsRefunded: true,
        }));
      },
    });
    const prepared = await preparedFrom(testHarness.core);
    const result = await testHarness.core.submit(actor, submitInput(prepared));

    expect(result).toEqual({
      kind: "generated_media",
      version: 1,
      receiptId: prepared.binding.receiptId,
      queueStarted: false,
      mediaKind: "video",
      state: "failed",
      model: request.model,
      promptSummary: request.prompt,
      settings: prepared.preview.settings,
      failure: {
        code: "VENICE_CONTENT_POLICY",
        message: "Venice refused this request. Preserve it, revise it, or choose another model; Nautilo will not repeat it unchanged.",
        creditsRefunded: true,
      },
      recoveryActions: [],
    });
    expect(testHarness.repository.refusedFailures).toHaveLength(1);
    expect(testHarness.repository.refusedFailures[0]).toEqual({
      code: "VENICE_CONTENT_POLICY",
      phase: "queue",
      retrySafe: false,
      stateChanged: false,
      completionCertainty: "not_started",
      chargeCertainty: "refunded",
      creditsRefunded: true,
      recoveryActions: ["revise", "switch_model"],
    });
    expect(testHarness.repository.unknownFailures).toHaveLength(0);
    expect(testHarness.repository.receipt?.state).toBe("failed");
  });

  test("terminalizes every documented deterministic refusal with the exact DB matrix", async () => {
    const cases = [
      { input: { status: 422, code: "content_policy_violation" }, code: "VENICE_CONTENT_POLICY", state: "failed", actions: ["revise", "switch_model"] },
      { input: { status: 409, code: "needs_consent" }, code: "VENICE_NEEDS_CONSENT", state: "needs_action", actions: ["repair_account", "switch_model"] },
      { input: { status: 400 }, code: "VENICE_INVALID_REQUEST", state: "failed", actions: ["revise"] },
      { input: { status: 413 }, code: "VENICE_PAYLOAD_TOO_LARGE", state: "failed", actions: ["revise"] },
      { input: { status: 415 }, code: "VENICE_UNSUPPORTED_MEDIA", state: "failed", actions: ["revise"] },
      { input: { status: 401 }, code: "VENICE_AUTHENTICATION", state: "needs_action", actions: ["repair_account"] },
      { input: { status: 402 }, code: "VENICE_BILLING", state: "needs_action", actions: ["repair_account"] },
      { input: { status: 403 }, code: "VENICE_ACCESS", state: "needs_action", actions: ["repair_account", "switch_model"] },
      { input: { status: 429 }, code: "VENICE_RATE_LIMITED", state: "failed", actions: ["start_fresh"] },
      { input: { status: 503 }, code: "VENICE_CAPACITY", state: "failed", actions: ["start_fresh"] },
    ] as const;

    for (const refusalCase of cases) {
      const testHarness = harness({
        queue: async (proof) => {
          throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
            phase: "admission",
            ...refusalCase.input,
          }));
        },
      });
      const prepared = await preparedFrom(testHarness.core);
      const result = await testHarness.core.submit(actor, submitInput(prepared));

      expect(result.queueStarted).toBe(false);
      expect(result.state).toBe(refusalCase.state === "needs_action" ? "needs-action" : "failed");
      expect(result.failure?.code).toBe(refusalCase.code);
      expect(testHarness.repository.refusedFailures).toHaveLength(1);
      expect(testHarness.repository.refusedFailures[0]?.recoveryActions).toEqual(refusalCase.actions);
      expect(testHarness.repository.unknownFailures).toHaveLength(0);
      expect(testHarness.repository.receipt?.state).toBe(refusalCase.state);
      if (refusalCase.code === "VENICE_RATE_LIMITED" || refusalCase.code === "VENICE_CAPACITY") {
        expect(result.failure?.message).toBe(
          "Venice is busy. Wait, then request a fresh quote and approve a new generation.",
        );
      }
    }
  });

  test("surfaces durable reconciliation when a deterministic refusal write fails", async () => {
    for (const refusalWriteFailure of ["null", "throw"] as const) {
      const testHarness = harness({
        refusalWriteFailure,
        queue: async (proof) => {
          throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
            phase: "admission",
            status: 401,
          }));
        },
      });
      const prepared = await preparedFrom(testHarness.core);
      const result = await testHarness.core.submit(actor, submitInput(prepared));

      expect(result.queueStarted).toBe(false);
      expect(result.state).toBe("failed");
      expect(result.failure).toEqual({
        code: "MEDIA_DURABLE_REFUSAL_WRITE_FAILED",
        message: "No generation was started, but Nautilo could not durably record the refusal. Check status before requesting a fresh quote.",
      });
      expect(testHarness.repository.receipt?.state).toBe("admitting");
      expect(testHarness.queueCalls()).toBe(1);
    }
  });

  test("durably fences ambiguous post-request uncertainty and never requeues it", async () => {
    const testHarness = harness({
      queue: async (proof) => {
        throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
          phase: "admission",
          transportFailure: true,
        }));
      },
    });
    const prepared = await preparedFrom(testHarness.core);
    const first = await testHarness.core.submit(actor, submitInput(prepared));
    const replay = await testHarness.core.submit(actor, submitInput(prepared));

    expect(first).toEqual({
      kind: "generated_media",
      version: 1,
      receiptId: prepared.binding.receiptId,
      queueStarted: null,
      mediaKind: "video",
      state: "unknown",
      model: request.model,
      promptSummary: request.prompt,
      settings: prepared.preview.settings,
      failure: {
        code: "VENICE_ADMISSION_RECONCILIATION_REQUIRED",
        message: "Check this generation's status before requesting another paid generation.",
      },
      recoveryActions: [],
    });
    expect(replay).toEqual(first);
    expect(testHarness.queueCalls()).toBe(1);
    expect(testHarness.repository.unknownFailures).toHaveLength(1);
    expect(testHarness.repository.unknownFailures[0]).toEqual({
      code: "VENICE_QUEUE_COMPLETION_UNKNOWN",
      phase: "queue",
      stateChanged: true,
      completionCertainty: "unknown",
      chargeCertainty: "unknown",
      retrySafe: false,
      recoveryActions: ["repair_account"],
    });
    expect(testHarness.repository.refusedFailures).toHaveLength(0);
    expect(testHarness.repository.receipt?.state).toBe("unknown");
  });

  test("fails closed before admission when the checkpoint quote binding is stale", async () => {
    const testHarness = harness();
    const prepared = await preparedFrom(testHarness.core);
    const result = await testHarness.core.submit(actor, {
      ...submitInput(prepared),
      quoteDigest: "0".repeat(64),
    });

    expect(result).toEqual({
      kind: "generated_media",
      version: 1,
      queueStarted: false,
      mediaKind: "video",
      state: "failed",
      model: "unavailable",
      promptSummary: "",
      settings: {},
      failure: {
        code: "MEDIA_APPROVAL_STALE",
        message: "This media approval is stale or no longer matches the prepared request.",
      },
      recoveryActions: [],
    });
    expect(testHarness.repository.beginCalls).toBe(0);
    expect(testHarness.queueCalls()).toBe(0);
  });
});
