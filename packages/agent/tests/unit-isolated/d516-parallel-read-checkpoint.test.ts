/**
 * D516 3.6.14 prerequisite characterization only.
 *
 * These tests use pinned LangGraph primitives to prove the pending-write
 * behavior a future tools-node scheduler may rely on. The counters stand in
 * for invocation/result-protection work; this is not production Genie or Host
 * integration and does not establish exactly-once external execution.
 */
import { expect, test } from "bun:test";
import {
  Annotation,
  Command,
  END,
  getConfig,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
  task,
} from "@langchain/langgraph";

const FixtureState = Annotation.Root({
  input: Annotation<string>(),
  results: Annotation<string[]>(),
});

type Counters = {
  dispatches: Record<string, number>;
  protections: Record<string, number>;
};

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function buildGraph(
  saver: MemorySaver,
  counters: Counters,
  second: (input: string) => Promise<string>,
) {
  const durableRead = task("d516_durable_read", async (input: string) => {
    increment(counters.dispatches, "first");
    increment(counters.protections, "first");
    return `${input}:first`;
  });
  const otherRead = task("d516_other_read", async (input: string) => {
    increment(counters.dispatches, "second");
    const result = await second(input);
    increment(counters.protections, "second");
    return result;
  });

  return new StateGraph(FixtureState)
    .addNode("tools_like", async (state) => ({
      results: await Promise.all([
        durableRead(state.input),
        otherRead(state.input),
      ]),
    }))
    .addEdge(START, "tools_like")
    .addEdge("tools_like", END)
    .compile({ checkpointer: saver });
}

function counters(): Counters {
  return { dispatches: {}, protections: {} };
}

function reconstructMemorySaver(source: MemorySaver): MemorySaver {
  const reconstructed = new MemorySaver();
  reconstructed.storage = structuredClone(source.storage);
  reconstructed.writes = structuredClone(source.writes);
  return reconstructed;
}

async function rejectionMessage(operation: PromiseLike<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

test("a completed sibling is reused after the other durable task interrupts", async () => {
  const evidence = counters();
  const graph = buildGraph(new MemorySaver(), evidence, async (input) => {
    const resume: unknown = interrupt("resume-second-read");
    return `${input}:second:${String(resume)}`;
  });
  const config = { configurable: { thread_id: "d516-parallel-interrupt" } };

  const parked = await graph.invoke({ input: "turn", results: [] }, config);
  expect(parked).toHaveProperty("__interrupt__");
  expect(evidence).toEqual({
    dispatches: { first: 1, second: 1 },
    protections: { first: 1 },
  });

  const resumed = await graph.invoke(new Command({ resume: "approved" }), config);
  expect(resumed.results).toEqual([
    "turn:first",
    "turn:second:approved",
  ]);
  expect(evidence).toEqual({
    dispatches: { first: 1, second: 2 },
    protections: { first: 1, second: 1 },
  });
});

test("a completed sibling is reused when the other durable task fails and the node resumes", async () => {
  const evidence = counters();
  let failSecond = true;
  const graph = buildGraph(new MemorySaver(), evidence, async (input) => {
    if (failSecond) throw new Error("scripted second-read failure");
    return `${input}:second`;
  });
  const config = { configurable: { thread_id: "d516-parallel-failure" } };

  expect(await rejectionMessage(graph.invoke({ input: "turn", results: [] }, config)))
    .toContain("scripted second-read failure");
  failSecond = false;
  const resumed = await graph.invoke(null, config);

  expect(resumed.results).toEqual(["turn:first", "turn:second"]);
  expect(evidence).toEqual({
    dispatches: { first: 1, second: 2 },
    protections: { first: 1, second: 1 },
  });
});

test("a completed sibling is reused after cancellation and resume", async () => {
  const evidence = counters();
  let markWriteDurable!: () => void;
  const writeDurable = new Promise<void>((resolve) => { markWriteDurable = resolve; });
  class NotifyingMemorySaver extends MemorySaver {
    override async putWrites(
      ...args: Parameters<MemorySaver["putWrites"]>
    ): ReturnType<MemorySaver["putWrites"]> {
      await super.putWrites(...args);
      if (args[1].some(([channel]) => channel === "__return__")) markWriteDurable();
    }
  }
  const saver = new NotifyingMemorySaver();
  let waitForCancellation = true;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const graph = buildGraph(saver, evidence, async (input) => {
    markSecondStarted();
    if (waitForCancellation) {
      const signal = getConfig().signal;
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("scripted cancellation"),
        ), { once: true });
      });
    }
    return `${input}:second`;
  });
  const config = { configurable: { thread_id: "d516-parallel-cancel" } };
  const controller = new AbortController();
  const running = graph.invoke(
    { input: "turn", results: [] },
    { ...config, signal: controller.signal },
  );

  await secondStarted;
  await writeDurable;
  controller.abort(new Error("scripted cancellation"));
  expect(await rejectionMessage(running)).toContain("scripted cancellation");
  waitForCancellation = false;
  const resumed = await buildGraph(
    reconstructMemorySaver(saver),
    evidence,
    async (input) => `${input}:second`,
  ).invoke(null, config);

  expect(resumed.results).toEqual(["turn:first", "turn:second"]);
  expect(evidence).toEqual({
    dispatches: { first: 1, second: 2 },
    protections: { first: 1, second: 1 },
  });
});

test("only the task whose return write was unacknowledged is replayed", async () => {
  class RejectNamedTaskWriteSaver extends MemorySaver {
    rejectFirstRead = true;
    rejectedTaskWrites = 0;
    rejectedNodeWrites = 0;
    rejectedCheckpoints = 0;
    taskWriteFailed = false;

    override async put(
      ...args: Parameters<MemorySaver["put"]>
    ): ReturnType<MemorySaver["put"]> {
      // Model process loss after the rejected task write: a later whole-node
      // checkpoint must not make the unacknowledged result look durable.
      if (this.taskWriteFailed) {
        this.rejectedCheckpoints += 1;
        throw new Error("scripted process loss before node checkpoint");
      }
      return super.put(...args);
    }

    override async putWrites(
      ...args: Parameters<MemorySaver["putWrites"]>
    ): ReturnType<MemorySaver["putWrites"]> {
      const writes = args[1];
      if (this.taskWriteFailed && writes.some(([channel]) => channel === "results")) {
        this.rejectedNodeWrites += 1;
        throw new Error("scripted process loss before node result write");
      }
      // A task() completion is persisted as its __return__ pending write. Keep
      // rejecting this exact result, including PregelLoop's later flush of the
      // same buffered write, so the fault cannot accidentally hit a root/node
      // write or be healed by the flush before the invocation rejects.
      if (this.rejectFirstRead && writes.some(
        ([channel, value]) => channel === "__return__" && value === "turn:first",
      )) {
        this.rejectedTaskWrites += 1;
        this.taskWriteFailed = true;
        throw new Error("scripted pending-write failure");
      }
      return super.putWrites(...args);
    }
  }

  const evidence = counters();
  const saver = new RejectNamedTaskWriteSaver();
  const graph = buildGraph(saver, evidence, async (input) => `${input}:second`);
  const config = { configurable: { thread_id: "d516-parallel-write-failure" } };

  expect(await rejectionMessage(graph.invoke({ input: "turn", results: [] }, config)))
    .toContain("scripted pending-write failure");
  expect(saver.rejectedTaskWrites).toBeGreaterThanOrEqual(1);
  expect(saver.rejectedNodeWrites).toBeGreaterThanOrEqual(1);
  expect(saver.rejectedCheckpoints).toBeGreaterThanOrEqual(1);
  // Reconstruct both saver and runnable so reuse comes only from serialized
  // durable state, not the failed runner's in-memory pending-write buffer. The first read's
  // return was never acknowledged and must replay; the second was durable and
  // must not. This is at-least-once behavior at the unacknowledged boundary.
  const reconstructedSaver = reconstructMemorySaver(saver);
  const resumed = await buildGraph(
    reconstructedSaver,
    evidence,
    async (input) => `${input}:second`,
  ).invoke(null, config);

  expect(resumed.results).toEqual(["turn:first", "turn:second"]);
  expect(evidence).toEqual({
    dispatches: { first: 2, second: 1 },
    protections: { first: 2, second: 1 },
  });
});
