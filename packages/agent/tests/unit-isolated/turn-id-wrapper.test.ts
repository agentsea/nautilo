/**
 * The production wrapper composes the checkpoint saver, policy resolver, and
 * graph. Mock those process-global module dependencies before importing the
 * real subject so this unit test cannot construct a database-backed saver.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const checkpointSaver = { kind: "checkpoint-saver-double" };
const policyResolver = { kind: "policy-resolver-double" };
const getStateCalls: Array<{ configurable: { thread_id: string } }> = [];
const graph = {
  getState: async (config: { configurable: { thread_id: string } }) => {
    getStateCalls.push(config);
    return { values: { turnId: `persisted:${config.configurable.thread_id}` } };
  },
};

let checkpointSaverCalls = 0;
let policyResolverCalls = 0;
const graphCalls: Array<{ saver: unknown; policy: unknown }> = [];
let graphConstructionError: Error | null = null;
let turnIdModule: typeof import("../../src/graph/turn-id");

beforeAll(async () => {
  mock.module("../../src/checkpoints/checkpoint-saver", () => ({
    createCheckpointSaver: () => {
      checkpointSaverCalls += 1;
      return checkpointSaver;
    },
  }));
  mock.module("@nautilo/trust", () => ({
    getPolicyResolver: () => {
      policyResolverCalls += 1;
      return policyResolver;
    },
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: (saver: unknown, policy: unknown) => {
      graphCalls.push({ saver, policy });
      if (graphConstructionError) throw graphConstructionError;
      return graph;
    },
  }));

  turnIdModule = await import("../../src/graph/turn-id");
});

beforeEach(() => {
  checkpointSaverCalls = 0;
  policyResolverCalls = 0;
  graphCalls.length = 0;
  getStateCalls.length = 0;
  graphConstructionError = null;
});

afterAll(() => {
  mock.restore();
});

describe("readTurnIdForThread", () => {
  test("returns the persisted checkpoint turn id through the production wrapper", async () => {
    const result = await turnIdModule.readTurnIdForThread("thread-persisted");

    expect(result).toBe("persisted:thread-persisted");
    expect(checkpointSaverCalls).toBe(1);
    expect(policyResolverCalls).toBe(1);
    expect(graphCalls).toEqual([{ saver: checkpointSaver, policy: policyResolver }]);
    expect(getStateCalls).toEqual([
      { configurable: { thread_id: "thread-persisted" } },
    ]);
  });

  test("returns a fresh uuid when a wrapper collaborator fails", async () => {
    graphConstructionError = new Error("graph construction failed");

    const result = await turnIdModule.readTurnIdForThread("thread-fallback");

    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(checkpointSaverCalls).toBe(1);
    expect(policyResolverCalls).toBe(1);
    expect(graphCalls).toEqual([{ saver: checkpointSaver, policy: policyResolver }]);
    expect(getStateCalls).toEqual([]);
  });
});
