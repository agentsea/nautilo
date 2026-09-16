import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expandTilde } from "./remote-exec.ts";
import type { SshProfile } from "./types.ts";

/**
 * Remote instance root for a `transport=remote` deploy.
 * Pattern matches local `~/.nautilo${suffix}`:
 *   instance_id=""    → <base>
 *   instance_id="prod"→ <base>-prod
 *
 * Caller is responsible for supplying `remote_path`. When unset, callers
 * should prefer `resolveRemoteBaseDir(ssh)` to pick a sensible default
 * (root → `/opt/nautilo`, non-root → `<remote $HOME>/nautilo`).
 */
export function remoteInstanceRootDir(opts: {
  remote_path?: string | undefined;
  instance_id?: string | undefined;
}): string {
  const base = (opts.remote_path ?? "/opt/nautilo").replace(/\/$/, "");
  const id = (opts.instance_id ?? "").trim();
  const suffix = id === "" ? "" : `-${id}`;
  return `${base}${suffix}`;
}

/**
 * Pick the default remote base directory for a profile that has no
 * explicit `remote_path` set:
 *   - SSH user is `root` → `/opt/nautilo` (legacy convention).
 *   - Else → probe the remote `$HOME` over SSH and use `<home>/nautilo`,
 *     because non-root users typically can't write to `/opt/`.
 *
 * The probe is a single `ssh user@host pwd` (the default cwd for a
 * non-login shell is the user's home). Inject `runProbe` for tests.
 *
 * Returns the BASE dir (without the instance suffix). Callers pass it
 * to `remoteInstanceRootDir({remote_path: base, instance_id: …})`.
 */
export function resolveRemoteBaseDir(
  ssh: SshProfile,
  opts: {
    runProbe?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
  } = {},
): string {
  if (ssh.user === "root") return "/opt/nautilo";
  const probe = opts.runProbe ?? defaultProbe;
  const sshArgs: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-p",
    String(ssh.port ?? 22),
  ];
  if (ssh.identity_file !== undefined) sshArgs.push("-i", expandTilde(ssh.identity_file));
  sshArgs.push(`${ssh.user}@${ssh.host}`, "--", "pwd");
  const res = probe("ssh", sshArgs);
  if (res.code !== 0) {
    throw new Error(
      `resolveRemoteBaseDir: could not probe remote $HOME via \`ssh ${ssh.user}@${ssh.host} pwd\` (exit ${res.code}): ${res.stderr.trim().slice(0, 200)}`,
    );
  }
  const home = res.stdout.trim();
  if (!home.startsWith("/")) {
    throw new Error(
      `resolveRemoteBaseDir: remote pwd returned non-absolute path '${home}'`,
    );
  }
  return `${home}/nautilo`;
}

function defaultProbe(
  cmd: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Operator-side instance root (`~/.nautilo${suffix}`) — used for
 * backups/restore targets and other operator-laptop state when
 * running against a remote profile.
 */
export function localInstanceRootDir(
  home: string,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents -- exactOptionalPropertyTypes requires explicit undefined for callers that pass possibly-undefined values
  instance_id?: string | undefined,
): string {
  const id = (instance_id ?? "").trim();
  const suffix = id === "" ? "" : `-${id}`;
  return join(home, `.nautilo${suffix}`);
}

/** Default local staging root under <home>/.nautilo${suffix}/.remote-staging. */
export function defaultStagingRoot(opts: {
  home: string;
  instance_id?: string | undefined;
}): string {
  return join(localInstanceRootDir(opts.home, opts.instance_id), ".remote-staging");
}
