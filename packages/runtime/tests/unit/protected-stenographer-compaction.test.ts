import { describe, expect, test } from "bun:test";
import type { ProcessorTransformInput } from "@nautilo/lattice-crypto";
import {
  encodeRoomEventPayloadV1,
  type RoomEventPayloadV1,
} from "@nautilo/lattice-bridge";

import {
  runProtectedStenographerCompaction,
} from "../../src/stenographer/protected-stenographer-compaction";
import {
  fingerprintProtectedStenographerSourceBindings,
  type ProtectedStenographerSourceBinding,
} from "../../src/stenographer/protected-source-loader";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-08-04T12:00:00.000Z";
const ROLLUP_ID = "50000000-0000-4000-8000-000000000001";

function fixture() {
  const bindings: ProtectedStenographerSourceBinding[] = [];
  const opened: ProcessorTransformInput[] = [];
  for (let sequence = 1; sequence <= 80; sequence++) {
    const eventId =
      `40000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
    const payload: RoomEventPayloadV1 = {
      eventId,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence,
      kind: "fact",
      statement: `Event ${sequence}`,
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [sequence],
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: sequence - 1,
      extractorVersion: "m241-v1",
      createdAt: CREATED_AT,
    };
    const objectId = `journal-event-object-${sequence}`;
    bindings.push({
      kind: "event",
      objectId,
      status: "active",
      binding: {
        eventId,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sequence,
        kind: "fact",
        supersedesEventId: null,
        resolvesEventId: null,
        sourceMessageIds: [sequence],
        sourceBatchId: BATCH_ID,
        batchLocalOrdinal: sequence - 1,
        extractorVersion: "m241-v1",
        createdAt: CREATED_AT,
      },
    });
    opened.push({
      objectId,
      plaintext: encodeRoomEventPayloadV1(payload),
    });
  }
  return { bindings, opened };
}

describe("protected Stenographer compaction", () => {
  test("opens exact events, compacts once, and publishes one encrypted cumulative rollup", async () => {
    const state = fixture();
    const calls: string[] = [];
    const durable: string[] = [];
    let publishedText = "";
    const result = await runProtectedStenographerCompaction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => {
          calls.push("open");
          return Promise.resolve(state.opened);
        },
        publishOutputs: (outputs) => {
          calls.push("crypto");
          expect(outputs).toHaveLength(1);
          publishedText = new TextDecoder().decode(outputs[0]!.plaintext);
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-compaction-1",
        workId: "stenographer-compaction-1",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        rebuildGeneration: 2,
        bindings: state.bindings,
        rollupId: ROLLUP_ID,
        outputObjectId: "journal-rollup-output-1",
        modelId: "model-v1",
        compactorVersion: "m241-v1",
        createdAt: CREATED_AT,
      },
      invokeModel: (prompt) => {
        calls.push("model");
        expect(prompt).toContain("Event 1");
        expect(prompt).toContain("Protected newer effective-event tail");
        return Promise.resolve(JSON.stringify({
          content: "Cumulative protected history.",
        }));
      },
      publication: {
        reserve: (value) => {
          calls.push("reserve");
          durable.push(JSON.stringify(value));
          return Promise.resolve("reserved");
        },
        markCryptoCommitted: (value) => {
          calls.push("mark");
          durable.push(JSON.stringify(value));
          return Promise.resolve("marked");
        },
        attach: (value) => {
          calls.push("attach");
          durable.push(JSON.stringify(value));
          return Promise.resolve("attached");
        },
      },
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
    expect(publishedText).toContain("Cumulative protected history.");
    expect(durable.join("\n"))
      .not.toContain("Cumulative protected history.");
    expect(durable.join("\n")).not.toContain("Event 1");
    expect(state.opened.every((item) =>
      item.plaintext.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("closes the one-run gate with an empty prefix on provider failure", async () => {
    const state = fixture();
    const publishedPrefixes: number[] = [];
    let productWrites = 0;
    const result = await runProtectedStenographerCompaction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => Promise.resolve(state.opened),
        publishOutputs: (outputs) => {
          publishedPrefixes.push(outputs.length);
          return Promise.resolve();
        },
      },
      work: {
        requestId: "request-compaction-provider",
        workId: "stenographer-compaction-provider",
        workIdentityHash: new Uint8Array(32).fill(1),
        descriptorHash: new Uint8Array(32).fill(2),
        sourceBindingFingerprint:
          fingerprintProtectedStenographerSourceBindings(state.bindings),
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        rebuildGeneration: 2,
        bindings: state.bindings,
        rollupId: ROLLUP_ID,
        outputObjectId: "journal-rollup-output-provider",
        modelId: "model-v1",
        compactorVersion: "m241-v1",
        createdAt: CREATED_AT,
      },
      invokeModel: () => Promise.reject(new Error("provider detail")),
      publication: {
        reserve: () => {
          productWrites += 1;
          return Promise.resolve("reserved");
        },
        markCryptoCommitted: () => {
          productWrites += 1;
          return Promise.resolve("marked");
        },
        attach: () => {
          productWrites += 1;
          return Promise.resolve("attached");
        },
      },
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "provider_failure",
    });
    expect(publishedPrefixes).toEqual([0]);
    expect(productWrites).toBe(0);
    expect(state.opened.every((item) =>
      item.plaintext.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("rejects a stale source-binding fingerprint before opening inputs", async () => {
    const state = fixture();
    let opens = 0;
    expect(
      runProtectedStenographerCompaction({
        signal: new AbortController().signal,
        capability: {
          openInputs: () => {
            opens += 1;
            return Promise.resolve(state.opened);
          },
          publishOutputs: () => Promise.resolve(),
        },
        work: {
          requestId: "request-compaction-1",
          workId: "stenographer-compaction-1",
          workIdentityHash: new Uint8Array(32).fill(1),
          descriptorHash: new Uint8Array(32).fill(2),
          sourceBindingFingerprint: new Uint8Array(32).fill(9),
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          rebuildGeneration: 2,
          bindings: state.bindings,
          rollupId: ROLLUP_ID,
          outputObjectId: "journal-rollup-output-1",
          modelId: "model-v1",
          compactorVersion: "m241-v1",
          createdAt: CREATED_AT,
        },
        invokeModel: () => Promise.resolve("{}"),
        publication: {
          reserve: () => Promise.resolve("reserved"),
          markCryptoCommitted: () => Promise.resolve("marked"),
          attach: () => Promise.resolve("attached"),
        },
      }),
    ).rejects.toThrow();
    expect(opens).toBe(0);
  });
});
