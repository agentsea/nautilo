import { expect, test } from "bun:test";
import type { Task } from "@nautilo/db";
import {
  dispatchTaskRun,
  type DispatchTaskRunDeps,
} from "../../src/tasks/dispatch-task-run";

test("the ordinary Task dispatcher rejects protected content before opening a Job", async () => {
  for (const contentRepresentation of ["protected", "dual"] as const) {
    await dispatchTaskRun(
      { contentRepresentation } as Task,
      {} as DispatchTaskRunDeps,
    ).then(
      () => { throw new Error("Protected Task dispatch unexpectedly succeeded"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("Protected Task execution is unavailable");
      },
    );
  }
});
