import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  checkUbuntuHostKernel,
  ubuntuHostKernelExitCode,
} from "../../src/ubuntu-host-kernel-check.ts";

describe("side-effect-free running-kernel inspection", () => {
  test("allows a supported fixed running build", () => {
    const result = checkUbuntuHostKernel(() => "Ubuntu 6.8.0-149.149-generic 6.8.12\n");
    expect(result.status).toBe("fixed");
    expect(ubuntuHostKernelExitCode(result)).toBe(0);
  });

  test("refuses an affected running build", () => {
    const result = checkUbuntuHostKernel(() => "Ubuntu 6.8.0-148.148-generic 6.8.12\n");
    expect(result.status).toBe("affected");
    expect(ubuntuHostKernelExitCode(result)).toBe(1);
  });

  test("missing Ubuntu proc identity is unverified, not fixed", () => {
    const result = checkUbuntuHostKernel(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    expect(result.status).toBe("unknown");
    expect(result.signature).toBeNull();
    expect(result.message).toContain("unverified");
    expect(ubuntuHostKernelExitCode(result)).toBe(0);
  });

  test("malformed proc identity stays unverified", () => {
    const result = checkUbuntuHostKernel(() => "unexpected vendor kernel");
    expect(result.status).toBe("unknown");
    expect(ubuntuHostKernelExitCode(result)).toBe(0);
  });

  test("unexpected read errors fail closed without exposing exception details", () => {
    for (const error of [Object.assign(new Error("sensitive filesystem detail"), { code: "EACCES" }),
      Object.assign(new Error("I/O detail"), { code: "EIO" }), new Error("other failure")]) {
      const result = checkUbuntuHostKernel(() => { throw error; });
      expect(result.status).toBe("error");
      expect(result.signature).toBeNull();
      expect(result.message).toContain("startup refused");
      expect(result.message).not.toContain("sensitive filesystem detail");
      expect(ubuntuHostKernelExitCode(result)).toBe(1);
    }
  });

  test("importing the executable does not run its main or read proc", () => {
    const checker = fileURLToPath(new URL("../../src/ubuntu-host-kernel-check.ts", import.meta.url));
    const child = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(checker)});`], {
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toBe("");
  });

  test("executable rejects arbitrary path and environment-style override arguments", () => {
    const checker = fileURLToPath(new URL("../../src/ubuntu-host-kernel-check.ts", import.meta.url));
    for (const args of [["--signature-file", "/tmp/kernel"], ["--allow-affected"], ["--json", "extra"]]) {
      const child = Bun.spawnSync([process.execPath, checker, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(1);
      expect(child.stdout.toString()).toBe("");
      expect(child.stderr.toString()).toContain("Usage:");
    }
  });
});
