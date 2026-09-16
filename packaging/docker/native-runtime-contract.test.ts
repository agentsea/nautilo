import { describe, expect, test } from "bun:test";
import { expectedElfMachine, runtimeArchForPlatform } from "./native-runtime-contract.ts";
import { executionMode } from "./native-runtime-probe-cli.ts";
import { officeCliProbeEnvironment } from "./native-runtime-probe.ts";

describe("D490 native runtime contract", () => {
  test("maps candidate platforms to their runtime and ELF identities", () => {
    expect(runtimeArchForPlatform("linux/amd64")).toBe("x64");
    expect(runtimeArchForPlatform("linux/arm64")).toBe("arm64");
    expect(expectedElfMachine("linux/amd64")).toBe(62);
    expect(expectedElfMachine("linux/arm64")).toBe(183);
  });

  test("labels host-matching execution as native and cross-architecture execution as emulated", () => {
    expect(executionMode("aarch64", "linux/arm64")).toBe("native");
    expect(executionMode("aarch64", "linux/amd64")).toBe("emulated");
    expect(executionMode("x86_64", "linux/amd64")).toBe("native");
    expect(executionMode("x86_64", "linux/arm64")).toBe("emulated");
  });

  test("runs OfficeCLI with the deterministic production process contract", () => {
    const env = officeCliProbeEnvironment({ KEEP: "yes" });

    expect(env).toEqual({
      KEEP: "yes",
      OFFICECLI_SKIP_UPDATE: "1",
      OFFICECLI_NO_AUTO_RESIDENT: "1",
    });
  });
});
