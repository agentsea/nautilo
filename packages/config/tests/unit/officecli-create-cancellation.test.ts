import { expect, test } from "bun:test";
import { makeOfficeCreateRun } from "../../src/officecli/generate";

test("a cancelled Office runner rejects before trying to spawn its binary", async () => {
  const controller = new AbortController();
  const run = makeOfficeCreateRun({
    binaryPath: "/nonexistent/officecli",
    signal: controller.signal,
  });
  controller.abort();

  const failure: unknown = await run(["view", "synthetic.xlsx", "stats", "--json"]).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "cancelled",
    stage: "process",
  });
});
