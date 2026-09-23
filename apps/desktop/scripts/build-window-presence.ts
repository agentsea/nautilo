import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Source-built universal macOS metadata reader; no downloaded runtime.
if (process.platform === "darwin") {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "vendor/window-presence");
  const binary = join(dir, "nautilo-window-presence");
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => {
    const result = spawnSync("xcrun", args, { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error("Window presence helper build failed");
  };
  for (const arch of ["arm64", "x86_64"]) run([
    "clang", "-arch", arch, "-mmacosx-version-min=11.0", "-fobjc-arc",
    "-framework", "AppKit", "-framework", "CoreGraphics",
    join(root, "native/window-presence/main.m"), "-o", `${binary}.${arch}`,
  ]);
  run(["lipo", "-create", `${binary}.arm64`, `${binary}.x86_64`, "-output", binary]);
  run(["lipo", binary, "-verify_arch", "arm64", "x86_64"]);
  for (const arch of ["arm64", "x86_64"]) rmSync(`${binary}.${arch}`);
}
