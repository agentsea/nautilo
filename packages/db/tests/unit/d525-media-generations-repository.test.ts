import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertMediaGenerationSafeSnapshot,
  assertMediaGenerationRequestPayload,
  beginMediaGenerationAdmission,
  claimDueMediaGenerations,
  completeClaimedMediaGenerationCleanup,
  MEDIA_GENERATION_RECONCILABLE_STATES,
  readClaimedMediaGeneration,
  recordMediaGenerationAccepted,
  recordMediaGenerationAdmissionRefused,
  releaseMediaGenerationClaim,
  renewMediaGenerationClaim,
  rescheduleClaimedMediaGeneration,
  rescheduleClaimedMediaGenerationCleanup,
  transitionClaimedMediaGeneration,
  transitionMediaGeneration,
} from "../../src/queries/media-generations";

const source = readFileSync(
  resolve(import.meta.dir, "../../src/queries/media-generations.ts"),
  "utf8",
);
const scope = { ownerId: "owner", roomId: "room", namespaceId: "namespace", receiptId: "mg_opaque" };
const workerScope = { ...scope, workerId: "worker", expectedRevision: 4, now: new Date("2026-08-14T12:00:00.000Z") };
const retryFailure = {
  code: "VENICE_RETRIEVE_UNAVAILABLE",
  phase: "retrieve" as const,
  retrySafe: true,
  stateChanged: false,
  completionCertainty: "accepted" as const,
  chargeCertainty: "charged" as const,
  recoveryActions: ["retry_same_receipt"] as const,
};

async function captureRejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected operation to reject");
}

describe("D525 media generation repository", () => {
  test("rejects an illegal lifecycle edge before issuing a database write", async () => {
    const error = await captureRejection(transitionMediaGeneration(null as never, {
      ...scope, expectedRevision: 0, from: "ready", to: "saving",
    }));
    expect(error.message).toContain("illegal media generation transition ready -> saving");
  });

  test("never allows a caller to jump directly from prequeue to queued", async () => {
    const error = await captureRejection(transitionMediaGeneration(null as never, {
      ...scope, expectedRevision: 0, from: "prequeue", to: "queued",
    }));
    expect(error.message).toContain("illegal media generation transition prequeue -> queued");
  });

  test("keeps admitting terminal edges behind the DB-minted proof API", async () => {
    const error = await captureRejection(transitionMediaGeneration(null as never, {
      ...scope, expectedRevision: 1, from: "admitting", to: "failed",
    }));
    expect(error.message).toContain("illegal media generation transition admitting -> failed");
  });

  test("atomically mints the durable provider-admission proof", async () => {
    let updatePatch: Record<string, unknown> | undefined;
    const chain = {
      set(patch: Record<string, unknown>) { updatePatch = patch; return chain; },
      where() { return chain; },
      returning: async () => [{
        kind: "video" as const,
        providerModel: "seedance-2-5-text-to-video-basic",
        requestPayload: {
          version: 1 as const,
          model: "seedance-2-5-text-to-video-basic",
          prompt: "A storm at sea",
          normalizedSettings: { durationSeconds: 5 },
        },
      }],
    };
    const db = { update: () => chain } as never;
    const proof = await beginMediaGenerationAdmission(db, { ...scope, expectedRevision: 0 });
    expect(proof?.revision).toBe(1);
    expect(proof?.admissionToken).toMatch(/^[0-9a-f-]{36}$/u);
    expect(updatePatch).toMatchObject({ state: "admitting", revision: 1 });
    expect(updatePatch?.["admissionToken"]).toBe(proof?.admissionToken);
    expect(source).toContain('eq(mediaGenerations.state, "prequeue")');
    expect(source).toContain("isNull(mediaGenerations.admissionToken)");
    const forged = await captureRejection(recordMediaGenerationAccepted(null as never, {
      ...scope,
      revision: 1,
      admissionToken: "53c1748b-baa9-430f-a86d-31f45216bbfb",
      kind: "video",
      providerModel: "seedance-2-5-text-to-video-basic",
      requestPayload: {
        version: 1,
        model: "seedance-2-5-text-to-video-basic",
        prompt: "A storm at sea",
        normalizedSettings: {},
      },
    } as never, "provider-queue"));
    expect(forged.message).toContain("DB-minted admission proof");
  });

  test("records a deterministic 422 policy refusal with refund facts only", async () => {
    let updatePatch: Record<string, unknown> | undefined;
    const chain = {
      set(patch: Record<string, unknown>) { updatePatch = patch; return chain; },
      where() { return chain; },
      returning: async () => [{ state: "failed", revision: 2 }],
    };
    const proof = await beginMediaGenerationAdmission({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{
        kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
        requestPayload: { version: 1, model: "seedance-2-5-text-to-video-basic", prompt: "storm", normalizedSettings: {} },
      }] }) }),
    }) } as never, { ...scope, expectedRevision: 0 });
    expect(proof).not.toBeNull();
    const row = await recordMediaGenerationAdmissionRefused(
      { update: () => chain } as never,
      proof!,
      {
        state: "failed",
        safeFailure: {
          code: "VENICE_CONTENT_POLICY", phase: "queue", retrySafe: false,
          stateChanged: false, completionCertainty: "not_started", chargeCertainty: "refunded",
          creditsRefunded: true, recoveryActions: ["revise", "switch_model"],
        },
      },
    );
    expect(row).toMatchObject({ state: "failed", revision: 2 });
    expect(updatePatch).toMatchObject({
      state: "failed", revision: 2, claimOwner: null, claimExpiresAt: null,
      safeFailure: { code: "VENICE_CONTENT_POLICY", creditsRefunded: true },
    });
    expect(updatePatch).not.toHaveProperty("admissionToken");
    expect(updatePatch).not.toHaveProperty("admissionStartedAt");
  });

  test("records deterministic 409 consent as needs action", async () => {
    let updatePatch: Record<string, unknown> | undefined;
    const chain = {
      set(patch: Record<string, unknown>) { updatePatch = patch; return chain; },
      where() { return chain; }, returning: async () => [{ state: "needs_action", revision: 2 }],
    };
    const proof = await beginMediaGenerationAdmission({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{
        kind: "music", providerModel: "minimax-music-2.0",
        requestPayload: { version: 1, model: "minimax-music-2.0", prompt: "anthem", normalizedSettings: {} },
      }] }) }),
    }) } as never, { ...scope, expectedRevision: 0 });
    const row = await recordMediaGenerationAdmissionRefused({ update: () => chain } as never, proof!, {
      state: "needs_action",
      safeFailure: {
        code: "VENICE_NEEDS_CONSENT", phase: "queue", retrySafe: false,
        stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
        recoveryActions: ["repair_account", "switch_model"],
      },
    });
    expect(row?.state).toBe("needs_action");
    expect(updatePatch).toMatchObject({ state: "needs_action", revision: 2, claimOwner: null, claimExpiresAt: null });
  });

  test("closes every documented deterministic settings and account refusal", async () => {
    const proof = await beginMediaGenerationAdmission({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{
        kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
        requestPayload: { version: 1, model: "seedance-2-5-text-to-video-basic", prompt: "storm", normalizedSettings: {} },
      }] }) }),
    }) } as never, { ...scope, expectedRevision: 0 });
    const cases = [
      { code: "VENICE_INVALID_REQUEST", state: "failed", retrySafe: false, actions: ["revise"] },
      { code: "VENICE_PAYLOAD_TOO_LARGE", state: "failed", retrySafe: false, actions: ["revise"] },
      { code: "VENICE_UNSUPPORTED_MEDIA", state: "failed", retrySafe: false, actions: ["revise"] },
      { code: "VENICE_AUTHENTICATION", state: "needs_action", retrySafe: true, actions: ["repair_account"] },
      { code: "VENICE_BILLING", state: "needs_action", retrySafe: true, actions: ["repair_account"] },
      { code: "VENICE_ACCESS", state: "needs_action", retrySafe: false, actions: ["repair_account", "switch_model"] },
    ] as const;
    for (const refusalCase of cases) {
      let updatePatch: Record<string, unknown> | undefined;
      const chain = {
        set(patch: Record<string, unknown>) { updatePatch = patch; return chain; },
        where() { return chain; }, returning: async () => [{ state: refusalCase.state, revision: 2 }],
      };
      const row = await recordMediaGenerationAdmissionRefused({ update: () => chain } as never, proof!, {
        state: refusalCase.state,
        safeFailure: {
          code: refusalCase.code, phase: "queue", retrySafe: refusalCase.retrySafe,
          stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
          recoveryActions: refusalCase.actions,
        },
      });
      expect(row?.state).toBe(refusalCase.state);
      expect(updatePatch).toMatchObject({ state: refusalCase.state, revision: 2, claimOwner: null, claimExpiresAt: null });
    }
  });

  test("terminalizes observed rate and capacity responses with fresh-quote recovery only", async () => {
    const proof = await beginMediaGenerationAdmission({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{
        kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
        requestPayload: { version: 1, model: "seedance-2-5-text-to-video-basic", prompt: "storm", normalizedSettings: {} },
      }] }) }),
    }) } as never, { ...scope, expectedRevision: 0 });
    for (const code of ["VENICE_RATE_LIMITED", "VENICE_CAPACITY"] as const) {
      let updatePatch: Record<string, unknown> | undefined;
      const chain = {
        set(patch: Record<string, unknown>) { updatePatch = patch; return chain; },
        where() { return chain; }, returning: async () => [{ state: "failed", revision: 2 }],
      };
      await recordMediaGenerationAdmissionRefused({ update: () => chain } as never, proof!, {
        state: "failed",
        safeFailure: {
          code, phase: "queue", retrySafe: true, stateChanged: false,
          completionCertainty: "not_started", chargeCertainty: "not_charged",
          recoveryActions: ["start_fresh"],
        },
      });
      expect(updatePatch).toMatchObject({
        state: "failed",
        safeFailure: { code, retrySafe: true, recoveryActions: ["start_fresh"] },
      });
    }

    const unsafeSameReceipt = await captureRejection(recordMediaGenerationAdmissionRefused(null as never, proof!, {
      state: "failed",
      safeFailure: {
        code: "VENICE_RATE_LIMITED", phase: "queue", retrySafe: true, stateChanged: false,
        completionCertainty: "not_started", chargeCertainty: "not_charged",
        recoveryActions: ["retry_same_receipt"],
      },
    }));
    expect(unsafeSameReceipt.message).toContain("unsupported deterministic admission refusal");
  });

  test("refusal proof and revision CAS fail closed and ambiguous admission is rejected", async () => {
    const proof = await beginMediaGenerationAdmission({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{
        kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
        requestPayload: { version: 1, model: "seedance-2-5-text-to-video-basic", prompt: "storm", normalizedSettings: {} },
      }] }) }),
    }) } as never, { ...scope, expectedRevision: 0 });
    const policyRefusal = {
      state: "failed" as const,
      safeFailure: {
        code: "VENICE_CONTENT_POLICY", phase: "queue" as const, retrySafe: false,
        stateChanged: false, completionCertainty: "not_started" as const, chargeCertainty: "unknown" as const,
        recoveryActions: ["revise", "switch_model"] as const,
      },
    };
    const stale = await recordMediaGenerationAdmissionRefused({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }) } as never, proof!, policyRefusal);
    expect(stale).toBeNull();

    const tampered = await recordMediaGenerationAdmissionRefused({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }) } as never, { ...proof!, admissionToken: "00000000-0000-0000-0000-000000000000" }, policyRefusal);
    expect(tampered).toBeNull();
    expect(source).toContain("eq(mediaGenerations.admissionToken, proof.admissionToken)");
    expect(source).toContain("eq(mediaGenerations.revision, proof.revision)");

    const ambiguous = await captureRejection(recordMediaGenerationAdmissionRefused(null as never, proof!, {
      state: "failed",
      safeFailure: {
        code: "VENICE_QUEUE_COMPLETION_UNKNOWN", phase: "queue", retrySafe: false,
        stateChanged: true, completionCertainty: "unknown", chargeCertainty: "unknown",
        recoveryActions: ["start_fresh"],
      },
    }));
    expect(ambiguous.message).toContain("ambiguous provider admission must use the unknown fence");
  });

  test("bounds worker claims and uses transactional skip-locked claiming", async () => {
    const error = await captureRejection(claimDueMediaGenerations(null as never, {
      workerId: "worker", now: new Date(), batch: 33,
    }));
    expect(error.message).toContain("batch must be between 1 and 32");
    expect(source).toContain('for("update", { skipLocked: true })');
    expect(source).toContain("eq(mediaGenerations.ownerId, scope.ownerId)");
    expect(source).toContain("eq(mediaGenerations.namespaceId, scope.namespaceId)");
    expect(source).toContain("eq(mediaGenerations.revision, input.expectedRevision)");
    expect(MEDIA_GENERATION_RECONCILABLE_STATES).toEqual(["queued", "retrieving", "saving"]);
    expect(MEDIA_GENERATION_RECONCILABLE_STATES).not.toContain("admitting" as never);
    expect(source).toContain('eq(mediaGenerations.state, "admitting")');
    expect(source).toContain("eq(mediaGenerations.admissionToken, proof.admissionToken)");
  });

  test("claims only the worker-required internal coordinates, never creative payloads", async () => {
    let returningFields: Record<string, unknown> | undefined;
    const updateChain = {
      set() { return updateChain; },
      where() { return updateChain; },
      returning(fields: Record<string, unknown>) {
        returningFields = fields;
        return [{
          receiptId: "mg_opaque", ownerId: "owner", roomId: "room", namespaceId: "namespace",
          state: "queued", revision: 4, kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
          providerQueueId: "private-provider-queue", providerExecutionSeconds: null, providerAverageExecutionSeconds: null,
          artifactInternalId: null, cleanupState: "pending",
        }];
      },
    };
    const selectChain = {
      from() { return selectChain; }, where() { return selectChain; }, orderBy() { return selectChain; },
      limit() { return selectChain; }, for() { return [{ id: "row" }]; },
    };
    const db = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ select: () => selectChain, update: () => updateChain }),
    } as never;
    const claimed = await claimDueMediaGenerations(db, { workerId: "worker", now: workerScope.now });
    expect(claimed).toHaveLength(1);
    expect(Object.keys(returningFields ?? {}).sort()).toEqual([
      "artifactInternalId", "cleanupState", "initiatingAgentId", "kind", "namespaceId", "ownerId",
      "providerAverageExecutionSeconds", "providerExecutionSeconds", "providerModel", "providerQueueId",
      "receiptId", "revision", "roomId", "state",
    ]);
    expect(Object.keys(claimed[0] ?? {}).sort()).not.toContain("requestPayload");
    expect(Object.keys(claimed[0] ?? {}).sort()).not.toContain("safeSnapshot");
  });

  test("re-reads and renews only a live exact-worker claim", async () => {
    let selectFields: Record<string, unknown> | undefined;
    const readChain = {
      from() { return readChain; }, where() { return readChain; }, limit: async () => [{
        receiptId: "mg_opaque", ownerId: "owner", roomId: "room", namespaceId: "namespace",
        state: "queued", revision: 4, kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
        providerQueueId: "private-provider-queue", providerExecutionSeconds: null, providerAverageExecutionSeconds: null,
        artifactInternalId: null, cleanupState: "pending",
      }],
    };
    const reRead = await readClaimedMediaGeneration({ select: (fields: Record<string, unknown>) => {
      selectFields = fields;
      return readChain;
    } } as never, { ...scope, workerId: "worker" });
    expect(reRead?.providerQueueId).toBe("private-provider-queue");
    expect(Object.keys(selectFields ?? {}).sort()).not.toContain("requestPayload");

    let renewalPatch: Record<string, unknown> | undefined;
    const renewalChain = {
      set(patch: Record<string, unknown>) { renewalPatch = patch; return renewalChain; },
      where() { return renewalChain; }, returning: async () => [{
        receiptId: "mg_opaque", ownerId: "owner", roomId: "room", namespaceId: "namespace",
        state: "queued", revision: 5, kind: "video", providerModel: "seedance-2-5-text-to-video-basic",
        providerQueueId: "private-provider-queue", artifactInternalId: null, cleanupState: "pending",
      }],
    };
    const renewed = await renewMediaGenerationClaim({ update: () => renewalChain } as never, {
      ...workerScope, state: "queued",
    });
    expect(renewed?.revision).toBe(5);
    expect(renewalPatch?.["claimExpiresAt"]).toEqual(new Date("2026-08-14T12:01:00.000Z"));
    expect(renewalPatch?.["revision"]).toBe(5);
    expect(source).toContain("eq(mediaGenerations.claimOwner, input.workerId)");
    expect(source).toContain("gt(mediaGenerations.claimExpiresAt, now)");

    const stale = await renewMediaGenerationClaim({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }) } as never, { ...workerScope, state: "queued" });
    expect(stale).toBeNull();
  });

  test("uses claim-owner/revision/state CAS for transitions and releases terminal claims", async () => {
    let runningPatch: Record<string, unknown> | undefined;
    const runningChain = {
      set(patch: Record<string, unknown>) { runningPatch = patch; return runningChain; },
      where() { return runningChain; }, returning: async () => [{ id: "row" }],
    };
    await transitionClaimedMediaGeneration({ update: () => runningChain } as never, {
      ...workerScope, from: "queued", to: "retrieving",
    });
    expect(runningPatch?.["state"]).toBe("retrieving");
    expect(runningPatch?.["claimOwner"]).toBeUndefined();

    let terminalPatch: Record<string, unknown> | undefined;
    const terminalChain = {
      set(patch: Record<string, unknown>) { terminalPatch = patch; return terminalChain; },
      where() { return terminalChain; }, returning: async () => [{ id: "row" }],
    };
    await transitionClaimedMediaGeneration({ update: () => terminalChain } as never, {
      ...workerScope, from: "queued", to: "failed", safeFailure: retryFailure, terminalAt: workerScope.now,
    });
    expect(terminalPatch).toMatchObject({ state: "failed", claimOwner: null, claimExpiresAt: null, revision: 5 });
    expect(source).toContain("claimedWhere(claimedInput, now)");
  });

  test("schedules only the owned accepted receipt and keeps cleanup pending on cleanup retry", async () => {
    let retryPatch: Record<string, unknown> | undefined;
    const retryChain = {
      set(patch: Record<string, unknown>) { retryPatch = patch; return retryChain; },
      where() { return retryChain; }, returning: async () => [{ id: "row" }],
    };
    const scheduled = await rescheduleClaimedMediaGeneration({ update: () => retryChain } as never, {
      ...workerScope, state: "queued", safeFailure: retryFailure,
      processingTiming: { elapsedSeconds: 19, estimatedSeconds: 146 },
      nextAttemptAt: new Date("2026-08-14T12:00:05.000Z"),
    });
    expect(scheduled).toBe(true);
    expect(retryPatch).toMatchObject({ safeFailure: retryFailure, revision: 5, claimOwner: null, claimExpiresAt: null });
    expect(retryPatch?.["nextAttemptAt"]).toEqual(new Date("2026-08-14T12:00:05.000Z"));
    expect(retryPatch).toMatchObject({ providerExecutionSeconds: 19, providerAverageExecutionSeconds: 146 });

    const invalid = await captureRejection(rescheduleClaimedMediaGeneration({ update: () => retryChain } as never, {
      ...workerScope, state: "queued", safeFailure: retryFailure,
      processingTiming: { elapsedSeconds: 2_147_483_648 },
      nextAttemptAt: new Date("2026-08-14T12:00:05.000Z"),
    }));
    expect(invalid.message).toContain("processing elapsedSeconds must be a bounded nonnegative integer");

    let cleanupPatch: Record<string, unknown> | undefined;
    const cleanupChain = {
      set(patch: Record<string, unknown>) { cleanupPatch = patch; return cleanupChain; },
      where() { return cleanupChain; }, returning: async () => [],
    };
    const wrongWorker = await rescheduleClaimedMediaGenerationCleanup({ update: () => cleanupChain } as never, {
      ...workerScope, safeFailure: { ...retryFailure, phase: "cleanup" },
      nextAttemptAt: new Date("2026-08-14T12:00:05.000Z"),
    });
    expect(wrongWorker).toBe(false);
    expect(cleanupPatch).toMatchObject({ revision: 5, claimOwner: null, claimExpiresAt: null });
    expect(cleanupPatch?.["cleanupState"]).toBeUndefined();

    const completion = await completeClaimedMediaGenerationCleanup({ update: () => ({
      set: (patch: Record<string, unknown>) => { cleanupPatch = patch; return { where: () => ({ returning: async () => [] }) }; },
    }) } as never, workerScope);
    expect(completion).toBeNull();
    expect(cleanupPatch).toMatchObject({ cleanupState: "completed", safeFailure: null });
    expect(source).toContain('eq(mediaGenerations.cleanupState, "pending")');
  });

  test("advances revision exactly once for every claim mutation, including claim and legacy release", async () => {
    const updateSegments = source.split(/(?:db|tx)\.update\(mediaGenerations\)/u).slice(1);
    expect(updateSegments).toHaveLength(16);
    for (const segment of updateSegments) {
      const setThroughWhere = segment.slice(0, segment.indexOf(".where("));
      expect(setThroughWhere).toContain("revision:");
    }
    expect(source).toContain("revision: sql`${mediaGenerations.revision} + 1`");

    let releasePatch: Record<string, unknown> | undefined;
    const releaseChain = {
      set(patch: Record<string, unknown>) { releasePatch = patch; return releaseChain; },
      where() { return releaseChain; }, returning: async () => [{ id: "row" }],
    };
    const released = await releaseMediaGenerationClaim({ update: () => releaseChain } as never, {
      ...workerScope, nextAttemptAt: new Date("2026-08-14T12:00:05.000Z"),
    });
    expect(released).toBe(true);
    expect(releasePatch).toMatchObject({ revision: 5, claimOwner: null, claimExpiresAt: null });

    const staleRelease = await releaseMediaGenerationClaim({ update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }) } as never, { ...workerScope, nextAttemptAt: new Date("2026-08-14T12:00:05.000Z") });
    expect(staleRelease).toBe(false);
  });

  test("rejects creative text and nested provider fields from the safe snapshot", () => {
    expect(() => assertMediaGenerationSafeSnapshot({
      version: 1,
      normalizedSettings: { resolution: "720p", prompt: "creative text" },
      inputSummary: { promptCharacters: 13 },
    } as never)).toThrow("safeSnapshot.normalizedSettings contains an unsafe field");
    expect(() => assertMediaGenerationSafeSnapshot({
      version: 1,
      normalizedSettings: { resolution: "https://provider.example/signed" },
      inputSummary: { promptCharacters: 13 },
    } as never)).toThrow("safeSnapshot.normalizedSettings has an invalid value");
    expect(() => assertMediaGenerationSafeSnapshot({
      version: 1,
      normalizedSettings: {},
      inputSummary: { promptCharacters: 13, referenceAssetCount: 1 },
    } as never)).toThrow("safeSnapshot.inputSummary must contain counts only");
  });

  test("retains only the exact approved creative request in the internal payload", () => {
    expect(() => assertMediaGenerationRequestPayload({
      version: 1,
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A storm at sea",
      lyrics: "",
      normalizedSettings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9" },
    }, "seedance-2-5-text-to-video-basic")).not.toThrow();
    expect(() => assertMediaGenerationRequestPayload({
      version: 1,
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A storm at sea",
      normalizedSettings: { queueId: "provider-queue" },
    } as never, "seedance-2-5-text-to-video-basic")).toThrow(
      "requestPayload.normalizedSettings contains an unsafe field",
    );
    expect(() => assertMediaGenerationRequestPayload({
      version: 1,
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A storm at sea",
      downloadUrl: "https://provider.example/signed",
      normalizedSettings: {},
    } as never, "seedance-2-5-text-to-video-basic")).toThrow(
      "requestPayload must be an exact approved v1 request",
    );
  });

  test("accepts exact audio bindings only for Seedance reference receipts", () => {
    const referenceImages = [{ path: "references/frame.png", artifactId: "frame",
      artifactInternalId: "11111111-1111-4111-8111-111111111111", revision: 1,
      mimeType: "image/png", sizeBytes: 100, sha256: "a".repeat(64) }];
    const referenceAudios = [{ path: "references/voice.wav", artifactId: "voice",
      artifactInternalId: "22222222-2222-4222-8222-222222222222", revision: 2,
      mimeType: "audio/x-wav" as const, sizeBytes: 1_000, sha256: "b".repeat(64), durationSeconds: 3 }];
    const payload = { version: 1 as const, model: "seedance-2-5-reference-to-video-basic", prompt: "Use <Image 1> and <Audio 1>",
      referenceImages, referenceAudios, normalizedSettings: { durationSeconds: 5 } };
    expect(() => assertMediaGenerationRequestPayload(payload, payload.model)).not.toThrow();
    expect(() => assertMediaGenerationRequestPayload({ ...payload,
      referenceAudios: [{ ...referenceAudios[0]!, durationSeconds: 31 }] }, payload.model)).toThrow("Invalid reference audio binding");
    expect(() => assertMediaGenerationRequestPayload({ ...payload,
      referenceAudios: Array.from({ length: 10 }, (_, index) => ({ ...referenceAudios[0]!, path: `references/${index}.wav`, durationSeconds: 4 })) }, payload.model)).toThrow("duration exceeds");
    expect(() => assertMediaGenerationRequestPayload({ ...payload, referenceImages: [] }, payload.model)).toThrow("Reference media missing");
    expect(() => assertMediaGenerationRequestPayload({ ...payload, model: "seedance-2-5-text-to-video-basic" }, "seedance-2-5-text-to-video-basic")).toThrow("References require reference model");
    const longPath = "refs/" + "a".repeat(4_087) + ".wav";
    expect(longPath).toHaveLength(4_096);
    expect(() => assertMediaGenerationRequestPayload({ ...payload,
      referenceAudios: [{ ...referenceAudios[0]!, path: longPath }] }, payload.model)).not.toThrow();
    expect(() => assertMediaGenerationRequestPayload({ ...payload,
      referenceAudios: [{ ...referenceAudios[0]!, path: `${longPath}x` }] }, payload.model)).toThrow("Invalid immutable audio identity");
  });

  test.each([513, 4_096])("preserves canonical %i-character image and video binding paths at reservation", (length) => {
    const imagePath = "refs/" + "a".repeat(length - 9) + ".png";
    const videoPath = "refs/" + "v".repeat(length - 9) + ".mp4";
    const image = { path: imagePath, artifactId: "frame", artifactInternalId: "11111111-1111-4111-8111-111111111111",
      revision: 1, mimeType: "image/png", sizeBytes: 100, sha256: "a".repeat(64) };
    const video = { ...image, path: videoPath, artifactId: "motion", artifactInternalId: "22222222-2222-4222-8222-222222222222",
      mimeType: "video/mp4", durationSeconds: 3 };
    const payload = { version: 1 as const, model: "seedance-2-5-reference-to-video-basic", prompt: "Use long references",
      referenceImages: [image], referenceVideos: [video], normalizedSettings: { durationSeconds: 5 } };
    expect(imagePath).toHaveLength(length);
    expect(videoPath).toHaveLength(length);
    expect(() => assertMediaGenerationRequestPayload(payload, payload.model)).not.toThrow();
  });
});
