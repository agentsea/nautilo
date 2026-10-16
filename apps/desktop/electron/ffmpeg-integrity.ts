import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { verifyVendoredBinaryOnce } from "@nautilo/config/vendored-binary";

/** A re-sign may alter the pinned Mach-O bytes, but a mismatch must still have
 * a valid signature. Production additionally requires the app's signing team.
 * On Windows a mismatch is accepted only when `allowReplaced` says the running
 * app is not a validly signed release, mirroring the ad-hoc Mac copy. */
export async function verifyFfmpegFile(binaryPath: string, expectedSha256: string, cache: Map<string, boolean>, signing?: { teamId?: string; allowAdHoc?: boolean; requireSignature?: boolean; allowReplaced?: () => boolean }): Promise<boolean> {
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
  if (!ok && signing?.allowReplaced && process.platform === "win32") ok = signing.allowReplaced();
  cache.set(binaryPath, ok);
  return ok;
}

export function codesignTeam(binaryPath: string): string | null {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", binaryPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const team = /^TeamIdentifier=(.+)$/m.exec(result.stderr)?.[1];
  return !team || team === "not set" ? null : team;
}

/** Authenticode status of a Windows file (`Valid`, `NotSigned`, `HashMismatch`,
 * ...), or null when Windows PowerShell cannot report it. */
export function authenticodeStatus(filePath: string): string | null {
  const powershell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "(Get-AuthenticodeSignature -LiteralPath $env:NAUTILO_SIGNED_PATH).Status"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, NAUTILO_SIGNED_PATH: filePath },
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/** LGPL lets users run their own interface-compatible FFmpeg. An unsigned
 * build, or a user-modified copy of a signed one, accepts replaced files; a
 * valid signed release, or an unreadable status, keeps the pinned files. */
export function acceptsReplacedFfmpeg(appSignatureStatus: string | null): boolean {
  return appSignatureStatus === "NotSigned" || appSignatureStatus === "HashMismatch";
}
