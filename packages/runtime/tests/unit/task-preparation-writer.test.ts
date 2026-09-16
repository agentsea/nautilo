import { describe, expect, test } from "bun:test";
import { createTaskPreparationWriter } from "../../src/tasks/task-observer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function progress(filesObserved: number, taskRunId = "current-run") {
  return { taskId: "task-one", taskRunId, ownerId: "owner-one", updatedAt: "2026-09-07T12:00:00Z",
    preparation: { stage: "inventory_progress", filesObserved, directoriesObserved: filesObserved } };
}

describe("Task preparation persistence coalescing", () => {
  test("retains only the latest pending inventory snapshot and flushes it on shutdown", async () => {
    const blocked = deferred();
    const writes: number[] = [];
    const writer = createTaskPreparationWriter(async (input) => {
      writes.push((input.preparation as { filesObserved: number }).filesObserved);
      if (writes.length === 1) await blocked.promise;
    }, () => {});
    writer.record(progress(1));
    await Promise.resolve();
    for (let count = 2; count <= 1000; count++) writer.record(progress(count));
    expect(writes).toEqual([1]);
    const flushed = writer.flush();
    blocked.resolve();
    await flushed;
    expect(writes).toEqual([1, 1000]);
  });

  test("an obsolete run cannot displace pending progress for the current run", async () => {
    const blocked = deferred();
    const writes: Array<{ run: string; files: number }> = [];
    const writer = createTaskPreparationWriter(async (input) => {
      writes.push({ run: input.taskRunId, files: (input.preparation as { filesObserved: number }).filesObserved });
      if (input.taskRunId === "current-run" && writes.length === 1) await blocked.promise;
    }, () => {});
    writer.record(progress(1));
    await Promise.resolve();
    writer.record(progress(50));
    writer.record(progress(3, "obsolete-run"));
    await Promise.resolve();
    blocked.resolve();
    await writer.flush();
    expect(writes).toContainEqual({ run: "current-run", files: 50 });
    expect(writes).toContainEqual({ run: "obsolete-run", files: 3 });
    // The supplied canonical persist function remains responsible for rejecting
    // terminal/obsolete runs; coalescing never combines their identities.
  });

  test("failed writes do not strand the newest phase or block shutdown", async () => {
    const blocked = deferred();
    const written: unknown[] = [];
    let errors = 0;
    const writer = createTaskPreparationWriter(async (input) => {
      written.push(input.preparation);
      if (written.length === 1) { await blocked.promise; throw new Error("temporary write failure"); }
    }, () => { errors++; });
    writer.record(progress(1));
    await Promise.resolve();
    writer.record({ ...progress(100), preparation: { stage: "research_ready" } });
    blocked.resolve();
    await writer.flush();
    expect(errors).toBe(1);
    expect(written.at(-1)).toEqual({ stage: "research_ready" });
  });
});
