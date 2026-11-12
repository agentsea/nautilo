import { describe, expect, test } from "bun:test";
import { assertBrowserElf, assertBrowserLinkage } from "./native-runtime-probe.ts";

function elf(machine: number): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

describe("vendored browser native qualification", () => {
  test("requires actual ELF64 little-endian CPU identity", () => {
    for (const [platform, machine, wrong] of [["linux/amd64", 62, 183], ["linux/arm64", 183, 62]] as const) {
      expect(() => assertBrowserElf(elf(machine), platform)).not.toThrow();
      expect(() => assertBrowserElf(elf(wrong), platform)).toThrow("ELF64");
      const invalidClass = elf(machine);
      invalidClass[4] = 1;
      expect(() => assertBrowserElf(invalidClass, platform)).toThrow("ELF64");
      const invalidEndian = elf(machine);
      invalidEndian[5] = 2;
      expect(() => assertBrowserElf(invalidEndian, platform)).toThrow("ELF64");
      expect(() => assertBrowserElf(Buffer.alloc(20), platform)).toThrow("ELF64");
    }
  });

  test("rejects absent libraries even when ldd exits successfully", () => {
    expect(() => assertBrowserLinkage(0, "libc.so.6 => /lib/libc.so.6 (0x1)", "")).not.toThrow();
    expect(() => assertBrowserLinkage(0, "libmissing.so => not found", "")).toThrow("linkage");
    expect(() => assertBrowserLinkage(0, "", "")).toThrow("linkage");
    expect(() => assertBrowserLinkage(1, "libc.so.6 => /lib/libc.so.6", "failure")).toThrow("linkage");
  });
});
