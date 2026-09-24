import { spyOn } from "bun:test";
import type { JobManager as RuntimeJobManager } from "@nautilo/runtime";

/** Keep real resume lifecycle behavior with an explicit, DB-free Human authority. */
export async function installResumeInvocationAuthority(humanUserId: string): Promise<RuntimeJobManager> {
  const { JobManager, jobManager } = await import("@nautilo/runtime");
  const manager = new JobManager({
    checkInvocationAccess: input => Promise.resolve(input.humanUserId === humanUserId),
  });
  spyOn(jobManager, "runResumeJobLifecycle").mockImplementation((...args) =>
    manager.runResumeJobLifecycle(...args));
  return manager;
}
