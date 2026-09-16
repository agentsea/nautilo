import { describe, expect, test } from "bun:test";
import { runInstallerCommand } from "../../src/installer-index.ts";

describe("standalone installer command", () => {
  test("offers non-mutating version and help probes", async () => {
    const output: string[] = [];
    const mustNotInstall = async (): Promise<never> => {
      throw new Error("installer probe attempted installation");
    };

    expect(await runInstallerCommand({ argv: ["--version"], install: mustNotInstall, stdout: (value) => output.push(value) })).toBe(0);
    expect(await runInstallerCommand({ argv: ["--help"], install: mustNotInstall, stdout: (value) => output.push(value) })).toBe(0);
    expect(output[0]).toMatch(/^0\.1\.\d+\n$/);
    expect(output[1]).toContain("Usage: install-nautilo");
  });

  test("rejects unknown arguments before installation", async () => {
    const errors: string[] = [];
    const result = await runInstallerCommand({
      argv: ["--force"],
      install: async (): Promise<never> => {
        throw new Error("unknown argument attempted installation");
      },
      stderr: (value) => errors.push(value),
    });
    expect(result).toBe(2);
    expect(errors).toEqual(["Unknown installer argument. Run with --help.\n"]);
  });
});
