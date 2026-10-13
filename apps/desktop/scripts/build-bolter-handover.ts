import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Builds only the app-owned stdin handover helper, never a provider or daemon. */
export async function buildBolterHandover(): Promise<void> {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) return;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const arch of ["arm64", "x64"] as const) {
  const directory = join(root, "dist", "bolter-handover", arch);
  const executable = join(directory, "bolter-handover");
  await mkdir(directory, { recursive: true });
  const result = spawnSync(process.execPath, ["build", join(root, "electron", "bolter-bridge", "handover-main.ts"),
    "--compile", `--target=bun-darwin-${arch}`, `--outfile=${executable}`], { stdio: "ignore" });
  if (result.error || result.status !== 0) throw new Error("Bolter handover build failed.");
  const bytes = await readFile(executable);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ protocolVersion: 1, arch,
    bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }) + "\n");
  }
}
if (import.meta.main) await buildBolterHandover();
