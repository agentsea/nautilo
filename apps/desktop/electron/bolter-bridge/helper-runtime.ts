import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type PackageIdentity = { resourcesPath: string; executablePath: string };
type SignatureCommand = (args: readonly string[]) => string;
const team = (details: string) => /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1];
function codesign(args: readonly string[]): string {
  const result = spawnSync("/usr/bin/codesign", [...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  if (result.error || result.status !== 0) throw new Error("Bolter helper is unavailable.");
  return `${result.stdout}\n${result.stderr}`;
}

/** Same enclosing-app seal and Team-ID boundary used by other credential-bearing Desktop tools. */
export async function verifyBolterHelperSignature(binaryPath: string, arch: string, input: PackageIdentity,
  run: SignatureCommand = codesign): Promise<boolean> {
  try {
    const resources = resolve(input.resourcesPath);
    const executable = resolve(input.executablePath);
    const app = dirname(dirname(dirname(executable)));
    if (!(arch === "arm64" || arch === "x64") || !app.endsWith(".app")
      || dirname(executable) !== join(app, "Contents", "MacOS") || resources !== join(app, "Contents", "Resources")
      || await realpath(resources) !== resources || await realpath(executable) !== executable
      || await realpath(binaryPath) !== resolve(binaryPath)
      || resolve(binaryPath) !== join(resources, "tools-bolter-handover", arch, "bolter-handover")) return false;
    run(["--verify", "--deep", "--strict", "--all-architectures", "-R", '=anchor apple generic and identifier "com.nautilo.desktop"', app]);
    const details = run(["-d", "--verbose=4", app]);
    const appTeam = team(details);
    if (!appTeam || !/^Identifier=com\.nautilo\.desktop$/m.test(details)) return false;
    for (const path of [executable, binaryPath]) {
      run(["--verify", "--strict", "--all-architectures", "-R", `=anchor apple generic and certificate leaf[subject.OU] = "${appTeam}"`, path]);
      if (team(run(["-d", "--verbose=4", path])) !== appTeam) return false;
    }
    return true;
  } catch { return false; }
}

/** Development bytes use the build receipt; signed package bytes use the enclosing app seal. */
export function createBolterHelper(root: string, arch: string, packaged?: PackageIdentity): {
  executable: string; attest(executable: string): Promise<boolean>;
} | undefined {
  if (arch !== "arm64" && arch !== "x64") return undefined;
  const executable = join(root, arch, "bolter-handover");
  const manifest = join(root, arch, "manifest.json");
  return Object.freeze({ executable, async attest(candidate: string): Promise<boolean> {
    try {
      if (candidate !== executable || await realpath(executable) !== resolve(executable)) return false;
      const [stat, receiptStat] = await Promise.all([lstat(executable), lstat(manifest)]);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0
        || !receiptStat.isFile() || receiptStat.isSymbolicLink() || (receiptStat.mode & 0o022) !== 0) return false;
      const receipt: unknown = JSON.parse(await readFile(manifest, "utf8"));
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
      const value = receipt as Record<string, unknown>;
      if (Object.keys(value).sort().join() !== "arch,bytes,protocolVersion,sha256" || value["arch"] !== arch
        || value["protocolVersion"] !== 1 || typeof value["bytes"] !== "number" || !Number.isSafeInteger(value["bytes"])
        || value["bytes"] <= 0 || typeof value["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["sha256"])) return false;
      const bytes = await readFile(executable);
      // Builds are thin Mach-O 64 binaries, one per explicitly selected architecture.
      if (bytes.byteLength < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf
        || bytes.readUInt32LE(4) !== (arch === "arm64" ? 0x0100000c : 0x01000007)) return false;
      if (packaged ? !await verifyBolterHelperSignature(executable, arch, packaged)
        : bytes.byteLength !== value["bytes"] || createHash("sha256").update(bytes).digest("hex") !== value["sha256"]) return false;
      const after = await lstat(executable);
      return stat.ino === after.ino && stat.dev === after.dev && stat.size === after.size && stat.mtimeMs === after.mtimeMs
        && stat.ctimeMs === after.ctimeMs && !after.isSymbolicLink() && await realpath(executable) === resolve(executable)
        && createHash("sha256").update(await readFile(executable)).digest("hex") === createHash("sha256").update(bytes).digest("hex");
    } catch { return false; }
  } });
}
