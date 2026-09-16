import { execFileSync, spawnSync } from "node:child_process";
import { verifyVendoredBinaryOnce } from "@nautilo/config/vendored-binary";

/** A re-sign may alter the pinned Mach-O bytes, but a mismatch must still have
 * a valid signature. Production additionally requires the app's signing team. */
export async function verifyFfmpegFile(binaryPath: string, expectedSha256: string, cache: Map<string, boolean>, signing?: { teamId?: string; allowAdHoc?: boolean; requireSignature?: boolean }): Promise<boolean> {
  if (cache.has(binaryPath)) return cache.get(binaryPath)!;
  const result = await verifyVendoredBinaryOnce({ binaryPath, expectedSha256, policy: "strict", label: "FFmpeg", cache: new Map() });
  let ok = result.ok;
  if ((!ok || signing?.requireSignature) && signing && process.platform === "darwin") {
    try {
      execFileSync("codesign", ["--verify", "--strict", binaryPath], { stdio: "pipe" });
      const team = codesignTeam(binaryPath);
      ok = signing.teamId ? team === signing.teamId : signing.allowAdHoc === true && team === null;
    } catch { ok = false; }
  }
  cache.set(binaryPath, ok);
  return ok;
}

export function codesignTeam(binaryPath: string): string | null {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", binaryPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const team = /^TeamIdentifier=(.+)$/m.exec(result.stderr)?.[1];
  return !team || team === "not set" ? null : team;
}
