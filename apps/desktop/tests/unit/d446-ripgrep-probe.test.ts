import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  probeDesktopRipgrep,
  resetDesktopRipgrepProbeCache,
} from "../../electron/ripgrep-runtime";

let temp: string | undefined;

afterEach(async () => {
  resetDesktopRipgrepProbeCache();
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = undefined;
});

describe("D446 Desktop ripgrep probe", () => {
  test("strictly verifies dev-vendor extracted bytes and rejects corruption", async () => {
    temp = await mkdtemp(join(tmpdir(), "d446-rg-probe-"));
    const targetBinary = join(temp, "ripgrep/darwin-arm64/rg");
    const bytes = Buffer.from("unit-test managed ripgrep bytes\n");
    const binarySha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(temp, "ripgrep/darwin-arm64"), { recursive: true });
    await writeFile(targetBinary, bytes);
    await writeFile(join(temp, "ripgrep/manifest.json"), JSON.stringify({
      ripgrep: {
        version: "15.1.0",
        license: "MIT OR Unlicense",
        source: "https://github.com/BurntSushi/ripgrep",
        binaryName: "rg",
        artifacts: {
          "darwin-arm64": {
            url: "https://example.invalid/ripgrep.tar.gz",
            sha256: "0".repeat(64),
            binarySha256,
            member: "rg",
          },
        },
      },
    }));

    expect(await probeDesktopRipgrep({
      isPackaged: false,
      devVendorRoot: temp,
      resourcesPath: null,
      platformKey: "darwin-arm64",
    })).toMatchObject({ ok: true, binaryPath: targetBinary, version: "15.1.0" });

    resetDesktopRipgrepProbeCache();
    await writeFile(targetBinary, "corrupt");
    expect(await probeDesktopRipgrep({
      isPackaged: false,
      devVendorRoot: temp,
      resourcesPath: null,
      platformKey: "darwin-arm64",
    })).toMatchObject({ ok: false, code: "SEARCH_UNAVAILABLE" });
  });
});
