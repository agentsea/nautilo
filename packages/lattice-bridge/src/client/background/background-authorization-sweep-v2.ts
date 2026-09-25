import type { NautiloApiClient } from "@nautilo/api-client/browser";
import {
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
} from "@nautilo/lattice-crypto/background";

import type { DeviceAuthorizationResponderResultV2 } from
  "./device-authorization-responder-v2.ts";
import {
  decodeBackgroundAuthorizationBase64url,
  encodeBackgroundAuthorizationBase64url,
} from "../../device/background-authorization-transport.ts";

type Api = Pick<
  NautiloApiClient,
  | "listBackgroundAuthorizationRequests"
  | "respondBackgroundAuthorizationRequest"
>;

const MAX_DISCOVERY_REQUEST_WIRE_BYTES = Math.max(
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
);

export type BackgroundAuthorizationSweepResultV2 = Readonly<{
  status: "complete" | "unavailable";
  pages: number;
  discovered: number;
  responded: number;
  deferred: number;
  stale: number;
  invalid: number;
  reason?: "list_failed" | "respond_failed" | "continuation_cycle" | undefined;
}>;

export interface BackgroundAuthorizationSweepV2 {
  sweep(input?: Readonly<{ signal?: AbortSignal }>):
    Promise<BackgroundAuthorizationSweepResultV2>;
}

export type RespondToBackgroundAuthorizationRequestV2 = (
  descriptorBytes: Uint8Array,
  signal?: AbortSignal,
) => Promise<DeviceAuthorizationResponderResultV2>;

function fromBase64url(value: string): Uint8Array {
  return decodeBackgroundAuthorizationBase64url(
    value,
    MAX_DISCOVERY_REQUEST_WIRE_BYTES,
  );
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === "string"
    ? signal.reason
    : "Background authorization cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function result(input: Readonly<{
  status: "complete" | "unavailable";
  pages: number;
  discovered: number;
  responded: number;
  deferred: number;
  stale: number;
  invalid: number;
  reason?: BackgroundAuthorizationSweepResultV2["reason"] | undefined;
}>): BackgroundAuthorizationSweepResultV2 {
  return Object.freeze(input);
}

/**
 * Performs one complete, paginated discovery pass. It owns no timer or host
 * lifecycle. Request and response byte buffers exist only for each serial
 * attempt and are wiped before the next request is considered.
 */
export function createBackgroundAuthorizationSweepV2(input: Readonly<{
  api: Api;
  respond: RespondToBackgroundAuthorizationRequestV2;
}>): BackgroundAuthorizationSweepV2 {
  return Object.freeze({
    async sweep(options: Readonly<{ signal?: AbortSignal }> = {}) {
      const counts = {
        pages: 0,
        discovered: 0,
        responded: 0,
        deferred: 0,
        stale: 0,
        invalid: 0,
      };
      let continuation: string | undefined;
      const observedContinuations = new Set<string>();
      while (true) {
        throwIfAborted(options.signal);
        let page;
        try {
          page = await input.api.listBackgroundAuthorizationRequests(
            continuation === undefined ? {} : { continuation },
            options.signal === undefined ? undefined : {
              signal: options.signal,
            },
          );
        } catch {
          throwIfAborted(options.signal);
          return result({
            status: "unavailable",
            ...counts,
            reason: "list_failed",
          });
        }
        throwIfAborted(options.signal);
        counts.pages += 1;
        for (const request of page.requests) {
          throwIfAborted(options.signal);
          counts.discovered += 1;
          let descriptorBytes: Uint8Array | undefined;
          let responseBytes: Uint8Array | undefined;
          try {
            try {
              descriptorBytes = fromBase64url(request.requestBytesBase64url);
            } catch {
              counts.invalid += 1;
              continue;
            }
            const authorization = await input.respond(
              descriptorBytes,
              options.signal,
            );
            if (authorization.status === "ready") {
              responseBytes = authorization.responseBytes;
            }
            throwIfAborted(options.signal);
            if (authorization.status === "pending"
              || authorization.status === "unavailable") {
              counts.deferred += 1;
              continue;
            }
            if (authorization.status === "stale") {
              counts.stale += 1;
              continue;
            }
            try {
              await input.api.respondBackgroundAuthorizationRequest({
                responseBytesBase64url:
                  encodeBackgroundAuthorizationBase64url(
                    authorization.responseBytes,
                  ),
              }, options.signal === undefined ? undefined : {
                signal: options.signal,
              });
            } catch {
              throwIfAborted(options.signal);
              return result({
                status: "unavailable",
                ...counts,
                reason: "respond_failed",
              });
            }
            throwIfAborted(options.signal);
            counts.responded += 1;
          } finally {
            descriptorBytes?.fill(0);
            responseBytes?.fill(0);
          }
        }
        if (page.continuation === undefined) {
          return result({ status: "complete", ...counts });
        }
        if (observedContinuations.has(page.continuation)) {
          return result({
            status: "unavailable",
            ...counts,
            reason: "continuation_cycle",
          });
        }
        observedContinuations.add(page.continuation);
        continuation = page.continuation;
      }
    },
  });
}

export interface CoalescedBackgroundAuthorizationSweepV2 {
  /** Schedules a full sweep. Concurrent requests share the running tail. */
  request(): Promise<void>;
  /** Waits for all requested sweeps, including a wake received mid-sweep. */
  idle(): Promise<void>;
}

/** Coalesces lifecycle and realtime wakes without owning a retry timer. */
export function createCoalescedBackgroundAuthorizationSweepV2(input: Readonly<{
  sweep: () => Promise<unknown>;
  signal?: AbortSignal;
}>): CoalescedBackgroundAuthorizationSweepV2 {
  let requested = false;
  let tail: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    while (requested) {
      requested = false;
      throwIfAborted(input.signal);
      await input.sweep();
      throwIfAborted(input.signal);
    }
  };
  const request = (): Promise<void> => {
    if (input.signal?.aborted) {
      return Promise.reject(abortError(input.signal));
    }
    requested = true;
    if (tail === undefined) {
      const running = run();
      const settled = running.finally(() => {
        if (tail === settled) tail = undefined;
      });
      tail = settled;
    }
    return tail;
  };
  return Object.freeze({
    request,
    idle: () => tail ?? Promise.resolve(),
  });
}
