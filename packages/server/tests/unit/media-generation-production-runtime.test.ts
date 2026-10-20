import { afterEach, describe, expect, test } from "bun:test";
import {
  hasMediaGenerationApprovalRuntime,
  type MediaGenerationPreparationInput,
} from "@nautilo/agent";
import type {
  CreateMediaGenerationInput,
  DirectDatabase,
  MediaGeneration,
  MediaGenerationAdmissionProof,
  MediaGenerationAdmissionRefusal,
  MediaGenerationSafeFailure,
  MediaGenerationScope,
} from "@nautilo/db";
import {
  createExactVeniceMediaQuotePort,
  createMediaGenerationDbRepository,
  createProductionMediaGenerationRuntime,
  installProductionMediaGenerationRuntime,
  resetProductionMediaGenerationRuntime,
  resolveMediaGenerationWritableScope,
  type MediaGenerationDbOperations,
} from "../../src/media-generation/production-runtime";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  roomId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
};
const actorId = "33333333-3333-4333-8333-333333333333";
const namespaceId = "44444444-4444-4444-8444-444444444444";
const scope: MediaGenerationScope = { ownerId: actor.userId, roomId: actor.roomId, namespaceId };
const privatePromptTail = "PRIVATE_CREATIVE_TAIL_DO_NOT_PROJECT";
const creativePrompt = `${"Cinematic moonlit harbor with a red sailboat. ".repeat(6)}${privatePromptTail}`;
const preparation: MediaGenerationPreparationInput = {
  request: {
    model: "seedance-2-5-text-to-video-basic",
    prompt: creativePrompt,
    durationSeconds: 8,
    aspectRatio: "16:9",
    resolution: "720p",
    audio: true,
  },
  toolName: "generate_video",
  approvalId: "approval-production-1",
  threadId: "thread-production-1",
  turnId: "turn-production-1",
  laneKey: "lane-production-1",
  toolCallId: "tool-call-production-1",
};
const musicPreparation: MediaGenerationPreparationInput = {
  request: {
    model: "minimax-music-v26",
    prompt: "A gentle piano melody",
    forceInstrumental: true,
  },
  toolName: "generate_music",
  approvalId: "approval-production-music",
  threadId: "thread-production-music",
  turnId: "turn-production-music",
  laneKey: "lane-production-music",
  toolCallId: "tool-call-production-music",
};
const mediaCapabilities = async () => ["use_media_generation"];

afterEach(() => {
  resetProductionMediaGenerationRuntime();
});

async function expectRejectionMessage(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation;
    throw new Error("expected operation to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

function rowFromInput(
  input: CreateMediaGenerationInput,
  overrides: Partial<MediaGeneration> = {},
): MediaGeneration {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    providerQueueId: null,
    admissionToken: null,
    admissionStartedAt: null,
    state: "prequeue",
    revision: 0,
    safeFailure: null,
    artifactInternalId: null,
    cleanupState: "pending",
    cleanupCompletedAt: null,
    claimOwner: null,
    claimExpiresAt: null,
    nextAttemptAt: new Date(),
    acceptedAt: null,
    readyAt: null,
    terminalAt: null,
    retainUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
    ...overrides,
  } as MediaGeneration;
}

function authorityDb(): DirectDatabase {
  let selectCall = 0;
  return {
    select() {
      const rows = selectCall++ % 2 === 0
        ? [{ id: actorId }]
        : [{ roomId: actor.roomId, namespaceId, kind: "private", humanActorIds: [actorId] }];
      const chain = {
        from() { return chain; },
        innerJoin() { return chain; },
        where() { return chain; },
        limit: async () => rows,
      };
      return chain;
    },
  } as unknown as DirectDatabase;
}

function operations(input?: {
  readonly rotateFingerprint?: boolean;
  readonly onRefusal?: (refusal: MediaGenerationAdmissionRefusal) => void;
}) {
  let receipt: MediaGeneration | null = null;
  const dbOperations = {
    find: async (_db: DirectDatabase, _scope: MediaGenerationScope, receiptId: string) =>
      receipt?.receiptId === receiptId ? receipt : null,
    create: async (_db: DirectDatabase, createInput: CreateMediaGenerationInput) => {
      receipt = rowFromInput(createInput, input?.rotateFingerprint
        ? { providerAccountFingerprint: "b".repeat(32) }
        : {});
      return receipt;
    },
    beginAdmission: async (_db: DirectDatabase, admission: MediaGenerationScope & { receiptId: string; expectedRevision: number }) => {
      if (!receipt) return null;
      receipt = { ...receipt, state: "admitting", revision: admission.expectedRevision + 1 };
      return {
        ...scope,
        receiptId: admission.receiptId,
        revision: admission.expectedRevision + 1,
        admissionToken: "66666666-6666-4666-8666-666666666666",
        kind: receipt.kind,
        provider: receipt.provider,
        providerModel: receipt.providerModel,
        providerAccountFingerprint: receipt.providerAccountFingerprint,
        fundingBinding: receipt.fundingBinding,
        quotedUsdMicros: receipt.quotedUsdMicros,
        requestPayload: receipt.requestPayload,
      } as unknown as MediaGenerationAdmissionProof;
    },
    recordAccepted: async (_db: DirectDatabase, proof: MediaGenerationAdmissionProof, providerQueueId: string) => {
      if (!receipt) return null;
      receipt = {
        ...receipt,
        state: "queued",
        revision: proof.revision + 1,
        providerQueueId,
        acceptedAt: new Date(),
      };
      return receipt;
    },
    recordUnknown: async (_db: DirectDatabase, proof: MediaGenerationAdmissionProof, safeFailure: MediaGenerationSafeFailure) => {
      if (!receipt) return null;
      receipt = { ...receipt, state: "unknown", revision: proof.revision + 1, safeFailure };
      return receipt;
    },
    recordRefused: async (_db: DirectDatabase, proof: MediaGenerationAdmissionProof, refusal: MediaGenerationAdmissionRefusal) => {
      input?.onRefusal?.(refusal);
      if (!receipt) return null;
      receipt = { ...receipt, state: refusal.state, revision: proof.revision + 1, safeFailure: refusal.safeFailure };
      return receipt;
    },
  } as unknown as MediaGenerationDbOperations;
  return { dbOperations, read: () => receipt };
}

function submitInput(prepared: Awaited<ReturnType<ReturnType<typeof createProductionMediaGenerationRuntime>["prepare"]>> & { ok: true }) {
  const value = prepared.prepared;
  return {
    prepared: value,
    approvalId: value.binding.approvalId,
    receiptId: value.binding.receiptId,
    digest: value.binding.approvalDigest,
    quoteDigest: value.binding.quoteDigest,
    revision: value.binding.revision,
    toolCallId: value.binding.toolCallId,
  };
}

function providerFetch(input?: { readonly signedDelivery?: boolean }) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).endsWith("/video/quote")) {
      return new Response(JSON.stringify({ quote: 0.41 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      model: "seedance-2-5-text-to-video-basic",
      queue_id: "provider-queue-secret",
      ...(input?.signedDelivery
        ? { download_url: "https://delivery.example/private?signature=secret" }
        : {}),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, requests };
}

describe("D525 production media generation runtime", () => {
  test("posts pricing-only quote mechanics with bearer auth and strict response shape", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const port = createExactVeniceMediaQuotePort({
      apiKey: "venice-secret",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ quote: 0.41 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const result = await port.quote({
      endpoint: "/video/quote",
      pricingRequest: {
        model: "seedance-2-5-text-to-video-basic",
        duration: "8s",
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
      },
    });

    expect(result).toEqual({ amountUsdMicros: 410_000 });
    expect(requests[0]?.url).toBe("https://api.venice.ai/api/v1/video/quote");
    expect(requests[0]?.init?.method).toBe("POST");
    expect((requests[0]?.init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer venice-secret",
    );
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      model: "seedance-2-5-text-to-video-basic",
      duration: "8s",
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: true,
    }));
    const quoteBody = requests[0]?.init?.body;
    expect(typeof quoteBody).toBe("string");
    if (typeof quoteBody !== "string") throw new Error("expected serialized quote request");
    expect(quoteBody).not.toContain("prompt");
    expect(quoteBody).not.toContain("lyrics");

    const strict = createExactVeniceMediaQuotePort({
      apiKey: "venice-secret",
      maxAttempts: 1,
      onDiagnostic: () => {},
      fetchImpl: async () => new Response(JSON.stringify({ quote: 0.41, raw: "private" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    await expectRejectionMessage(
      strict.quote({ endpoint: "/audio/quote", pricingRequest: { model: "minimax-music-v26" } }),
      "invalid exact quote",
    );

    const overPrecise = createExactVeniceMediaQuotePort({
      apiKey: "venice-secret",
      maxAttempts: 1,
      onDiagnostic: () => {},
      fetchImpl: async () => new Response(JSON.stringify({ quote: 0.1234567 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    await expectRejectionMessage(
      overPrecise.quote({ endpoint: "/audio/quote", pricingRequest: { model: "minimax-music-v26" } }),
      "invalid exact quote",
    );
  });

  test("retries transient quote failures without leaking private provider data", async () => {
    const diagnostics: unknown[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const port = createExactVeniceMediaQuotePort({
      apiKey: "venice-secret",
      sleepImpl: async (delayMs) => { sleeps.push(delayMs); },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transport included PRIVATE_PROVIDER_BODY");
        if (calls === 2) {
          return new Response(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_BODY" } }), {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "quote-request-2",
              "Retry-After": "0.25",
            },
          });
        }
        return new Response(JSON.stringify({ quote: 1.44 }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      },
    });

    expect(await port.quote({
      endpoint: "/video/quote",
      pricingRequest: {
        model: "seedance-2-5-reference-to-video-basic",
        duration: "5s",
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
      },
    })).toEqual({ amountUsdMicros: 1_440_000 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([150, 250]);
    expect(diagnostics).toEqual([
      {
        outcome: "retrying",
        attempt: 1,
        maxAttempts: 3,
        endpoint: "/video/quote",
        model: "seedance-2-5-reference-to-video-basic",
        failureCode: "VENICE_QUOTE_UNAVAILABLE",
        transportKind: "network",
      },
      {
        outcome: "retrying",
        attempt: 2,
        maxAttempts: 3,
        endpoint: "/video/quote",
        model: "seedance-2-5-reference-to-video-basic",
        failureCode: "VENICE_QUOTE_UNAVAILABLE",
        status: 500,
        requestId: "quote-request-2",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(JSON.stringify(diagnostics)).not.toContain("venice-secret");
  });

  test("times out a stalled quote attempt without waiting on an outer request timeout", async () => {
    const diagnostics: unknown[] = [];
    const port = createExactVeniceMediaQuotePort({
      apiKey: "venice-secret",
      maxAttempts: 1,
      attemptTimeoutMs: 5,
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
      fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });

    await expectRejectionMessage(port.quote({
      endpoint: "/video/quote",
      pricingRequest: {
        model: "seedance-2-5-text-to-video-basic",
        duration: "5s",
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
      },
    }), "after safe retries");
    expect(diagnostics).toEqual([{
      outcome: "failed",
      attempt: 1,
      maxAttempts: 1,
      endpoint: "/video/quote",
      model: "seedance-2-5-text-to-video-basic",
      failureCode: "VENICE_QUOTE_UNAVAILABLE",
      transportKind: "timeout",
    }]);
  });

  test("does not retry deterministic quote refusals and reports classified evidence", async () => {
    for (const [status, providerCode, failureCode, message] of [
      [400, "invalid_request", "VENICE_INVALID_REQUEST", "rejected these settings"],
      [401, undefined, "VENICE_AUTHENTICATION", "credentials need attention"],
    ] as const) {
      const diagnostics: unknown[] = [];
      let calls = 0;
      const port = createExactVeniceMediaQuotePort({
        apiKey: "venice-secret",
        sleepImpl: async () => { throw new Error("deterministic refusal must not sleep"); },
        onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({
            error: {
              ...(providerCode === undefined ? {} : { code: providerCode }),
              message: "PRIVATE_PROVIDER_BODY",
            },
          }), {
            status,
            headers: { "Content-Type": "application/json", "X-Request-Id": `quote-${status}` },
          });
        },
      });

      await expectRejectionMessage(port.quote({
        endpoint: "/video/quote",
        pricingRequest: {
          model: "seedance-2-5-text-to-video-basic",
          duration: "5s",
          aspect_ratio: "16:9",
          resolution: "720p",
          audio: true,
        },
      }), message);
      expect(calls).toBe(1);
      expect(diagnostics).toEqual([{
        outcome: "failed",
        attempt: 1,
        maxAttempts: 3,
        endpoint: "/video/quote",
        model: "seedance-2-5-text-to-video-basic",
        failureCode,
        status,
        ...(providerCode === undefined ? {} : { providerCode }),
        requestId: `quote-${status}`,
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_PROVIDER_BODY");
    }
  });

  test("fails with a classified invalid-response error after bounded retries", async () => {
    const diagnostics: unknown[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const port = createExactVeniceMediaQuotePort({
      apiKey: "venice-secret",
      sleepImpl: async (delayMs) => { sleeps.push(delayMs); },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
      fetchImpl: async () => {
        calls += 1;
        return new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } });
      },
    });

    await expectRejectionMessage(port.quote({
      endpoint: "/audio/quote",
      pricingRequest: { model: "minimax-music-v26" },
    }), "invalid exact quote after safe retries");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([150, 500]);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "VENICE_QUOTE_INVALID_RESPONSE",
      status: 200,
    });
  });

  test("maps authenticated user ownership to the live member Room namespace", async () => {
    const resolved = await resolveMediaGenerationWritableScope(authorityDb(), actor, mediaCapabilities);
    expect(resolved).toEqual({
      // media_generations.owner_id references users.id; actors.owner_id is the
      // canonical authenticated User mapping used by the DB trigger.
      ownerId: actor.userId,
      roomId: actor.roomId,
      namespaceId,
    });
    expect(resolved.ownerId).not.toBe(actorId);
  });

  test("personal provider funding does not grant the independent media generation capability", async () => {
    let fundingOpened = 0;
    const runtime = createProductionMediaGenerationRuntime({
      db: authorityDb(),
      dbOperations: operations().dbOperations,
      getCapabilities: async () => ["use_personal_provider_credentials"],
      openFunding: async () => {
        fundingOpened += 1;
        throw new Error("must not open funding without media authority");
      },
    });

    expect(await runtime.prepare(actor, preparation)).toMatchObject({
      ok: false,
      code: "target_unavailable",
    });
    expect(fundingOpened).toBe(0);
  });

  test("preflights every approved video setting and preserves an explicit audio-off request", async () => {
    const opened: unknown[] = [];
    const funding = {
      humanUserId: actor.userId,
      provider: "venice" as const,
      binding: { kind: "server" as const, providerRoute: "venice" as const },
      credentialFingerprint: "a".repeat(64),
    };
    const provider = providerFetch();
    const runtime = createProductionMediaGenerationRuntime({
      db: authorityDb(),
      dbOperations: operations().dbOperations,
      getCapabilities: mediaCapabilities,
      openFunding: async (_humanUserId, modelId, family, options) => {
        opened.push(options);
        return { modelId, family, funding, runAttempt: async () => { throw new Error("unused"); } };
      },
      runFunding: async (_binding, _intent, callback) => callback({
        apiKey: "venice-secret",
        usageFunding: { kind: "server", humanUserId: actor.userId, providerRoute: "venice" },
      }),
      fetchImpl: provider.fetchImpl,
    });

    const prepared = await runtime.prepare(actor, {
      ...preparation,
      approvalId: "approval-video-audio-off",
      request: {
        model: "seedance-2-5-text-to-video-basic",
        prompt: creativePrompt,
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        audio: false,
      },
    });
    expect(prepared.ok).toBe(true);
    expect(opened).toEqual([{
      operation: "generate",
      surplusRequirements: {
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        audio: false,
      },
    }]);
  });

  test("uses the public fixed-origin market snapshot as an honest Surplus estimate", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const funding = {
      humanUserId: actor.userId,
      provider: "surplus" as const,
      binding: { kind: "server" as const, providerRoute: "surplus" as const },
      credentialFingerprint: "a".repeat(64),
    };
    const runtime = createProductionMediaGenerationRuntime({
      db: authorityDb(),
      dbOperations: operations().dbOperations,
      getCapabilities: mediaCapabilities,
      openFunding: async (_humanUserId, modelId, family) => ({
        modelId,
        family,
        funding,
        runAttempt: async () => { throw new Error("unused"); },
      }),
      runFunding: async (_binding, _intent, callback) => callback({
        apiKey: "surplus-secret-not-sent-to-market",
        usageFunding: { kind: "server", humanUserId: actor.userId, providerRoute: "surplus" },
      }),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(JSON.stringify({
          model: "venice-minimax-music-v26",
          offers: [
            { available: true, healthy: true, media_unit: "job", media_unit_price: 60_000 },
            { available: true, healthy: true, media_unit: "job", media_unit_price: 55_000 },
            { available: true, healthy: false, media_unit: "job", media_unit_price: 1 },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const prepared = await runtime.prepare(actor, musicPreparation);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.preview.quote).toMatchObject({ kind: "estimate", amountMicros: 55_000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.surplusintelligence.ai/api/markets/venice-minimax-music-v26");
    expect(requests[0]?.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect((requests[0]?.init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  test.each(["personal", "server"] as const)("%s Surplus may use admitted personal direct before reserving when no healthy exact offer exists", async (primaryKind) => {
    const state = operations();
    const surplusFunding = {
      humanUserId: actor.userId,
      provider: "surplus" as const,
      binding: primaryKind === "server"
        ? { kind: "server" as const, providerRoute: "surplus" }
        : { kind: "personal" as const, providerRoute: "surplus", credentialId: "55555555-5555-4555-8555-555555555555", credentialRevision: 2 },
      credentialFingerprint: "a".repeat(64),
    };
    const directFunding = {
      humanUserId: actor.userId,
      provider: "venice" as const,
      binding: { kind: "personal" as const, providerRoute: "venice" as const, credentialId: "66666666-6666-4666-8666-666666666666", credentialRevision: 4 },
      credentialFingerprint: "b".repeat(64),
    };
    const opened: Array<{ modelId: string; options: unknown }> = [];
    const runtime = createProductionMediaGenerationRuntime({
      db: authorityDb(),
      dbOperations: state.dbOperations,
      getCapabilities: mediaCapabilities,
      openFunding: async (_humanUserId, modelId, family, options) => {
        opened.push({ modelId, options });
        const funding = options?.transport === "direct" ? directFunding : surplusFunding;
        return { modelId, family, funding, runAttempt: async () => { throw new Error("unused"); } };
      },
      runFunding: async (binding, _intent, callback) => {
        if (binding.binding.kind !== "personal") throw new Error("expected personal funding");
        return callback({
          apiKey: binding.provider === "surplus" ? "surplus-secret" : "venice-secret",
          usageFunding: {
            kind: "personal", humanUserId: actor.userId, payerHumanId: actor.userId,
            providerRoute: binding.provider,
            credentialId: binding.binding.credentialId,
            credentialRevision: binding.binding.credentialRevision,
          },
        });
      },
      surplusEstimateUsdMicros: async () => null,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/audio/quote")) {
          return new Response(JSON.stringify({ quote: 0.09 }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${String(url)}`);
      },
    });

    const prepared = await runtime.prepare(actor, musicPreparation);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.preview.quote).toMatchObject({ kind: "exact", amountMicros: 90_000 });
    expect(opened).toEqual([
      { modelId: "venice:minimax-music-v26", options: { operation: "generate" } },
      {
        modelId: "venice:minimax-music-v26",
        options: { operation: "generate", prior: surplusFunding, transport: "direct" },
      },
    ]);
    expect(state.read()).toMatchObject({
      provider: "venice",
      providerModel: "minimax-music-v26",
      fundingBinding: directFunding,
      providerAccountFingerprint: directFunding.credentialFingerprint,
    });
  });

  test("preserves an approved Surplus receipt after definitive refusal without direct resubmission", async () => {
    const state = operations();
    const funding = {
      humanUserId: actor.userId,
      provider: "surplus" as const,
      binding: { kind: "server" as const, providerRoute: "surplus" as const },
      credentialFingerprint: "a".repeat(64),
    };
    let fundingOpens = 0;
    let submissions = 0;
    const runtime = createProductionMediaGenerationRuntime({
      db: authorityDb(),
      dbOperations: state.dbOperations,
      getCapabilities: mediaCapabilities,
      openFunding: async (_humanUserId, modelId, family) => {
        fundingOpens += 1;
        return { modelId, family, funding, runAttempt: async () => { throw new Error("unused"); } };
      },
      runFunding: async (_binding, _intent, callback) => callback({
        apiKey: "surplus-secret",
        usageFunding: { kind: "server", humanUserId: actor.userId, providerRoute: "surplus" },
      }),
      surplusEstimateUsdMicros: async () => 60_000,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/v1/music/generations")) {
          submissions += 1;
          return new Response(JSON.stringify({ error: "request refused" }), {
            status: 422, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected request ${String(url)}`);
      },
      beginCostAttempt: async () => undefined,
      settleCostAttempt: async () => undefined,
    });

    const prepared = await runtime.prepare(actor, musicPreparation);
    if (!prepared.ok) throw new Error(prepared.recovery);
    const result = await runtime.submit(actor, submitInput(prepared));
    expect(result).toMatchObject({ queueStarted: false, state: "failed" });
    expect(fundingOpens).toBe(1);
    expect(submissions).toBe(1);
    expect(state.read()).toMatchObject({ provider: "surplus", state: "failed" });
  });

  for (const revokeAt of ["funding_open", "cost_write"] as const) {
    test(`revocation during ${revokeAt} prevents paid media dispatch`, async () => {
      const state = operations();
      const funding = { humanUserId: actor.userId, provider: "surplus" as const,
        binding: { kind: "server" as const, providerRoute: "surplus" as const },
        credentialFingerprint: "a".repeat(64) };
      let submitting = false;
      let revoked = false;
      let submissions = 0;
      let costWrites = 0;
      const runtime = createProductionMediaGenerationRuntime({
        db: authorityDb(), dbOperations: state.dbOperations,
        getCapabilities: async () => revoked ? [] : ["use_media_generation"],
        openFunding: async (_human, modelId, family) => ({ modelId, family, funding,
          runAttempt: async () => { throw new Error("unused"); } }),
        runFunding: async (_binding, _intent, callback) => {
          if (submitting && revokeAt === "funding_open") revoked = true;
          return callback({ apiKey: "surplus-secret", usageFunding: {
            kind: "server", humanUserId: actor.userId, providerRoute: "surplus" } });
        },
        surplusEstimateUsdMicros: async () => 60_000,
        fetchImpl: async () => { submissions += 1; throw new Error("must not dispatch"); },
        beginCostAttempt: async () => { costWrites += 1; if (revokeAt === "cost_write") revoked = true; },
        settleCostAttempt: async () => undefined,
      });
      const prepared = await runtime.prepare(actor, musicPreparation);
      if (!prepared.ok) throw new Error(prepared.recovery);
      submitting = true;
      expect(await runtime.submit(actor, submitInput(prepared))).toMatchObject({ queueStarted: false, state: "needs-action" });
      expect(state.read()?.safeFailure).toMatchObject({ code: "MEDIA_AUTHORITY_CHANGED", completionCertainty: "not_started", chargeCertainty: "not_charged" });
      expect(submissions).toBe(0);
      expect(costWrites).toBe(revokeAt === "funding_open" ? 0 : 1);
    });
  }

  test("failed cost settlement preserves an uncertain Surplus admission without resubmission", async () => {
    const state = operations();
    const funding = {
      humanUserId: actor.userId, provider: "surplus" as const,
      binding: { kind: "server" as const, providerRoute: "surplus" as const },
      credentialFingerprint: "a".repeat(64),
    };
    let submissions = 0;
    let settlements = 0;
    const runtime = createProductionMediaGenerationRuntime({
      db: authorityDb(), dbOperations: state.dbOperations, getCapabilities: mediaCapabilities,
      openFunding: async (_human, modelId, family) => ({ modelId, family, funding,
        runAttempt: async () => { throw new Error("unused"); } }),
      runFunding: async (_binding, _intent, callback) => callback({ apiKey: "surplus-secret",
        usageFunding: { kind: "server", humanUserId: actor.userId, providerRoute: "surplus" } }),
      surplusEstimateUsdMicros: async () => 60_000,
      fetchImpl: async () => { submissions += 1; throw new Error("transport interrupted after dispatch"); },
      beginCostAttempt: async () => undefined,
      settleCostAttempt: async () => { settlements += 1; throw new Error("accounting storage unavailable"); },
    });
    const prepared = await runtime.prepare(actor, musicPreparation);
    if (!prepared.ok) throw new Error(prepared.recovery);
    const result = await runtime.submit(actor, submitInput(prepared));
    expect(result).toMatchObject({ queueStarted: null, state: "unknown" });
    expect(state.read()).toMatchObject({ state: "unknown", safeFailure: {
      completionCertainty: "unknown", chargeCertainty: "unknown", retrySafe: false,
    } });
    expect(await runtime.submit(actor, submitInput(prepared))).toEqual(result);
    expect(submissions).toBe(1);
    expect(settlements).toBe(1);
  });

  test("missing key resets any prior runtime and configured boot reset is symmetric", () => {
    expect(installProductionMediaGenerationRuntime({
      resolveKey: () => "venice-secret",
      db: authorityDb(),
      dbOperations: operations().dbOperations,
      fetchImpl: providerFetch().fetchImpl,
    })).toBe(true);
    expect(hasMediaGenerationApprovalRuntime()).toBe(true);

    expect(installProductionMediaGenerationRuntime({ resolveKey: () => null })).toBe(true);
    expect(hasMediaGenerationApprovalRuntime()).toBe(true);

    expect(installProductionMediaGenerationRuntime({
      resolveKey: () => "venice-secret",
      db: authorityDb(),
      dbOperations: operations().dbOperations,
      fetchImpl: providerFetch().fetchImpl,
    })).toBe(true);
    resetProductionMediaGenerationRuntime();
    expect(hasMediaGenerationApprovalRuntime()).toBe(false);
  });

  test("DB adapter preserves the exact deterministic refusal state and actions", async () => {
    let refusalSeen: MediaGenerationAdmissionRefusal | undefined;
    const state = operations({ onRefusal: (refusal) => { refusalSeen = refusal; } });
    const repository = createMediaGenerationDbRepository(authorityDb(), state.dbOperations);
    const createInput = {
      ...scope,
      receiptId: `mg_${"a".repeat(64)}`,
      initiatingAgentId: actor.agentId,
      initiatingThreadId: preparation.threadId,
      kind: "video" as const,
      provider: "venice" as const,
      providerModel: "seedance-2-5-text-to-video-basic",
      providerAccountFingerprint: "a".repeat(32),
      fundingBinding: {
        humanUserId: scope.ownerId,
        provider: "venice" as const,
        binding: { kind: "server" as const, providerRoute: "venice" },
        credentialFingerprint: "a".repeat(32),
      },
      approvalDigest: "b".repeat(64),
      quoteDigest: "c".repeat(64),
      safeSnapshot: { version: 1 as const, normalizedSettings: {}, inputSummary: { promptCharacters: 4 } },
      requestPayload: { version: 1 as const, model: "seedance-2-5-text-to-video-basic", prompt: "test", normalizedSettings: {} },
      quotedUsdMicros: 410_000,
    };
    await repository.reserve(createInput);
    const proof = await repository.beginAdmission(scope, createInput.receiptId, 0);
    expect(proof).not.toBeNull();
    await repository.recordRefused(proof!, {
      state: "needs_action",
      safeFailure: {
        code: "VENICE_ACCESS",
        phase: "queue",
        retrySafe: false,
        stateChanged: false,
        completionCertainty: "not_started",
        chargeCertainty: "not_charged",
        recoveryActions: ["repair_account", "switch_model"],
      },
    });
    expect(refusalSeen?.state).toBe("needs_action");
    expect(refusalSeen?.safeFailure.code).toBe("VENICE_ACCESS");
    expect(refusalSeen?.safeFailure.recoveryActions).toEqual(["repair_account", "switch_model"]);
    expect(state.read()?.state).toBe("needs_action");
  });

  test("rotated account fingerprint fails closed before paid queue admission", async () => {
    const state = operations({ rotateFingerprint: true });
    const provider = providerFetch();
    const runtime = createProductionMediaGenerationRuntime({
      apiKey: "venice-secret",
      getCapabilities: mediaCapabilities,
      db: authorityDb(),
      dbOperations: state.dbOperations,
      fetchImpl: provider.fetchImpl,
    });
    const result = await runtime.prepare(actor, preparation);

    expect(result).toEqual({
      ok: false,
      code: "quote_binding_failed",
      recovery: "The durable quote changed. Request a fresh generation; no new generation was started.",
    });
    expect(provider.requests.filter((request) => request.url.endsWith("/video/queue"))).toHaveLength(0);
  });

  test("denies an exact quote before provider dispatch when no funding source can be opened", async () => {
    const provider = providerFetch();
    const runtime = createProductionMediaGenerationRuntime({
      getCapabilities: mediaCapabilities,
      db: authorityDb(),
      dbOperations: operations().dbOperations,
      fetchImpl: provider.fetchImpl,
      openFunding: async () => { throw new Error("funding unavailable"); },
    });

    expect(await runtime.prepare(actor, preparation)).toMatchObject({ ok: false, code: "quote_unavailable" });
    expect(provider.requests).toHaveLength(0);
  });

  test("reopens the exact durable funding source before queue admission", async () => {
    const state = operations();
    const provider = providerFetch();
    const funding = {
      humanUserId: actor.userId,
      provider: "venice" as const,
      binding: { kind: "server" as const, providerRoute: "venice" },
      credentialFingerprint: "a".repeat(32),
    };
    let attempts = 0;
    const runtime = createProductionMediaGenerationRuntime({
      getCapabilities: mediaCapabilities,
      db: authorityDb(),
      dbOperations: state.dbOperations,
      fetchImpl: provider.fetchImpl,
      openFunding: async (_humanUserId, modelId, family) => ({
        modelId, family, funding,
        runAttempt: async () => { throw new Error("unused test attempt"); },
      }),
      runFunding: async (_binding, _intent, callback) => {
        attempts += 1;
        if (attempts > 1) throw new Error("creating credential revoked");
        return callback({
          apiKey: "venice-secret",
          usageFunding: { kind: "server", humanUserId: actor.userId, providerRoute: "venice" },
        });
      },
      beginCostAttempt: async () => undefined,
      settleCostAttempt: async () => undefined,
    });
    const prepared = await runtime.prepare(actor, preparation);
    if (!prepared.ok) throw new Error(prepared.recovery);

    expect(await runtime.submit(actor, submitInput(prepared))).toMatchObject({
      queueStarted: false,
      state: "needs-action",
    });
    expect(provider.requests.filter((request) => request.url.endsWith("/video/queue"))).toHaveLength(0);
    expect(state.read()?.state).toBe("needs_action");
  });

  test("public result contains no provider topology and signed delivery is fenced unknown", async () => {
    for (const signedDelivery of [false, true]) {
      const state = operations();
      const provider = providerFetch({ signedDelivery });
      const runtime = createProductionMediaGenerationRuntime({
        apiKey: "venice-secret",
        getCapabilities: mediaCapabilities,
        db: authorityDb(),
        dbOperations: state.dbOperations,
        fetchImpl: provider.fetchImpl,
        veniceSignedDeliveryAllowedHosts: ["delivery.example"],
      });
      const prepared = await runtime.prepare(actor, preparation);
      if (!prepared.ok) throw new Error(prepared.recovery);
      const result = await runtime.submit(actor, submitInput(prepared));
      const publicJson = JSON.stringify(result);
      expect(result.queueStarted).toBe(signedDelivery ? null : true);
      expect(result.state).toBe(signedDelivery ? "unknown" : "queued");
      expect(publicJson).not.toContain("provider-queue-secret");
      expect(publicJson).not.toContain("delivery.example");
      expect(publicJson).not.toContain("signature=secret");
      expect(publicJson).not.toContain(creativePrompt);
      expect(publicJson).not.toContain(privatePromptTail);
      expect(state.read()?.state).toBe(signedDelivery ? "unknown" : "queued");
      if (signedDelivery) {
        const replay = await runtime.submit(actor, submitInput(prepared));
        expect(replay).toEqual(result);
        expect(provider.requests.filter((request) => request.url.endsWith("/video/queue"))).toHaveLength(1);
      }
    }
  });
});
