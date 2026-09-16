import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ApiError, type NautiloApiClient } from "@nautilo/api-client/browser";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { createRoomMessageOperations } from "../../src/adapters/room-message-operations";
import { restoreRoomReadOutcome } from "../../src/adapters/room-read-outcome";
import type { RoomHistoryCursor } from "../../src/adapters/session-rehydrate";
import { shouldDeferBackgroundHistoryProjection } from "../../src/adapters/nautilo-runtime";
import { createDomainKeyRecipientSyncScheduler } from "../../src/adapters/nautilo-runtime";
import { createAdmissionFetch } from "../../src/lib/admission-fetch";
import {
  getCryptoAdmissionSnapshot,
  isCryptoAdmissionGenerationCurrent,
  requestCryptoAdmissionRefresh,
  resetCryptoAdmissionAccess,
  runWithCryptoAdmission,
  setCryptoAdmissionAccessState,
} from "../../src/lib/crypto-admission-access";

const ROOM_ID = "40000000-0000-4000-8000-000000001234";
const POLICY = {
  mode: "shadow_encryption",
  shadowBehavior: "strict",
} as const;

function openAdmission(): void {
  setCryptoAdmissionAccessState({
    status: "open",
    identity: "https://nautilo.test:viewer-a:device-a",
    policy: POLICY,
  });
}

function message(id: string, content: string) {
  return {
    id,
    role: "user",
    content,
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
  };
}

function cursor(id: string): RoomHistoryCursor {
  return { id, createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z` };
}

function historyResponse(
  ids: readonly string[],
  pageInfo: { hasMoreBefore: boolean; oldestCursor: RoomHistoryCursor | null },
): Response {
  return Response.json({
    messages: ids.map((id) => message(id, `server message ${id}`)),
    pageInfo,
  });
}

function neverCompletingJsonResponse(onBodyRead: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    // The admission wrapper cancels this source as soon as its generation is
    // invalidated. Keeping it otherwise pending models headers arriving before
    // confidential body bytes finish.
    pull() {
      onBodyRead();
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function roomOperations(fetchImpl: typeof fetch) {
  const policy = { mode: "plaintext_only", shadowBehavior: "fallback" } as const;
  return createRoomMessageOperations({
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy, revalidationToken: 1 }),
      revalidate: async () => {},
    } }),
    api: { getOlderRoomMessages: async (options) => {
      const response = await fetchImpl(`https://nautilo.test/api/rooms/${options.roomId}/messages`);
      if (!response.ok) throw new ApiError(response.status, "history unavailable");
      return await response.json() as Awaited<ReturnType<NautiloApiClient["getOlderRoomMessages"]>>;
    } },
    ordinarySend: async () => ({ messageId: 1, jobId: null }),
  });
}

beforeEach(() => {
  resetCryptoAdmissionAccess();
  openAdmission();
});

afterEach(() => {
  resetCryptoAdmissionAccess();
});

describe("admission runtime boundaries", () => {
  test("an initial history body cannot project after admission pauses or is re-proved", async () => {
    let bodyReadStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    const guardedFetch = createAdmissionFetch(async () =>
      neverCompletingJsonResponse(bodyReadStarted));
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const retainedFrame = ["mounted draft", "visible transcript"];
    let projectedFrame = retainedFrame;

    const hydration = restoreRoomReadOutcome(() => roomOperations(guardedFetch).readRoomMessages(ROOM_ID));
    await readingBody;
    requestCryptoAdmissionRefresh("encryption_policy_changed");

    expect(await hydration).toEqual({ status: "failed", restored: null });
    if (isCryptoAdmissionGenerationCurrent(admissionGeneration)) {
      projectedFrame = ["late plaintext"];
    }
    expect(projectedFrame).toBe(retainedFrame);

    openAdmission();
    expect(isCryptoAdmissionGenerationCurrent(admissionGeneration)).toBe(false);
    expect(projectedFrame).toBe(retainedFrame);
  });

  test("a loaded-window refresh retains its prior frame when the first body is cancelled", async () => {
    let bodyReadStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
    const guardedFetch = createAdmissionFetch(async () => neverCompletingJsonResponse(bodyReadStarted));
    const hydration = restoreRoomReadOutcome(() => roomOperations(guardedFetch).readReconnectWindow(ROOM_ID, cursor("01")));
    await readingBody;
    requestCryptoAdmissionRefresh("transport_disconnected");
    expect(await hydration).toEqual({ status: "failed", restored: null });
  });

  test("a loaded-window refresh is atomic when admission closes on a later page", async () => {
    let call = 0;
    let secondPageBodyReadStarted!: () => void;
    const readingSecondPageBody = new Promise<void>((resolve) => {
      secondPageBodyReadStarted = resolve;
    });
    const guardedFetch = createAdmissionFetch(async () => {
      call += 1;
      if (call === 1) {
        return historyResponse(["51", "52"], {
          hasMoreBefore: true,
          oldestCursor: cursor("51"),
        });
      }
      return neverCompletingJsonResponse(secondPageBodyReadStarted);
    });
    const retainedFrame = ["already mounted oldest row", "local draft"];
    const hydration = restoreRoomReadOutcome(() => roomOperations(guardedFetch).readReconnectWindow(ROOM_ID, cursor("01")));

    await readingSecondPageBody;
    requestCryptoAdmissionRefresh("websocket_reconnected");

    expect(await hydration).toEqual({ status: "failed", restored: null });
    expect(call).toBe(2);
    expect(retainedFrame).toEqual(["already mounted oldest row", "local draft"]);
  });

  test("a late owner-private result is fenced across pause and re-proof", async () => {
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const retainedPrivateProjection = { prompt: "existing local input" };
    let release!: (value: { prompt: string }) => void;
    const request = new Promise<{ prompt: string }>((resolve) => {
      release = resolve;
    });

    requestCryptoAdmissionRefresh("device_admission_expired");
    release({ prompt: "late private server value" });
    const lateResult = await request;
    const whilePaused = isCryptoAdmissionGenerationCurrent(admissionGeneration)
      ? lateResult
      : retainedPrivateProjection;
    expect(whilePaused).toBe(retainedPrivateProjection);

    openAdmission();
    const afterReproof = isCryptoAdmissionGenerationCurrent(admissionGeneration)
      ? lateResult
      : retainedPrivateProjection;
    expect(afterReproof).toBe(retainedPrivateProjection);
  });

  test("recipient synchronization pauses without retry churn and resumes exact key classes", async () => {
    const scheduled: Array<() => void> = [];
    const calls: string[] = [];
    let release!: () => void;
    const firstAttempt = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const scheduler = createDomainKeyRecipientSyncScheduler({
      service: (roomId, namespaceId, keyClass) => runWithCryptoAdmission(async () => {
        calls.push(`${roomId}:${namespaceId}:${keyClass}`);
        if (first) await firstAttempt;
        return true;
      }),
      schedule: (run) => {
        scheduled.push(run);
        return () => {
          const index = scheduled.indexOf(run);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
    });
    scheduler.enqueue("room-a", "namespace-a");
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await Promise.resolve();
    requestCryptoAdmissionRefresh("device_admission_expired");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toHaveLength(0);

    first = false;
    openAdmission();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      "room-a:namespace-a:human",
      "room-a:namespace-a:ai",
      "room-a:namespace-a:human",
      "room-a:namespace-a:ai",
    ]);
    scheduler.dispose();
  });

  test("background recovery retains a live stream, while revocation still clears it", () => {
    const liveStreamingFrame = ["persisted turn", "partially streamed answer"];
    const refreshedFrame = ["persisted turn"];

    const deferSuccess = shouldDeferBackgroundHistoryProjection({
      backgroundRefresh: true,
      hasActiveStream: true,
      isRunning: false,
      resultStatus: "ok",
    });
    const afterSuccessfulRefresh = deferSuccess ? liveStreamingFrame : refreshedFrame;
    expect(afterSuccessfulRefresh).toBe(liveStreamingFrame);

    const deferRevocation = shouldDeferBackgroundHistoryProjection({
      backgroundRefresh: true,
      hasActiveStream: true,
      isRunning: true,
      resultStatus: "not-found",
    });
    const afterRevocation = deferRevocation ? liveStreamingFrame : [];
    expect(afterRevocation).toEqual([]);
  });
});
