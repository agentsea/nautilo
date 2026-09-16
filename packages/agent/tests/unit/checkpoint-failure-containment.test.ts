import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const child = fileURLToPath(new URL("../fixtures/checkpoint-failure-child.ts", import.meta.url));

describe("LangGraph checkpoint failure containment", () => {
  for (const flavor of ["esm", "cjs"]) {
  for (const mode of ["put", "writes", "drain", "stop-drain"]) {
    test(`contains ${flavor} ${mode} failure to the turn and drains owned work`, async () => {
      // No unhandledRejection listener: a missed promise owner must fail this
      // isolated process rather than endanger the shared unit-test process.
      const childProcess = Bun.spawn([process.execPath, child, mode, flavor], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        childProcess.exited,
        new Response(childProcess.stdout).text(),
        new Response(childProcess.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toContain("turn rejected with original failure; pending work drained");
      expect(stdout).toContain("process healthy");
    });
  }
  }
});
