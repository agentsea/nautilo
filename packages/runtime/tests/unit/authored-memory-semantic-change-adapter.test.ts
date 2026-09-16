import { describe, expect, test } from "bun:test";

import { AuthoredMemorySemanticChangeAdapter } from "../../src/reflection/authored-memory-semantic-change-adapter";

describe("AuthoredMemorySemanticChangeAdapter", () => {
  test("durably reserves HMAC-only source identity and wakes once", async () => {
    const commitmentInputs: unknown[] = [];
    const workInputs: unknown[] = [];
    let wakeups = 0;
    const adapter = new AuthoredMemorySemanticChangeAdapter({
      commitments: {
        sourceDependency: (input) => {
          commitmentInputs.push(input);
          return new Uint8Array(32).fill(1);
        },
        sourceChange: (input) => {
          commitmentInputs.push(input);
          return new Uint8Array(32).fill(2);
        },
      },
      semanticWork: {
        reserveSourceRepair: async (input) => {
          workInputs.push(input);
          return { reserved: true };
        },
      },
      wakeup: () => { wakeups += 1; },
    });
    const result = await adapter.admit({
      memoryId: "77000000-0000-4000-8000-000000000001",
      changeKind: "replace",
      changeRef: "memory-change:one",
    });
    expect(result).toEqual({ admitted: 1 });
    expect(commitmentInputs).toEqual([
      {
        sourceKind: "memory",
        logicalSourceRef: "memory:77000000-0000-4000-8000-000000000001",
      },
      {
        sourceKind: "memory",
        logicalSourceRef: "memory:77000000-0000-4000-8000-000000000001",
        changeRef: "memory-change:one",
      },
    ]);
    expect(workInputs).toEqual([{
      sourceDependencyCommitment: new Uint8Array(32).fill(1),
      sourceChangeCommitment: new Uint8Array(32).fill(2),
    }]);
    expect(JSON.stringify(workInputs)).not.toContain("77000000");
    expect(wakeups).toBe(1);
  });

  test("does not wake when the durable change fact is already reserved", async () => {
    let observed: unknown;
    let wakeups = 0;
    const adapter = new AuthoredMemorySemanticChangeAdapter({
      commitments: {
        sourceDependency: () => new Uint8Array(32),
        sourceChange: () => new Uint8Array(32),
      },
      semanticWork: {
        reserveSourceRepair: async (input) => {
          observed = input;
          return { reserved: false };
        },
      },
      wakeup: () => { wakeups += 1; },
    });
    await adapter.admit({
      memoryId: "77000000-0000-4000-8000-000000000001",
      changeKind: "archive",
      changeRef: "memory-change:two",
    });
    expect(observed).toMatchObject({
      sourceDependencyCommitment: new Uint8Array(32),
      sourceChangeCommitment: new Uint8Array(32),
    });
    expect(wakeups).toBe(0);
  });
});
