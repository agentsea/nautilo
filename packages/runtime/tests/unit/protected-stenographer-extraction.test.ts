import { describe, expect, test } from "bun:test";
import type {
  ProcessorTransformInput,
  ProcessorTransformOutput,
} from "@nautilo/lattice-crypto";
import { encodeMessagePayloadV2 } from "@nautilo/lattice-bridge";

import {
  runProtectedStenographerExtraction,
  type ProtectedStenographerExtractionPublicationPort,
} from "../../src/stenographer/protected-stenographer-extraction";
import type {
  ProtectedStenographerSourceBinding,
} from "../../src/stenographer/protected-source-loader";
import {
  fingerprintProtectedStenographerSourceBindings,
} from "../../src/stenographer/protected-source-loader";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";
const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-08-04T12:00:00.000Z";

function fixture() {
  const opened: ProcessorTransformInput[] = [{
    objectId: "message-object-11",
    plaintext: encodeMessagePayloadV2({
      role: "user",
      content: "Remember the blue deployment.",
    }),
  }];
  const bindings: ProtectedStenographerSourceBinding[] = [{
    kind: "message",
    objectId: "message-object-11",
    source: "current",
    messageId: 11,
    editRevision: 0,
    createdAt: new Date(CREATED_AT),
    participantId: "human-alice",
    role: "user",
    conversationalBoundary: true,
  }];
  return { bindings, opened };
}

function publicationPort(
  calls: string[],
  durableSnapshots: string[],
  attachResult:
    | "attached"
    | "duplicate"
    | "reconcile"
    | "stale"
    | "conflict" = "attached",
): ProtectedStenographerExtractionPublicationPort {
  return {
    reserve: (reservation) => {
      calls.push("reserve");
      durableSnapshots.push(JSON.stringify(reservation));
      return Promise.resolve("reserved");
    },
    markCryptoCommitted: (commit) => {
      calls.push("mark");
      durableSnapshots.push(JSON.stringify(commit));
      return Promise.resolve("marked");
    },
    attach: (attachment) => {
      calls.push("attach");
      durableSnapshots.push(JSON.stringify(attachment));
      return Promise.resolve(attachResult);
    },
  };
}

describe("protected Stenographer extraction", () => {
  test("opens, invokes, reserves metadata, publishes the exact prefix, and attaches in order", async () => {
    const state = fixture();
    const calls: string[] = [];
    const durableSnapshots: string[] = [];
    let published: readonly ProcessorTransformOutput[] = [];
    const result = await runProtectedStenographerExtraction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => {
          calls.push("open");
          return Promise.resolve(state.opened);
        },
        publishOutputs: (outputs) => {
          calls.push("crypto");
          published = outputs.map((output) => ({
            objectId: output.objectId,
            plaintext: output.plaintext.slice(),
          }));
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-1",
        workId: "stenographer-work-1",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        requiresContentRecheck: false,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sourceBatchId: BATCH_ID,
        rebuildGeneration: 0,
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 11,
        extractorVersion: "m241-v1",
        createdAt: CREATED_AT,
        bindings: state.bindings,
        outputSlots: [{
          eventId: EVENT_ID,
          objectId: "journal-output-1",
        }],
      },
      resolveParticipantDisplays: () =>
        Promise.resolve([{
          participantId: "human-alice",
          displayLabel: "Alice",
        }]),
      invokeModel: (prompt) => {
        calls.push("model");
        expect(prompt).toContain("Remember the blue deployment.");
        return Promise.resolve(JSON.stringify({
          operations: [{
            op: "append",
            kind: "fact",
            statement: "Deployment color is blue.",
            sourceMessageIds: ["M1"],
          }],
        }));
      },
      publication: publicationPort(calls, durableSnapshots),
    });

    expect(result).toEqual({ status: "completed", outputCount: 1 });
    expect(calls).toEqual([
      "open",
      "model",
      "reserve",
      "crypto",
      "mark",
      "attach",
    ]);
    expect(published.map((output) => output.objectId))
      .toEqual(["journal-output-1"]);
    expect(new TextDecoder().decode(published[0]?.plaintext))
      .toContain("Deployment color is blue.");
    expect(durableSnapshots.join("\n"))
      .not.toContain("Deployment color is blue.");
    expect(durableSnapshots.join("\n"))
      .not.toContain("Remember the blue deployment.");
    expect(state.opened[0]?.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  test("rechecks empty assistant content after opening and advances without a model call", async () => {
    const state = fixture();
    if (state.bindings[0]?.kind !== "message") {
      throw new Error("message binding fixture missing");
    }
    state.bindings[0] = {
      ...state.bindings[0],
      role: "assistant",
    };
    state.opened[0] = {
      ...state.opened[0]!,
      plaintext: encodeMessagePayloadV2({
        role: "assistant",
        content: " \n ",
      }),
    };
    const calls: string[] = [];
    let modelCalls = 0;

    const result = await runProtectedStenographerExtraction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => {
          calls.push("open");
          return Promise.resolve(state.opened);
        },
        publishOutputs: (outputs) => {
          calls.push(`crypto:${outputs.length}`);
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-empty-assistant",
        workId: "stenographer-work-empty-assistant",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        requiresContentRecheck: true,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sourceBatchId: BATCH_ID,
        rebuildGeneration: 0,
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 11,
        extractorVersion: "m241-v1",
        createdAt: CREATED_AT,
        bindings: state.bindings,
        outputSlots: [{
          eventId: EVENT_ID,
          objectId: "journal-output-empty-assistant",
        }],
      },
      resolveParticipantDisplays: () =>
        Promise.resolve([{
          participantId: "human-alice",
          displayLabel: "Alice",
        }]),
      invokeModel: () => {
        modelCalls += 1;
        return Promise.resolve(JSON.stringify({ operations: [] }));
      },
      publication: publicationPort(calls, []),
    });

    expect(result).toEqual({ status: "completed", outputCount: 0 });
    expect(modelCalls).toBe(0);
    expect(calls).toEqual([
      "open",
      "reserve",
      "crypto:0",
      "mark",
      "attach",
    ]);
    expect(state.opened[0]?.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  test("does not invoke the model or publication ports when an opened input is substituted", async () => {
    const state = fixture();
    state.opened[0] = {
      ...state.opened[0]!,
      objectId: "substituted-object",
    };
    let modelCalls = 0;
    let publicationCalls = 0;

    expect(
      runProtectedStenographerExtraction({
        signal: new AbortController().signal,
        capability: {
          openInputs: () => Promise.resolve(state.opened),
          publishOutputs: () => {
            publicationCalls += 1;
            return Promise.resolve();
          },
        },
        work: {
          requestId: "request-1",
          workId: "stenographer-work-1",
          workIdentityHash: new Uint8Array(32).fill(1),
          descriptorHash: new Uint8Array(32).fill(2),
          sourceBindingFingerprint:
            fingerprintProtectedStenographerSourceBindings(state.bindings),
          requiresContentRecheck: false,
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          sourceBatchId: BATCH_ID,
          rebuildGeneration: 0,
          fromMessageIdExclusive: 10,
          throughMessageIdInclusive: 11,
          extractorVersion: "m241-v1",
          createdAt: CREATED_AT,
          bindings: state.bindings,
          outputSlots: [{
            eventId: EVENT_ID,
            objectId: "journal-output-1",
          }],
        },
        resolveParticipantDisplays: () => Promise.resolve([]),
        invokeModel: () => {
          modelCalls += 1;
          return Promise.resolve("{}");
        },
        publication: {
          reserve: () => {
            publicationCalls += 1;
            return Promise.resolve("reserved");
          },
          markCryptoCommitted: () => {
            publicationCalls += 1;
            return Promise.resolve("marked");
          },
          attach: () => {
            publicationCalls += 1;
            return Promise.resolve("attached");
          },
        },
      }),
    ).rejects.toThrow();
    expect(modelCalls).toBe(0);
    expect(publicationCalls).toBe(0);
    expect(state.opened[0]?.plaintext.every((byte) => byte === 0)).toBe(true);
  });

  test("keeps an exact crypto commit pending for reconciliation when product attachment loses its lease", async () => {
    const state = fixture();
    const calls: string[] = [];
    const result = await runProtectedStenographerExtraction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => Promise.resolve(state.opened),
        publishOutputs: () => {
          calls.push("crypto");
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-1",
        workId: "stenographer-work-1",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        requiresContentRecheck: false,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sourceBatchId: BATCH_ID,
        rebuildGeneration: 0,
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 11,
        extractorVersion: "m241-v1",
        createdAt: CREATED_AT,
        bindings: state.bindings,
        outputSlots: [{
          eventId: EVENT_ID,
          objectId: "journal-output-1",
        }],
      },
      resolveParticipantDisplays: () =>
        Promise.resolve([{
          participantId: "human-alice",
          displayLabel: "Alice",
        }]),
      invokeModel: () =>
        Promise.resolve(JSON.stringify({ operations: [] })),
      publication: publicationPort(calls, [], "reconcile"),
    });

    expect(result).toEqual({
      status: "reconciliation_pending",
      outputCount: 0,
    });
    expect(calls).toEqual(["reserve", "crypto", "mark", "attach"]);
  });

  test("closes the one-run gate with an empty prefix when the content-free receipt reservation conflicts", async () => {
    const state = fixture();
    const publishedPrefixes: number[] = [];
    const result = await runProtectedStenographerExtraction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => Promise.resolve(state.opened),
        publishOutputs: (outputs) => {
          publishedPrefixes.push(outputs.length);
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-1",
        workId: "stenographer-work-1",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        requiresContentRecheck: false,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sourceBatchId: BATCH_ID,
        rebuildGeneration: 0,
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 11,
        extractorVersion: "m241-v1",
        createdAt: CREATED_AT,
        bindings: state.bindings,
        outputSlots: [{
          eventId: EVENT_ID,
          objectId: "journal-output-1",
        }],
      },
      resolveParticipantDisplays: () =>
        Promise.resolve([{
          participantId: "human-alice",
          displayLabel: "Alice",
        }]),
      invokeModel: () =>
        Promise.resolve(JSON.stringify({ operations: [] })),
      publication: {
        reserve: () => Promise.resolve("conflict"),
        markCryptoCommitted: () => Promise.resolve("marked"),
        attach: () => Promise.resolve("attached"),
      },
    });

    expect(result).toEqual({ status: "rejected", reason: "receipt_conflict" });
    expect(publishedPrefixes).toEqual([0]);
  });

  test("passes transform cancellation to the provider and performs no late publication", async () => {
    const state = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let published = 0;
    const running = runProtectedStenographerExtraction({
      signal: controller.signal,
      capability: {
        openInputs: () => Promise.resolve(state.opened),
        publishOutputs: () => {
          published += 1;
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-cancelled",
        workId: "stenographer-work-cancelled",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        requiresContentRecheck: false,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sourceBatchId: BATCH_ID,
        rebuildGeneration: 0,
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 11,
        extractorVersion: "m241-v1",
        createdAt: CREATED_AT,
        bindings: state.bindings,
        outputSlots: [{
          eventId: EVENT_ID,
          objectId: "journal-output-cancelled",
        }],
      },
      resolveParticipantDisplays: () =>
        Promise.resolve([{
          participantId: "human-alice",
          displayLabel: "Alice",
        }]),
      invokeModel: (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          expect(signal).toBe(controller.signal);
          entered();
          signal.addEventListener(
            "abort",
            () => reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("provider aborted"),
            ),
            { once: true },
          );
        }),
      publication: publicationPort([], []),
    });

    await providerEntered;
    controller.abort(new Error("claim expired during provider call"));
    expect(running).rejects.toThrow("claim expired");
    expect(published).toBe(0);
  });
});
