import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  resetCanonicalPathLocksForTests,
  withCanonicalPathLocks,
} from "../../electron/local-file-history/mutation-lock.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("same canonical path serializes and releases after a throw", async () => {
  resetCanonicalPathLocksForTests();
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];
  const first = withCanonicalPathLocks(["/workspace/a.txt"], async () => {
    order.push("first");
    entered.resolve();
    await release.promise;
    throw new Error("expected");
  });
  await entered.promise;
  const second = withCanonicalPathLocks(["/workspace/a.txt"], async () => {
    order.push("second");
  });
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  release.resolve();
  await expect(first).rejects.toThrow("expected");
  await second;
  expect(order).toEqual(["first", "second"]);
});

test("disjoint canonical paths proceed concurrently", async () => {
  resetCanonicalPathLocksForTests();
  const bothEntered = deferred();
  const release = deferred();
  let entered = 0;
  const run = (path: string) => withCanonicalPathLocks([path], async () => {
    entered += 1;
    if (entered === 2) bothEntered.resolve();
    await release.promise;
  });
  const first = run("/workspace/a.txt");
  const second = run("/workspace/b.txt");
  await bothEntered.promise;
  release.resolve();
  await Promise.all([first, second]);
});

test("opposite multi-path orders dedupe and cannot deadlock", async () => {
  resetCanonicalPathLocksForTests();
  const firstEntered = deferred();
  const release = deferred();
  const order: string[] = [];
  const first = withCanonicalPathLocks(["/workspace/b.txt", "/workspace/a.txt", "/workspace/a.txt"], async () => {
    order.push("first");
    firstEntered.resolve();
    await release.promise;
  });
  await firstEntered.promise;
  const second = withCanonicalPathLocks(["/workspace/a.txt", "/workspace/b.txt"], async () => {
    order.push("second");
  });
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
});

test("structural file commands no longer own a second legacy lock/write path", async () => {
  const source = await fs.readFile(
    path.resolve(
      import.meta.dir,
      "../../electron/local-file-dispatch/commands.ts",
    ),
    "utf8",
  );
  for (const forbidden of [
    "withCanonicalPathLocks(",
    "executeGuardedMutation(",
    "recordSuccessfulMutation(",
    "removeRecursive(",
  ]) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).toContain("executeCoordinatedStructuralMutation(");
});
