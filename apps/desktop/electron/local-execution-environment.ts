import { homedir } from "node:os";
import { delimiter, isAbsolute } from "node:path";

/** Environment for an explicitly admitted Full Mac shell command. Installed
 * command lookup is part of that account-level grant; it is not a runtime
 * resolver for apply_patch or any other attested Nautilo tool. Never forward
 * Electron's account/provider tokens, loader variables, or shell startup hooks.
 */
export function createFullMacExecutionEnvironment(
  parentEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory: string = homedir(),
): Record<string, string> {
  const installedCommandPath = parentEnvironment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    HOME: homeDirectory,
    PATH: installedCommandPath.split(delimiter).filter(entry => isAbsolute(entry)).join(delimiter),
    LANG: "en_US.UTF-8",
  };
}
