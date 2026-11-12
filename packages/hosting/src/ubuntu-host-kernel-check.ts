import { readFileSync } from "node:fs";
import {
  assessUbuntuHostKernel,
  UBUNTU_HOST_KERNEL_CVE,
  type UbuntuHostKernelAssessment,
} from "./ubuntu-host-kernel-policy.ts";

export type UbuntuHostKernelCheckResult = UbuntuHostKernelAssessment | {
  readonly cve: typeof UBUNTU_HOST_KERNEL_CVE;
  readonly status: "error";
  readonly signature: null;
  readonly message: string;
};

/** Only the kernel's fixed proc path is read; no caller/environment path override. */
export function checkUbuntuHostKernel(
  readSignature: () => string = () => readFileSync("/proc/version_signature", "utf8"),
): UbuntuHostKernelCheckResult {
  try {
    return assessUbuntuHostKernel(readSignature());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return assessUbuntuHostKernel(null);
    }
    return { cve: UBUNTU_HOST_KERNEL_CVE, status: "error", signature: null,
      message: `${UBUNTU_HOST_KERNEL_CVE}: running-kernel inspection failed; startup refused. Verify that /proc/version_signature can be read and retry. Kernel protection has not been verified.` };
  }
}

export function ubuntuHostKernelExitCode(result: UbuntuHostKernelCheckResult): 0 | 1 {
  return result.status === "affected" || result.status === "error" ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    process.stderr.write("Usage: ubuntu-host-kernel-check.ts [--json]\n");
    process.exitCode = 1;
  } else {
    const result = checkUbuntuHostKernel();
    if (args[0] === "--json") process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stderr.write(`${result.message}\n`);
    process.exitCode = ubuntuHostKernelExitCode(result);
  }
}
