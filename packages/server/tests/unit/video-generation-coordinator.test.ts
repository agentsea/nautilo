import { afterEach, describe, expect, test } from "bun:test";
import {
  createMediaGenerationPreparedApproval,
  resetMediaGenerationApprovalRuntimeForTests,
  setMediaGenerationApprovalRuntime,
} from "../../../agent/src/tools/media/media-generation-approval-runtime";
import { createVideoGenerationCoordinator, type VideoGenerationLinkRecord } from "../../src/video-generation/coordinator";

const scope = {
  userId: "11111111-1111-4111-8111-111111111111",
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  roomId: "22222222-2222-4222-8222-222222222222",
  namespaceId: "33333333-3333-4333-8333-333333333333",
  projectArtifactInternalId: "44444444-4444-4444-8444-444444444444",
  projectArtifactId: "55555555-5555-4555-8555-555555555555",
} as const;

const intent = {
  model: "seedance-2-5-text-to-video-basic",
  prompt: "A bird crosses a blue sky.", durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audio: true,
} as const;

afterEach(() => resetMediaGenerationApprovalRuntimeForTests());

describe("D378 Video generation coordinator", () => {
  test("propagates an absent media runtime as quote unavailable without writing", async () => {
    let writes = 0;
    const coordinator = createVideoGenerationCoordinator({
      links: {
        async findByRequest() { return null; },
        async create(link) { writes += 1; return link; },
        async markAdmitted() { writes += 1; return true; },
      },
    });

    const result = await coordinator.prepare({
      scope,
      requestId: "99999999-9999-4999-8999-999999999999",
      shotId: "shot",
      shotLabel: "Shot",
      briefDigest: `sha256:${"c".repeat(64)}`,
      documentRevision: 0,
      intent,
    });

    expect(result).toEqual({
      ok: false,
      code: "quote_unavailable",
      recovery: "Configure Venice for media generation, then request a fresh quote. No generation was started.",
    });
    expect(writes).toBe(0);
  });

  test("binds an exact first-party project/take lineage and never invents a Genie turn", async () => {
    const links: VideoGenerationLinkRecord[] = [];
    let received: unknown;
    setMediaGenerationApprovalRuntime({
      async prepare(actor, input) {
        received = input;
        return { ok: true as const, prepared: createMediaGenerationPreparedApproval({
          actor, preparation: input, receiptId: "mg_1234567890abcdef", quoteUsdMicros: 100_000,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }) };
      },
      async submit(_actor, input) {
        return {
          kind: "generated_media" as const, version: 1 as const, receiptId: input.receiptId,
          queueStarted: true as const, mediaKind: "video" as const, state: "queued" as const,
          model: input.prepared.preview.model, promptSummary: input.prepared.preview.prompt.summary,
          settings: input.prepared.preview.settings, recoveryActions: [],
        };
      },
    });
    let ids = 0;
    const coordinator = createVideoGenerationCoordinator({
      randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
      links: {
        async findByRequest() { return null; },
        async create(link) { links.push(link); return link; },
        async markAdmitted(_scope, takeId) {
          const index = links.findIndex((entry) => entry.takeId === takeId);
          if (index < 0) return false;
          links[index] = { ...links[index]!, admittedAt: new Date() };
          return true;
        },
      },
    });
    const prepared = await coordinator.prepare({
      scope, requestId: "66666666-6666-4666-8666-666666666666", shotId: "shot-1", shotLabel: "Opening",
      briefDigest: `sha256:${"a".repeat(64)}`, documentRevision: 7, intent,
    });
    expect(prepared.ok).toBe(true);
    expect(received).toMatchObject({
      approvalId: "video:66666666-6666-4666-8666-666666666666",
      origin: { kind: "video_app", projectArtifactId: scope.projectArtifactId, requestId: "66666666-6666-4666-8666-666666666666" },
    });
    expect(received).not.toHaveProperty("threadId");
    expect(received).not.toHaveProperty("toolCallId");
    expect(links).toMatchObject([{ receiptId: "mg_1234567890abcdef", projectArtifactInternalId: scope.projectArtifactInternalId, shotId: "shot-1", documentRevision: 7 }]);
    if (!prepared.ok) return;
    expect(prepared.review.takeId).toMatch(/^take_[A-Za-z0-9_-]{16,128}$/u);
    // Unrelated projects/reviews must not silently evict a still-valid quote.
    for (let index = 0; index < 129; index += 1) {
      const retained = await coordinator.prepare({
        scope, requestId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
        shotId: "shot-1", shotLabel: "A complete scene label ".repeat(50),
        briefDigest: `sha256:${"a".repeat(64)}`, documentRevision: 7, intent,
      });
      expect(retained.ok).toBe(true);
    }
    expect(links.filter((link) => link.admittedAt)).toHaveLength(0);
    expect((await coordinator.submit({ scope, takeId: prepared.review.takeId, reviewHandle: prepared.review.reviewHandle })).queueStarted).toBe(true);
    expect(links.filter((link) => link.admittedAt)).toHaveLength(1);
  });

  test("rejects invalid project request before any quote or durable write", async () => {
    const coordinator = createVideoGenerationCoordinator({
      links: {
        async findByRequest() { throw new Error("must not read"); },
        async create() { throw new Error("must not write"); },
        async markAdmitted() { throw new Error("must not mark"); },
      },
    });
    const result = await coordinator.prepare({
      scope, requestId: "not-a-uuid", shotId: "shot", shotLabel: "Shot", briefDigest: `sha256:${"a".repeat(64)}`, documentRevision: 0, intent,
    });
    expect(result).toMatchObject({ ok: false, code: "request_invalid" });
  });

  test("maps core preparation failures to the stable Video API without spending or writing", async () => {
    const cases = [
      ["target_unavailable", "quote_unavailable"],
      ["request_invalid", "request_invalid"],
      ["quote_unavailable", "quote_unavailable"],
      ["quote_rejected", "request_invalid"],
      ["quote_binding_failed", "quote_unavailable"],
      ["quote_reservation_failed", "quote_unavailable"],
    ] as const;
    let writes = 0;
    let submits = 0;
    const coordinator = createVideoGenerationCoordinator({
      links: {
        async findByRequest() { return null; },
        async create(link) { writes += 1; return link; },
        async markAdmitted() { writes += 1; return true; },
      },
    });

    for (const [coreCode, videoCode] of cases) {
      const recovery = `${coreCode}: no generation was started.`;
      setMediaGenerationApprovalRuntime({
        async prepare() { return { ok: false as const, code: coreCode, recovery }; },
        async submit() { submits += 1; throw new Error("must not submit"); },
      });
      const suffix = String(cases.findIndex(([candidate]) => candidate === coreCode) + 1).padStart(12, "0");
      const result = await coordinator.prepare({
        scope,
        requestId: `77777777-7777-4777-8777-${suffix}`,
        shotId: "shot",
        shotLabel: "Shot",
        briefDigest: `sha256:${"b".repeat(64)}`,
        documentRevision: 0,
        intent,
      });
      expect(result).toEqual({ ok: false, code: videoCode, recovery });
    }
    expect(writes).toBe(0);
    expect(submits).toBe(0);
  });
});
