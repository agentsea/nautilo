import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const source of ["journal", "policy", "transcript"]) {
  test(`foreground ${source} failure is observed immediately and drains sibling reads`, async () => {
    const child = Bun.spawn([
      process.execPath,
      fileURLToPath(new URL("../fixtures/foreground-context-failure-child.ts", import.meta.url)),
      source,
    ], { stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ originalError: true, drained: true });
  }, 15_000);
}
