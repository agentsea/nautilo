import { describe, expect, test } from "bun:test";

import type { CryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  createProtectedTaskActivationCryptoReadinessReader,
} from "../../src/routes/protected-task-activation-crypto-readiness";

const restricted = {} as CryptoPostgresHandle;
const transaction = {} as CanonicalTranscriptTx;
const NOW = new Date("2042-04-05T06:07:08.000Z");

type Row = Readonly<{
  objectId: string;
  completion: "pending" | "complete";
  disposition: "active" | "mapped" | "quarantined" | "stale_mapping";
  failureCode: string | null;
  bound?: boolean;
}>;

describe("protected Task activation crypto readiness", () => {
  test("classifies retained mapped objects separately from every blocker", async () => {
    const objectRows = [
      { cursor: "d1", objectId: `task-definition:v1:${"1".repeat(64)}` },
      { cursor: "d2", objectId: `task-definition:v1:${"2".repeat(64)}` },
      { cursor: "r1", objectId: `task-run-result:v1:${"3".repeat(64)}` },
      { cursor: "h1", objectId: `task-historical:v1:${"4".repeat(64)}` },
      { cursor: "h2", objectId: `task-historical:v1:${"5".repeat(64)}` },
      { cursor: "h3", objectId: `task-historical:v1:${"6".repeat(64)}` },
      { cursor: "h4", objectId: `task-historical:v1:${"7".repeat(64)}` },
    ] as const;
    const productRows: Row[] = [
      { objectId: objectRows[0].objectId, completion: "complete", disposition: "mapped", failureCode: null },
      { objectId: objectRows[1].objectId, completion: "complete", disposition: "active", failureCode: "crypto_mismatch" },
      { objectId: objectRows[2].objectId, completion: "pending", disposition: "active", failureCode: null },
      { objectId: objectRows[3].objectId, completion: "complete", disposition: "active", failureCode: null },
      { objectId: objectRows[4].objectId, completion: "pending", disposition: "quarantined", failureCode: "crypto_mismatch" },
      { objectId: objectRows[5].objectId, completion: "complete", disposition: "stale_mapping", failureCode: "mapping_conflict" },
    ];
    const staged = {
      cancellation: [
        { cursor: "c1", objectId: "cancel-mapped" },
        { cursor: "c2", objectId: "cancel-unbound" },
      ],
      result_message: [{ cursor: "r1", objectId: "result-message-mapped" }],
      terminal_message: [
        { cursor: "m1", objectId: "message-mapped" },
        { cursor: "m2", objectId: "message-missing" },
      ],
      historical: [{ cursor: "h1", objectId: "history-mapped" }],
    } as const;
    const stageRows: Record<keyof typeof staged, readonly Row[]> = {
      cancellation: [
        { objectId: "cancel-mapped", completion: "complete", disposition: "mapped", failureCode: null, bound: true },
        { objectId: "cancel-unbound", completion: "complete", disposition: "mapped", failureCode: null, bound: false },
      ],
      result_message: [
        { objectId: "result-message-mapped", completion: "complete", disposition: "mapped", failureCode: null, bound: true },
      ],
      terminal_message: [
        { objectId: "message-mapped", completion: "complete", disposition: "mapped", failureCode: null, bound: true },
      ],
      historical: [
        { objectId: "history-mapped", completion: "complete", disposition: "mapped", failureCode: null },
      ],
    };
    const read = createProtectedTaskActivationCryptoReadinessReader({
      assertCryptoHandle: () => undefined,
      readCryptoObjects: () => Promise.resolve(objectRows),
      readStaging: (_handle, kind) => Promise.resolve(staged[kind]),
      readObjectProductRows: () => Promise.resolve(productRows),
      readStagingProductRows: (_tx, kind) => Promise.resolve(stageRows[kind]),
    });

    const result = await read({ transaction, restricted, now: NOW });

    expect(result.observedAt).toEqual(NOW);
    expect(result.observedAt).not.toBe(NOW);
    expect(result.objects.definition).toEqual({
      total: 2n, mapped: 1n,
      blockers: {
        missingProductReceipt: 0n, pendingProductReceipt: 0n,
        completeUnmappedProductReceipt: 0n, quarantinedProductReceipt: 0n,
        staleMappingProductReceipt: 0n, invalidProductReceipt: 1n,
      },
    });
    expect(result.objects.result.blockers.pendingProductReceipt).toBe(1n);
    expect(result.objects.historical).toEqual({
      total: 4n, mapped: 0n,
      blockers: {
        missingProductReceipt: 1n, pendingProductReceipt: 0n,
        completeUnmappedProductReceipt: 1n, quarantinedProductReceipt: 1n,
        staleMappingProductReceipt: 1n, invalidProductReceipt: 0n,
      },
    });
    expect(result.staging.cancellation.mapped).toBe(1n);
    expect(result.staging.cancellation.blockers.invalidProductReceipt).toBe(1n);
    expect(result.staging.result_message.mapped).toBe(1n);
    expect(result.staging.terminal_message.blockers.missingProductReceipt).toBe(1n);
    expect(result.staging.historical.mapped).toBe(1n);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(["observedAt", "objects", "staging"]);
  });

  test("uses bounded keyset pages without retaining object identifiers", async () => {
    const first = Array.from({ length: 256 }, (_, index) => ({
      cursor: `cursor-${String(index).padStart(3, "0")}`,
      objectId: `task-definition:v1:${index.toString(16).padStart(64, "0")}`,
    }));
    const last = {
      cursor: "cursor-256",
      objectId: `task-definition:v1:${"f".repeat(64)}`,
    };
    const cursors: Array<string | null> = [];
    const batchSizes: number[] = [];
    const read = createProtectedTaskActivationCryptoReadinessReader({
      assertCryptoHandle: () => undefined,
      readCryptoObjects: (_handle, after) => {
        cursors.push(after);
        return Promise.resolve(after === null ? first : [last]);
      },
      readStaging: () => Promise.resolve([]),
      readObjectProductRows: (_tx, ids) => {
        batchSizes.push(ids.length);
        return Promise.resolve(ids.map(objectId => ({
          objectId, completion: "complete" as const,
          disposition: "mapped" as const, failureCode: null,
        })));
      },
      readStagingProductRows: () => Promise.resolve([]),
    });

    const result = await read({ transaction, restricted, now: NOW });

    expect(cursors).toEqual([null, first[255]!.cursor]);
    expect(batchSizes).toEqual([256, 1]);
    expect(result.objects.definition).toEqual({
      total: 257n, mapped: 257n,
      blockers: {
        missingProductReceipt: 0n, pendingProductReceipt: 0n,
        completeUnmappedProductReceipt: 0n, quarantinedProductReceipt: 0n,
        staleMappingProductReceipt: 0n, invalidProductReceipt: 0n,
      },
    });
    expect("objectId" in result.objects.definition).toBe(false);
  });

  test("rejects invalid time and oversized crypto pages", async () => {
    const read = createProtectedTaskActivationCryptoReadinessReader({
      assertCryptoHandle: () => undefined,
      readCryptoObjects: () => Promise.resolve(Array.from({ length: 257 }, (_, index) => ({
        cursor: String(index),
        objectId: `task-definition:v1:${index.toString(16).padStart(64, "0")}`,
      }))),
      readStaging: () => Promise.resolve([]),
      readObjectProductRows: () => Promise.resolve([]),
      readStagingProductRows: () => Promise.resolve([]),
    });
    await Promise.resolve(expect(read({ transaction, restricted, now: new Date(Number.NaN) }))
      .rejects.toThrow("time is invalid"));
    await Promise.resolve(expect(read({ transaction, restricted, now: NOW }))
      .rejects.toThrow("page exceeded its bound"));
  });
});
