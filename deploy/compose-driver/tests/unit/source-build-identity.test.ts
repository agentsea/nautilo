import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveSourceBuildIdentity } from "../../src/source-build-identity.ts";
import type { ExecFn, ExecResult } from "../../src/ComposeDriver.ts";

const SHA = "a".repeat(40);
const TEMPLATE_DIR = "/repo/deploy/compose-driver/templates";
const SOURCE_ROOT = resolve(TEMPLATE_DIR, "../../..");

function execFor(
  responses: readonly ExecResult[],
): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let index = 0;
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      const response = responses[index++];
      if (response === undefined) throw new Error("unexpected exec");
      return response;
    },
  };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

describe("source build identity", () => {
  test("returns one stable clean checkout revision from the exact build-context root", async () => {
    const { exec, calls } = execFor([
      ok(`${SOURCE_ROOT}\n`),
      ok(`${SHA}\n`),
      ok(""),
      ok(`${SHA}\n`),
    ]);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().resolves`
    await expect(resolveSourceBuildIdentity({ templateDir: TEMPLATE_DIR, exec })).resolves.toBe(SHA);
    expect(calls.map((call) => call.args)).toEqual([
      ["-C", SOURCE_ROOT, "rev-parse", "--show-toplevel"],
      ["-C", SOURCE_ROOT, "rev-parse", "HEAD"],
      ["-C", SOURCE_ROOT, "status", "--porcelain=v1", "--untracked-files=normal"],
      ["-C", SOURCE_ROOT, "rev-parse", "HEAD"],
    ]);
  });

  test("rejects a dirty checkout without confirming or inventing a revision", async () => {
    const { exec, calls } = execFor([
      ok(`${SOURCE_ROOT}\n`),
      ok(`${SHA}\n`),
      ok(" M packages/server/src/index.ts\n?? scratch.txt\n"),
    ]);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(resolveSourceBuildIdentity({ templateDir: TEMPLATE_DIR, exec })).rejects.toThrow(
      "checkout is dirty",
    );
    expect(calls).toHaveLength(3);
  });

  test("rejects an archive/non-checkout before accepting source authority", async () => {
    const { exec } = execFor([
      { code: 128, stdout: "", stderr: "fatal: not a git repository" },
    ]);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(resolveSourceBuildIdentity({ templateDir: TEMPLATE_DIR, exec })).rejects.toThrow(
      "Git checkout discovery failed",
    );
  });

  test("rejects a checkout-root mismatch and a revision race", async () => {
    const mismatch = execFor([ok("/different/repo\n")]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(resolveSourceBuildIdentity({ templateDir: TEMPLATE_DIR, exec: mismatch.exec })).rejects.toThrow(
      "is not the Git checkout root",
    );

    const raced = execFor([
      ok(`${SOURCE_ROOT}\n`),
      ok(`${SHA}\n`),
      ok(""),
      ok(`${"b".repeat(40)}\n`),
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(resolveSourceBuildIdentity({ templateDir: TEMPLATE_DIR, exec: raced.exec })).rejects.toThrow(
      "revision changed during preflight",
    );
  });
});
