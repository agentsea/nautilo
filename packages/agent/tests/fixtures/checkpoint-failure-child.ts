import { setImmediate } from "node:timers/promises";
import { createRequire } from "node:module";
import type { MemorySaver as MemorySaverType } from "@langchain/langgraph";

const library: typeof import("@langchain/langgraph") = process.argv[3] === "cjs"
  ? createRequire(import.meta.url)("@langchain/langgraph") as typeof import("@langchain/langgraph")
  : await import("@langchain/langgraph");
const { Annotation, END, MemorySaver, START, StateGraph } = library;

const failure = new Error("synthetic checkpoint persistence failure");
const mode = process.argv[2];
let putCount = 0;
let writeCount = 0;
const needsDrain = mode === "drain" || mode === "stop-drain";
let drained = !needsDrain;
const terminalNodeCompleted = Promise.withResolvers<void>();
let storeStopped = false;
if (mode === "stop-drain") {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to each actual store with call(this) below.
  const originalStop = library.AsyncBatchedStore.prototype.stop;
  library.AsyncBatchedStore.prototype.stop = async function () {
    storeStopped = true;
    await originalStop.call(this);
    throw new Error("secondary store stop failure");
  };
}

class FailingSaver extends MemorySaver {
  override async put(...args: Parameters<MemorySaverType["put"]>) {
    putCount += 1;
    if (mode === "put" && putCount === 1) throw failure;
    if (needsDrain && putCount === 2) throw failure;
    return super.put(...args);
  }

  override async putWrites(...args: Parameters<MemorySaverType["putWrites"]>) {
    writeCount += 1;
    if (mode === "writes" && writeCount === 1) throw failure;
    if (needsDrain && writeCount === 1) {
      await terminalNodeCompleted.promise;
      await setImmediate();
      drained = true;
    }
    return super.putWrites(...args);
  }
}

const state = Annotation.Root({ value: Annotation<number>() });
const graph = new StateGraph(state)
  .addNode("first", (value) => ({ value: value.value + 1 }))
  .addNode("second", async (value) => {
    // Cross event-loop checkpoints deterministically while async saver work
    // is pending, as a real model/node await does. No arbitrary sleep.
    if (!needsDrain) {
      await setImmediate();
      await setImmediate();
    }
    terminalNodeCompleted.resolve();
    return { value: value.value + 1 };
  })
  .addEdge(START, "first")
  .addEdge("first", "second")
  .addEdge("second", END)
  .compile({
    checkpointer: new FailingSaver(),
    ...(mode === "stop-drain" ? { store: new library.InMemoryStore() } : {}),
  });

try {
  await graph.invoke({ value: 1 }, { configurable: { thread_id: "failure-test" } });
  throw new Error("turn incorrectly succeeded despite checkpoint failure");
} catch (error) {
  if (error !== failure) throw error;
  if (!drained) throw new Error("turn released before sibling checkpoint work drained");
  if (mode === "stop-drain" && !storeStopped) {
    throw new Error("store cleanup was skipped");
  }
  process.stdout.write("turn rejected with original failure; pending work drained\n");
}
await setImmediate();
process.stdout.write("process healthy\n");
