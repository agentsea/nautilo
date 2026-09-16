import { execFile } from "node:child_process";
import type {
  ComputerUseHostArchitecture,
  ComputerUseHostAttestor,
  ComputerUseHostRelease,
} from "./contracts.ts";

const CODESIGN = "/usr/bin/codesign";
const LIPO = "/usr/bin/lipo";
const DESKTOP_IDENTIFIER = "com.nautilo.desktop";
const COMPUTER_USE_HOST_IDENTIFIER = "com.nautilo.desktop.computer-use-host";
const MAX_COMMAND_OUTPUT = 64 * 1024;

export type MacosCommandResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;
export type MacosCommandRunner = (executable: string, argumentsValue: readonly string[], signal?: AbortSignal) => Promise<MacosCommandResult>;

const runMacosComputerUseHostCommand: MacosCommandRunner = async (executable, argumentsValue, signal) => await new Promise((resolve) => {
  const child = execFile(executable, [...argumentsValue], {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
    shell: false,
    ...(signal ? { signal } : {}),
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  }, (error, stdout, stderr) => resolve({
    code: error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0,
    stdout: String(stdout),
    stderr: String(stderr),
  }));
  child.stdin?.end();
});

type CodeIdentity = Readonly<{
  identifier: string;
  teamId: string;
  authority: string;
  designatedRequirement: string;
  hardenedRuntime: boolean;
}>;

export function parseDesignatedRequirement(output: string): string | null {
  const requirements = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("designated => "))
    .map((line) => line.slice("designated => ".length).trim());
  return requirements.length === 1 && requirements[0] ? requirements[0] : null;
}

function detailValue(output: string, name: string): string | null {
  const prefix = `${name}=`;
  const values = output.split(/\r?\n/u).filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
  return values.length === 1 && values[0] ? values[0] : null;
}

async function inspectIdentity(path: string, runner: MacosCommandRunner, signal?: AbortSignal): Promise<CodeIdentity | null> {
  const verified = await runner(CODESIGN, ["--verify", "--strict", "--verbose=4", path], signal);
  if (verified.code !== 0) return null;
  const details = await runner(CODESIGN, ["-dv", "--verbose=4", path], signal);
  const requirement = await runner(CODESIGN, ["-dr", "-", path], signal);
  if (details.code !== 0 || requirement.code !== 0) return null;
  const output = `${details.stdout}\n${details.stderr}`;
  const designated = parseDesignatedRequirement(`${requirement.stdout}\n${requirement.stderr}`) ?? "";
  const identifier = detailValue(output, "Identifier"); const teamId = detailValue(output, "TeamIdentifier");
  const authorities = output.split(/\r?\n/u).filter((line) => line.startsWith("Authority=")).map((line) => line.slice("Authority=".length).trim());
  const authority = authorities[0] ?? "";
  if (identifier === null || teamId === null || !/^[A-Z0-9]{10}$/u.test(teamId) || !authority.startsWith("Developer ID Application:")
    || designated.length === 0 || !/(?:Runtime Version=|flags=.*runtime)/iu.test(output)) return null;
  return Object.freeze({ identifier, teamId, authority, designatedRequirement: designated, hardenedRuntime: true });
}

export interface MacosComputerUseHostAttestorOptions {
  readonly desktopExecutable: string;
  readonly bundledEntrypoint: string;
  readonly runner?: MacosCommandRunner;
  readonly signal?: AbortSignal;
}

export class MacosComputerUseHostAttestor implements ComputerUseHostAttestor {
  private constructor(
    private readonly teamId: string,
    private readonly designatedRequirement: string,
    private readonly runner: MacosCommandRunner,
  ) {}

  static async create(options: MacosComputerUseHostAttestorOptions): Promise<MacosComputerUseHostAttestor> {
    const runner = options.runner ?? runMacosComputerUseHostCommand;
    const desktop = await inspectIdentity(options.desktopExecutable, runner, options.signal);
    const host = await inspectIdentity(options.bundledEntrypoint, runner, options.signal);
    if (desktop === null || host === null || desktop.identifier !== DESKTOP_IDENTIFIER || host.identifier !== COMPUTER_USE_HOST_IDENTIFIER
      || desktop.teamId !== host.teamId || desktop.authority !== host.authority) throw new Error("Computer Use Host trust anchor rejected");
    return new MacosComputerUseHostAttestor(host.teamId, host.designatedRequirement, runner);
  }

  trustedSignature(): ComputerUseHostRelease["signature"] {
    return Object.freeze({ teamId: this.teamId, designatedRequirement: this.designatedRequirement, notarized: true });
  }

  async verifyMacosRelease(entrypoint: string, release: ComputerUseHostRelease, expectedArchitectures: readonly ComputerUseHostArchitecture[], signal?: AbortSignal): Promise<boolean> {
    if (release.signature.teamId !== this.teamId || release.signature.designatedRequirement !== this.designatedRequirement || release.signature.notarized !== true) return false;
    const identity = await inspectIdentity(entrypoint, this.runner, signal); if (identity === null || identity.identifier !== COMPUTER_USE_HOST_IDENTIFIER
      || identity.teamId !== this.teamId || identity.designatedRequirement !== this.designatedRequirement) return false;
    const architectures = await this.runner(LIPO, ["-archs", entrypoint], signal);
    const actual = architectures.stdout.trim().split(/\s+/u).filter(Boolean).map((architecture) => architecture === "x86_64" ? "x64" : architecture).sort();
    // `spctl --type execute` assesses app bundles, not standalone Mach-O tools. The protected
    // publisher attests Apple's accepted notary result; this local gate rechecks the signed bytes.
    return architectures.code === 0 && actual.join(",") === [...expectedArchitectures].sort().join(",");
  }

  async health(entrypoint: string, release: ComputerUseHostRelease, signal?: AbortSignal): Promise<boolean> {
    const result = await this.runner(entrypoint, ["--health"], signal);
    if (result.code !== 0 || result.stderr !== "") return false;
    try {
      const value = JSON.parse(result.stdout) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      return Object.keys(item).sort().join(",") === "component,schemaVersion,status,version"
        && item["schemaVersion"] === 1 && item["component"] === "nautilo-computer-use-host"
        && item["version"] === release.version && item["status"] === "ready";
    } catch { return false; }
  }
}
