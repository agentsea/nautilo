import { describe, test, expect, afterEach } from "bun:test";
import { Job } from "../../src/job";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent, JobStatus, JobStatusEvent } from "@nautilo/types";
import type { FriendlyErrorCategory, MdlCode } from "@nautilo/agent";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import { prepareForegroundEncryptedContext } from
  "../../src/conversation/foreground-context-preparation";

/**
 * D141 Phase 1 — privacy contract for `job.status: failed`.
 *
 * `job.status` is routed by `laneKey: "room:<uuid>"` and broadcast to
 * every WS client whose `roomIds` set contains that room (see
 * `packages/server/src/realtime/ws-publisher.ts`'s `inferDeliveryScope`).
 * In a multi-user room, every member receives the event. The upstream
 * provider `error.message` field can echo prompt content or model
 * output (`packages/agent/src/providers/errors.ts` SECURITY note),
 * so we MUST NOT carry `formatProviderError`'s output on the
 * room-broadcast event. These tests pin that contract.
 */

interface TrackedStatusUpdate {
  jobId: string;
  status: JobStatus;
  fields?: { message?: string; result?: Record<string, unknown> };
}

function trackStatus() {
  const updates: TrackedStatusUpdate[] = [];
  return {
    updates,
    async fn(jobId: string, status: JobStatus, fields?: TrackedStatusUpdate["fields"]) {
      updates.push({ jobId, status, ...(fields !== undefined ? { fields } : {}) });
    },
  };
}

function captureBusEvents() {
  const events: ServerEvent[] = [];
  const handler = (event: ServerEvent) => events.push(event);
  eventBus.on(handler);
  return {
    events,
    cleanup: () => eventBus.off(handler),
  };
}

const PROMPT_LEAK_FRAGMENT = "ECHO_OF_USER_PROMPT_CONTENT_THAT_MUST_NOT_LEAK";

async function* throwUpstreamLikeError(): AsyncGenerator<ServerEvent> {
  // Shape mirroring an OpenAI `APIError` whose `error.message` echoes
  // the user's prompt back — exactly the leak scenario D141-P1 prevents.
  // formatProviderError (kept for server-log only) WILL include this
  // fragment in `detailsForLog`; the room-broadcast WS event MUST NOT.
  const apiErrorLike = Object.assign(new Error("upstream rejected"), {
    status: 400,
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: `Prompt too long: ${PROMPT_LEAK_FRAGMENT}`,
    },
  });
  yield {
    type: "message.tokens",
    laneKey: "room:11111111-1111-4111-8111-111111111111",
    content: "partial token",
    chunkSequence: 1,
    done: false,
  };
  throw apiErrorLike;
}

describe("Job — D141 friendly-error privacy contract", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  test("failed job emits friendly primary message + stable category on room-scoped WS event", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => throwUpstreamLikeError(),
      persist: async () => "job-1",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failed = cap.events.find(
      (e): e is JobStatusEvent => e.type === "job.status" && e.status === "failed",
    );
    expect(failed).toBeDefined();
    // Friendly primary message is one of the seven canned sentences.
    expect(failed?.message).toBeDefined();
    expect(failed?.message?.length).toBeGreaterThan(0);
    expect(failed?.message?.length).toBeLessThan(200);
    // The OpenAI-shaped error with status=400 + context_length_exceeded
    // classifies as `context_exceeded` via the friendly translator.
    expect(failed?.errorCategory).toBe("context_exceeded");
    // Lane routing preserved so the workbench renders in the right room.
    expect(failed?.laneKey).toBe("room:11111111-1111-4111-8111-111111111111");
    // ISSUE-D141 §LD-9 — message ends with bracketed MDL00x code so
    // the chat surface is greppable / pasteable. context_exceeded =
    // MDL005 per CATEGORY_CODES.
    expect(failed?.message?.endsWith("[MDL005]")).toBe(true);
  });

  test("Strict Shadow rejection is not presented as a model failure", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;

    async function* rejectStrictShadow(): AsyncGenerator<ServerEvent> {
      yield {
        type: "message.tokens",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
        content: "",
        chunkSequence: 1,
        done: false,
      };
      throw Object.assign(new Error("private boundary detail"), {
        code: "strict_shadow_protected_content_required",
      });
    }

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => rejectStrictShadow(),
      persist: async () => "job-strict-shadow",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failed = cap.events.find(
      (e): e is JobStatusEvent => e.type === "job.status" && e.status === "failed",
    );
    expect(failed?.message).toContain("Encrypted history is not available");
    expect(failed?.message).toContain("Fallback Shadow");
    expect(failed?.message).not.toContain("reaching the model");
    expect(failed?.message).not.toContain("private boundary detail");
  });

  test("protected authorization expiry uses the existing timeout wire contract", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;

    async function* rejectExpiredAuthorization(): AsyncGenerator<ServerEvent> {
      yield* [] as ServerEvent[];
      throw new StrictShadowEnforcementError({
        boundaryId: "conversation.write.runtime_persist",
        family: "message",
        operation: "write",
        actorClass: "agent",
        state: "failed",
        reason: "deadline_expired",
        retryable: false,
        policyRevision: 8,
      });
    }

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => rejectExpiredAuthorization(),
      persist: async () => "job-protected-deadline-expired",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failed = cap.events.find(
      (event): event is JobStatusEvent =>
        event.type === "job.status" && event.status === "failed",
    );
    expect(failed).toMatchObject({
      errorCategory: "timeout",
      message:
        "The encryption authorization expired before this turn finished. Please try again. [MDL001]",
    });
    expect(failed?.message).not.toContain("model");
  });

  test("Full exposes only the static missing-protected-history disposition", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;
    const privateDetail = "PRIVATE_FULL_CONTEXT_DETAIL";
    const missing = new StrictShadowEnforcementError({
      boundaryId: "conversation.read.foreground_journal",
      family: "record",
      operation: "read_repair",
      actorClass: "agent",
      state: "unsupported",
      reason: "missing_protected_sibling",
      retryable: false,
      policyRevision: 17,
    });
    Object.defineProperty(missing, "message", { value: privateDetail });
    async function* rejectMissing(): AsyncGenerator<ServerEvent> {
      yield {
        type: "message.tokens",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
        content: "",
        chunkSequence: 1,
        done: false,
      };
      throw missing;
    }
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      ephemeralSinkDisposition: "full",
      executor: () => rejectMissing(),
      persist: async () => "job-full-missing-protected",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failed = cap.events.find(
      (event): event is JobStatusEvent =>
        event.type === "job.status" && event.status === "failed",
    );
    expect(failed?.message).toBe(
      "Encrypted history is not available for this turn yet [MDL007]",
    );
    expect(failed?.message).not.toContain(privateDetail);
  });

  test("Full keeps every other failure behind the generic protected sink", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;
    const privateDetail = "PRIVATE_FULL_INTEGRITY_DETAIL";
    async function* rejectIntegrity(): AsyncGenerator<ServerEvent> {
      yield {
        type: "message.tokens",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
        content: "",
        chunkSequence: 1,
        done: false,
      };
      throw new Error(privateDetail);
    }
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      ephemeralSinkDisposition: "full",
      executor: () => rejectIntegrity(),
      persist: async () => "job-full-integrity",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failed = cap.events.find(
      (event): event is JobStatusEvent =>
        event.type === "job.status" && event.status === "failed",
    );
    expect(failed?.message).toBe("Protected operation failed [MDL007]");
    expect(failed?.message).not.toContain(privateDetail);
  });

  test("retryable pre-model encrypted context resumes the same Job", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;
    let attempts = 0;

    async function* waitOnceThenComplete(): AsyncGenerator<ServerEvent> {
      attempts += 1;
      if (attempts === 1) {
        await prepareForegroundEncryptedContext(async () => {
          throw new StrictShadowEnforcementError({
            boundaryId: "conversation.read.foreground_history",
            family: "message",
            operation: "read_repair",
            actorClass: "agent",
            state: "waiting_for_authority",
            reason: "domain_authority_converging",
            retryable: true,
            policyRevision: 1,
          });
        });
      }
      yield {
        type: "message.tokens",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
        content: "protected reply",
        chunkSequence: 1,
        done: true,
      };
    }

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => waitOnceThenComplete(),
      persist: async () => "job-context-retry",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    expect(attempts).toBe(2);
    expect(job.status).toBe("completed");
    expect(cap.events.filter((event) =>
      event.type === "job.progress" && event.kind === "foreground-context"
    )).toEqual([
      {
        type: "job.progress",
        kind: "foreground-context",
        jobId: "job-context-retry",
        phase: "Preparing encrypted context",
        detail: "waiting",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
      },
      {
        type: "job.progress",
        kind: "foreground-context",
        jobId: "job-context-retry",
        phase: "Preparing encrypted context",
        detail: "ready",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
      },
    ]);
    expect(cap.events.some((event) =>
      event.type === "job.status" && event.status === "failed"
    )).toBe(false);
  });

  test("encrypted context retries stop at the owning authorization deadline", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;
    let attempts = 0;

    async function* waitPastAuthority(): AsyncGenerator<ServerEvent> {
      yield* [] as ServerEvent[];
      attempts += 1;
      await prepareForegroundEncryptedContext(async () => {
        throw new StrictShadowEnforcementError({
          boundaryId: "conversation.read.foreground_history",
          family: "message",
          operation: "read_repair",
          actorClass: "agent",
          state: "waiting_for_authority",
          reason: "domain_authority_converging",
          retryable: true,
          policyRevision: 1,
        });
      }, Date.now() - 1);
    }

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => waitPastAuthority(),
      persist: async () => "job-expired-context-authority",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    expect(attempts).toBe(1);
    expect(job.status).toBe("failed");
    expect(cap.events.some((event) =>
      event.type === "job.progress" && event.kind === "foreground-context"
    )).toBe(false);
  });

  test("LD-9: emitted message carries the right MDL00x bracket for each category", async () => {
    // Drive a handful of category-specific upstream errors through the
    // job and confirm the bracket-suffixed message matches the expected
    // code. Single source of truth: the CATEGORY_CODES map in
    // friendly-errors.ts. If this test breaks, the codes drifted.
    const matrix: Array<{
      throw: () => Error;
      expectedCategory: FriendlyErrorCategory;
      expectedCode: MdlCode;
    }> = [
      {
        throw: () => {
          const e = new Error("rate limited");
          (e as Error & { status?: number }).status = 429;
          return e;
        },
        expectedCategory: "rate_limit",
        expectedCode: "MDL002",
      },
      {
        throw: () => {
          const e = new Error("unauthorized");
          (e as Error & { status?: number }).status = 401;
          return e;
        },
        expectedCategory: "auth",
        expectedCode: "MDL003",
      },
      {
        throw: () => {
          const e = new Error("service down");
          (e as Error & { status?: number }).status = 503;
          return e;
        },
        expectedCategory: "provider_unavailable",
        expectedCode: "MDL006",
      },
    ];

    // Generator helper matching the structure of `throwUpstreamLikeError`
    // above (yield a no-op token, then throw) — satisfies eslint
    // `require-yield` while exercising the same catch path the agent
    // surface takes in production.
    async function* throwAfterToken(
      err: Error,
    ): AsyncGenerator<ServerEvent> {
      yield {
        type: "message.tokens",
        laneKey: "room:22222222-2222-4222-8222-222222222222",
        content: "",
        chunkSequence: 1,
        done: false,
      };
      throw err;
    }

    for (const m of matrix) {
      const tracker = trackStatus();
      const cap = captureBusEvents();
      const job = new Job({
        ownerId: "o1",
        requestorId: "r1",
        laneKey: "room:22222222-2222-4222-8222-222222222222",
        type: "foreground",
        input: {},
        executor: () => throwAfterToken(m.throw()),
        persist: async () => `job-mdl-${m.expectedCode}`,
        updateStatus: tracker.fn,
      });
      await job.persist();
      await job.execute();
      const failed = cap.events.find(
        (e): e is JobStatusEvent => e.type === "job.status" && e.status === "failed",
      );
      expect(failed?.errorCategory).toBe(m.expectedCategory);
      expect(failed?.message?.endsWith(`[${m.expectedCode}]`)).toBe(true);
      cap.cleanup();
    }
  });

  test("PRIVACY: room-scoped job.status: failed event NEVER carries raw provider details", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => throwUpstreamLikeError(),
      persist: async () => "job-2",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failed = cap.events.find(
      (e): e is JobStatusEvent => e.type === "job.status" && e.status === "failed",
    );
    expect(failed).toBeDefined();

    // The leak fragment ONLY appears in formatProviderError's output
    // (server.log path). It must not appear anywhere on the WS event
    // — not in `message`, not in any field, not in a JSON dump of
    // the whole event.
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain(PROMPT_LEAK_FRAGMENT);
    expect(serialized).not.toContain("invalid_request_error");
    expect(serialized).not.toContain("context_length_exceeded");

    // No `details` field on the event (forward-compatibility guard:
    // if a future commit re-adds it, this test breaks loudly).
    expect((failed as Record<string, unknown> | undefined)?.["details"]).toBeUndefined();
  });

  test("PRIVACY: raw provider details are NOT persisted via updateStatus", async () => {
    const tracker = trackStatus();
    const cap = captureBusEvents();
    cleanup = cap.cleanup;

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => throwUpstreamLikeError(),
      persist: async () => "job-3",
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    const failedUpdate = tracker.updates.find((u) => u.status === "failed");
    expect(failedUpdate).toBeDefined();

    // updateStatus only ever receives `message` + (optionally) `result`.
    // No leak fragment in the persisted shape.
    const serialized = JSON.stringify(failedUpdate);
    expect(serialized).not.toContain(PROMPT_LEAK_FRAGMENT);
    expect(serialized).not.toContain("invalid_request_error");

    // The friendly message IS persisted (it's safe — zero user content).
    expect(failedUpdate?.fields?.message).toBeDefined();
    expect(failedUpdate?.fields?.message?.length).toBeLessThan(200);

    // `errorCategory` is WS-event-only (not persisted in P1).
    expect(
      (failedUpdate?.fields as Record<string, unknown> | undefined)?.["errorCategory"],
    ).toBeUndefined();
    expect(
      (failedUpdate?.fields as Record<string, unknown> | undefined)?.["details"],
    ).toBeUndefined();
  });

  test("non-failed status transitions still emit the legacy event shape (no errorCategory)", async () => {
    const cap = captureBusEvents();
    cleanup = cap.cleanup;

    async function* completeNormally(): AsyncGenerator<ServerEvent> {
      yield {
        type: "message.tokens",
        laneKey: "room:11111111-1111-4111-8111-111111111111",
        content: "ok",
        chunkSequence: 1,
        done: true,
      };
    }

    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:11111111-1111-4111-8111-111111111111",
      type: "foreground",
      input: {},
      executor: () => completeNormally(),
      persist: async () => "job-4",
      updateStatus: async () => {},
    });

    await job.persist();
    await job.execute();

    const statuses = cap.events.filter(
      (e): e is JobStatusEvent => e.type === "job.status",
    );
    expect(statuses.map((e) => e.status)).toEqual(["running", "completed"]);
    for (const e of statuses) {
      expect(e.errorCategory).toBeUndefined();
      expect((e as unknown as Record<string, unknown>)["details"]).toBeUndefined();
    }
  });
});
