import { describe, expect, test } from "bun:test";
import {
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
} from "@nautilo/lattice-crypto/background";

import {
  createBackgroundAuthorizationSweepV2,
  createCoalescedBackgroundAuthorizationSweepV2,
} from "../../src/client/background/background-authorization-sweep-v2.ts";
import { encodeBackgroundAuthorizationBase64url } from
  "../../src/device/background-authorization-transport.ts";

function encode(value: Uint8Array): string {
  return encodeBackgroundAuthorizationBase64url(value);
}

describe("background authorization discovery sweep", () => {
  test("follows continuation after an empty page and wipes serial request and response bytes", async () => {
    const calls: string[] = [];
    let borrowedRequest: Uint8Array | undefined;
    let returnedResponse: Uint8Array | undefined;
    const api = {
      async listBackgroundAuthorizationRequests(
        input: Readonly<{ continuation?: string }>,
      ) {
        calls.push(`list:${input.continuation ?? "first"}`);
        return input.continuation === undefined
          ? {
              responseVersion: 1 as const,
              requests: [],
              continuation: "next",
            }
          : {
              responseVersion: 1 as const,
              requests: [{ requestBytesBase64url: encode(
                new Uint8Array([1, 2, 3]),
              ) }],
            };
      },
      async respondBackgroundAuthorizationRequest(input: Readonly<{
        responseBytesBase64url: string;
      }>) {
        calls.push(`respond:${input.responseBytesBase64url}`);
        return { responseVersion: 1 as const, status: "accepted" as const };
      },
    };
    const sweep = createBackgroundAuthorizationSweepV2({
      api,
      respond: async (descriptorBytes) => {
        borrowedRequest = descriptorBytes;
        returnedResponse = new Uint8Array([4, 5, 6]);
        return {
          status: "ready",
          requestId: "request-1",
          recipientGeneration: 1,
          expiresAt: 2,
          responseBytes: returnedResponse,
        };
      },
    });

    expect(await sweep.sweep()).toEqual({
      status: "complete",
      pages: 2,
      discovered: 1,
      responded: 1,
      deferred: 0,
      stale: 0,
      invalid: 0,
    });
    expect(calls).toEqual(["list:first", "list:next", "respond:BAUG"]);
    expect(borrowedRequest?.every((byte) => byte === 0)).toBe(true);
    expect(returnedResponse?.every((byte) => byte === 0)).toBe(true);
  });

  test("continues past invalid, pending, unavailable, and stale requests", async () => {
    let responses = 0;
    const api = {
      async listBackgroundAuthorizationRequests() {
        return {
          responseVersion: 1 as const,
          requests: [
            { requestBytesBase64url: "x" },
            ...[1, 2, 3, 4].map((value) => ({
              requestBytesBase64url: encode(new Uint8Array([value])),
            })),
          ],
        };
      },
      async respondBackgroundAuthorizationRequest() {
        responses += 1;
        return { responseVersion: 1 as const, status: "duplicate" as const };
      },
    };
    const sweep = createBackgroundAuthorizationSweepV2({
      api,
      respond: async (bytes) => {
        switch (bytes[0]) {
          case 1:
            return { status: "pending", reason: "domain_authority_pending" };
          case 2:
            return {
              status: "unavailable",
              reason: "signing_authority_unavailable",
            };
          case 3:
            return { status: "stale", reason: "expired" };
          default:
            return {
              status: "ready",
              requestId: "request-4",
              recipientGeneration: 1,
              expiresAt: 2,
              responseBytes: new Uint8Array([9]),
            };
        }
      },
    });

    expect(await sweep.sweep()).toEqual({
      status: "complete",
      pages: 1,
      discovered: 5,
      responded: 1,
      deferred: 2,
      stale: 1,
      invalid: 1,
    });
    expect(responses).toBe(1);
  });

  test("admits the additive Reflection carrier and rejects beyond it before responding", async () => {
    const largerThanStenographer = new Uint8Array(
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2 + 1,
    );
    let observedBytes = 0;
    const admitted = createBackgroundAuthorizationSweepV2({
      api: {
        listBackgroundAuthorizationRequests: async () => ({
          responseVersion: 1 as const,
          requests: [{
            requestBytesBase64url: encode(largerThanStenographer),
          }],
        }),
        respondBackgroundAuthorizationRequest: () => Promise.reject(
          new Error("must not submit"),
        ),
      },
      respond: async (bytes) => {
        observedBytes = bytes.length;
        return { status: "pending", reason: "domain_authority_pending" };
      },
    });
    expect(await admitted.sweep()).toMatchObject({
      status: "complete",
      discovered: 1,
      deferred: 1,
      invalid: 0,
    });
    expect(observedBytes).toBe(largerThanStenographer.length);

    let oversizedRespondCalls = 0;
    const maximumCharacters = Math.ceil(
      MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2 * 4 / 3,
    );
    const oversized = createBackgroundAuthorizationSweepV2({
      api: {
        listBackgroundAuthorizationRequests: async () => ({
          responseVersion: 1 as const,
          requests: [{ requestBytesBase64url: "A".repeat(
            maximumCharacters + 1,
          ) }],
        }),
        respondBackgroundAuthorizationRequest: () => Promise.reject(
          new Error("must not submit"),
        ),
      },
      respond: async () => {
        oversizedRespondCalls += 1;
        return { status: "pending", reason: "domain_authority_pending" };
      },
    });
    expect(await oversized.sweep()).toMatchObject({
      status: "complete",
      discovered: 1,
      invalid: 1,
    });
    expect(oversizedRespondCalls).toBe(0);
  });

  test("reports transport failure and continuation cycles without retrying", async () => {
    const failed = createBackgroundAuthorizationSweepV2({
      api: {
        listBackgroundAuthorizationRequests: () => Promise.reject(
          new Error("offline"),
        ),
        respondBackgroundAuthorizationRequest: () => Promise.reject(
          new Error("unused"),
        ),
      },
      respond: () => Promise.reject(new Error("unused")),
    });
    expect(await failed.sweep()).toMatchObject({
      status: "unavailable",
      reason: "list_failed",
      pages: 0,
    });

    const cyclic = createBackgroundAuthorizationSweepV2({
      api: {
        listBackgroundAuthorizationRequests: async () => ({
          responseVersion: 1 as const,
          requests: [],
          continuation: "same",
        }),
        respondBackgroundAuthorizationRequest: () => Promise.reject(
          new Error("unused"),
        ),
      },
      respond: () => Promise.reject(new Error("unused")),
    });
    expect(await cyclic.sweep()).toMatchObject({
      status: "unavailable",
      reason: "continuation_cycle",
      pages: 2,
    });
  });

  test("a wake received during a sweep schedules one additional full sweep", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sweeps = 0;
    const coalesced = createCoalescedBackgroundAuthorizationSweepV2({
      sweep: async () => {
        sweeps += 1;
        if (sweeps === 1) await first;
      },
    });
    const initial = coalesced.request();
    await Promise.resolve();
    const wakeOne = coalesced.request();
    const wakeTwo = coalesced.request();
    expect(wakeOne).toBe(initial);
    expect(wakeTwo).toBe(initial);
    releaseFirst?.();
    await coalesced.idle();
    expect(sweeps).toBe(2);
    await coalesced.request();
    expect(sweeps).toBe(3);
  });

  test("cancellation reaches list, responder, and submission boundaries", async () => {
    const controller = new AbortController();
    const sweep = createBackgroundAuthorizationSweepV2({
      api: {
        listBackgroundAuthorizationRequests: async () => {
          controller.abort();
          return {
            responseVersion: 1 as const,
            requests: [{ requestBytesBase64url: encode(
              new Uint8Array([1]),
            ) }],
          };
        },
        respondBackgroundAuthorizationRequest: () => Promise.resolve({
          responseVersion: 1 as const,
          status: "accepted" as const,
        }),
      },
      respond: () => Promise.reject(new Error("must not run")),
    });
    expect(sweep.sweep({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    const coalesced = createCoalescedBackgroundAuthorizationSweepV2({
      signal: controller.signal,
      sweep: () => Promise.reject(new Error("must not run")),
    });
    expect(coalesced.request()).rejects.toMatchObject({name: "AbortError"});
  });

  test("works with native-shaped signals and no browser or Node base64 globals", async () => {
    const descriptors = ["atob", "btoa", "Buffer"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ] as const);
    for (const [name] of descriptors) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
    try {
      let submitted: string | undefined;
      const signal = {
        aborted: false,
        reason: undefined,
      } as unknown as AbortSignal;
      const sweep = createBackgroundAuthorizationSweepV2({
        api: {
          listBackgroundAuthorizationRequests: async () => ({
            responseVersion: 1 as const,
            requests: [{ requestBytesBase64url: "AQID" }],
          }),
          respondBackgroundAuthorizationRequest: async (input) => {
            submitted = input.responseBytesBase64url;
            return {
              responseVersion: 1 as const,
              status: "accepted" as const,
            };
          },
        },
        respond: async (bytes, receivedSignal) => {
          expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
          expect(receivedSignal).toBe(signal);
          return {
            status: "ready",
            requestId: "request-native",
            recipientGeneration: 1,
            expiresAt: 2,
            responseBytes: new Uint8Array([4, 5, 6]),
          };
        },
      });

      expect(await sweep.sweep({ signal })).toMatchObject({
        status: "complete",
        responded: 1,
      });
      expect(submitted).toBe("BAUG");
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, name);
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
    }
  });

  test("wipes a ready response when cancellation arrives with responder completion", async () => {
    const controller = new AbortController();
    let returnedResponse: Uint8Array | undefined;
    const sweep = createBackgroundAuthorizationSweepV2({
      api: {
        listBackgroundAuthorizationRequests: async () => ({
          responseVersion: 1 as const,
          requests: [{ requestBytesBase64url: "AQ" }],
        }),
        respondBackgroundAuthorizationRequest: () => Promise.reject(
          new Error("must not submit"),
        ),
      },
      respond: async () => {
        returnedResponse = new Uint8Array([7, 8, 9]);
        controller.abort();
        return {
          status: "ready",
          requestId: "request-late-cancel",
          recipientGeneration: 1,
          expiresAt: 2,
          responseBytes: returnedResponse,
        };
      },
    });

    expect(sweep.sweep({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(returnedResponse?.every((byte) => byte === 0)).toBe(true);
  });
});
