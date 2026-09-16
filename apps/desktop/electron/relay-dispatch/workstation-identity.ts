import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Narrow workstation identity projected into a contained shell. HOME and the
 * Keychain database remain outside the sandbox; only the existing GitHub token
 * and github.com-scoped Git helper configuration reach the child process.
 */
export interface ContainedWorkstationIdentityProjection {
  readonly commandEnv: Readonly<Record<string, string>>;
  readonly outputSecrets: readonly Buffer[];
}

async function readLocalGitHubToken(
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      signal === undefined ? {} : { signal },
    );
    const token = stdout.trim();
    if (token.length < 6 || Buffer.byteLength(token, "utf8") > 4096) return null;
    return token;
  } catch {
    return null;
  }
}

export async function resolveContainedWorkstationIdentityProjection(
  homeDir: string,
  readGitHubToken: (
    signal?: AbortSignal,
  ) => Promise<string | null> = readLocalGitHubToken,
  signal?: AbortSignal,
): Promise<ContainedWorkstationIdentityProjection> {
  const commandEnv: Record<string, string> = {};
  const outputSecrets: Buffer[] = [];

  try {
    accessSync(join(homeDir, ".config", "gh"), constants.R_OK);
  } catch {
    return { commandEnv, outputSecrets };
  }

  const token = await readGitHubToken(signal);
  if (token === null) return { commandEnv, outputSecrets };

  commandEnv["GH_TOKEN"] = token;
  commandEnv["GIT_CONFIG_COUNT"] = "2";
  commandEnv["GIT_CONFIG_KEY_0"] = "credential.https://github.com.helper";
  commandEnv["GIT_CONFIG_VALUE_0"] = "";
  commandEnv["GIT_CONFIG_KEY_1"] = "credential.https://github.com.helper";
  commandEnv["GIT_CONFIG_VALUE_1"] = "!gh auth git-credential";
  commandEnv["GH_TELEMETRY"] = "0";
  commandEnv["DO_NOT_TRACK"] = "1";
  commandEnv["GH_NO_UPDATE_NOTIFIER"] = "1";
  commandEnv["GH_NO_EXTENSION_UPDATE_NOTIFIER"] = "1";
  outputSecrets.push(Buffer.from(token, "utf8"));
  return { commandEnv, outputSecrets };
}
