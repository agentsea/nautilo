import * as nodeFs from "node:fs/promises";
import { join } from "node:path";

import type { ExecFn } from "./ComposeDriver.ts";
import {
  buildSshHostKeyArgs,
  expandTilde,
  runLocal,
  shellQuote,
} from "./remote-exec.ts";
import type { ComposeDriverProfile } from "./types.ts";

type FsAsync = {
  writeFile: typeof nodeFs.writeFile;
  mkdir: typeof nodeFs.mkdir;
  readFile: typeof nodeFs.readFile;
  rm: typeof nodeFs.rm;
};

export interface RemoteFs extends FsAsync {
  syncToRemote(): Promise<void>;
  /**
   * Writes directly on the remote host via a same-directory temporary file
   * followed by `mv`, so readers observe either the prior complete file or
   * the new complete file. Paths written this way are excluded from future
   * staging rsyncs, which otherwise use `--delete`.
   */
  writeFileAtomically(
    remoteAbsPath: string,
    contents: string,
    mode: number,
  ): Promise<void>;
  /**
   * Map a remote-host absolute path (the one used in `writeFile`) to its
   * local staging-tree equivalent. Callers need this when handing a path
   * to a tool that runs LOCALLY but references a file that was staged
   * (e.g. `docker compose --env-file <path>` — the docker CLI parses
   * `--env-file` client-side before sending anything to the daemon).
   */
  toLocalStagingPath(remoteAbsPath: string): string;
}

export interface CreateRemoteFsOptions {
  stagingRoot: string;
  remoteInstanceRoot: string;
  exec?: ExecFn;
}

export function createRemoteFs(
  profile: ComposeDriverProfile,
  opts: CreateRemoteFsOptions,
): RemoteFs {
  if (profile.transport !== "remote" || profile.ssh === undefined) {
    throw new Error(
      `createRemoteFs requires transport="remote" with an ssh block (profile=${profile.name})`,
    );
  }
  const ssh = profile.ssh;
  const port = ssh.port ?? 22;
  const identity =
    ssh.identity_file !== undefined ? expandTilde(ssh.identity_file) : undefined;
  const exec = opts.exec ?? runLocal;
  const stagingRoot = opts.stagingRoot;
  const remoteRoot = opts.remoteInstanceRoot.replace(/\/$/, "");
  const atomicRemoteRelativePaths = new Set<string>();

  function toStagingPath(absPath: string): string {
    if (absPath === remoteRoot || absPath.startsWith(remoteRoot + "/")) {
      const rel = absPath === remoteRoot ? "" : absPath.slice(remoteRoot.length + 1);
      return join(stagingRoot, rel);
    }
    return join(stagingRoot, "__abs__", absPath.replace(/^\//, ""));
  }

  function buildRemoteSshArgs(remoteCmd: string): string[] {
    const a: string[] = ["-p", String(port), "-o", "BatchMode=yes"];
    a.push(...buildSshHostKeyArgs(ssh));
    if (identity !== undefined) a.push("-i", identity);
    a.push(`${ssh.user}@${ssh.host}`, "--", remoteCmd);
    return a;
  }

  function relativeToRemoteRoot(absPath: string): string {
    if (remoteRoot === "/" && absPath.startsWith("/")) {
      return absPath.slice(1);
    }
    if (!absPath.startsWith(remoteRoot + "/")) {
      throw new Error(
        `remote-fs atomic write must target ${remoteRoot} (got ${absPath})`,
      );
    }
    return absPath.slice(remoteRoot.length + 1);
  }

  const fs: RemoteFs = {
    writeFile: (async (path: string, data, options) => {
      const staged = toStagingPath(String(path));
      await nodeFs.mkdir(join(staged, ".."), { recursive: true });
      return nodeFs.writeFile(staged, data, options);
    }) as typeof nodeFs.writeFile,

    mkdir: (async (path: string, options) => {
      const staged = toStagingPath(String(path));
      return nodeFs.mkdir(staged, options as Parameters<typeof nodeFs.mkdir>[1]);
    }) as typeof nodeFs.mkdir,

    readFile: (async (path: string, encoding) => {
      const staged = toStagingPath(String(path));
      try {
        return await nodeFs.readFile(staged, encoding as Parameters<typeof nodeFs.readFile>[1]);
      } catch {
        const res = await exec("ssh", buildRemoteSshArgs("cat " + shellQuote(String(path))), {
          stdio: "pipe",
        });
        if (res.code !== 0) {
          throw new Error(
            `remote-fs readFile failed (${path}): exit ${res.code}: ${res.stderr}`,
          );
        }
        return res.stdout as Awaited<ReturnType<typeof nodeFs.readFile>>;
      }
    }) as typeof nodeFs.readFile,

    rm: (async (path: string, _options) => {
      const res = await exec(
        "ssh",
        buildRemoteSshArgs("rm -rf " + shellQuote(String(path))),
        { stdio: "pipe" },
      );
      if (res.code !== 0) {
        throw new Error(`remote-fs rm failed (${path}): exit ${res.code}: ${res.stderr}`);
      }
    }) as typeof nodeFs.rm,

    async writeFileAtomically(
      remoteAbsPath: string,
      contents: string,
      mode: number,
    ): Promise<void> {
      const relative = relativeToRemoteRoot(remoteAbsPath);
      const temporary = `${remoteAbsPath}.tmp-${process.pid}-${Date.now()}`;
      const encoded = Buffer.from(contents, "utf8").toString("base64");
      const command = [
        "set -eu",
        `tmp=${shellQuote(temporary)}`,
        'trap \'rm -f -- "$tmp"\' 0',
        `printf %s ${shellQuote(encoded)} | base64 -d > "$tmp"`,
        `chmod ${mode.toString(8)} "$tmp"`,
        `mv -f -- "$tmp" ${shellQuote(remoteAbsPath)}`,
      ].join("; ");
      const res = await exec("ssh", buildRemoteSshArgs(command), {
        stdio: "pipe",
      });
      if (res.code !== 0) {
        throw new Error(
          `remote-fs atomic write failed (${remoteAbsPath}): exit ${res.code}: ${res.stderr}`,
        );
      }
      atomicRemoteRelativePaths.add(relative);
    },

    toLocalStagingPath(remoteAbsPath: string): string {
      return toStagingPath(remoteAbsPath);
    },

    async syncToRemote(): Promise<void> {
      const mkres = await exec(
        "ssh",
        buildRemoteSshArgs("mkdir -p " + shellQuote(remoteRoot)),
        { stdio: "pipe" },
      );
      if (mkres.code !== 0) {
        throw new Error(
          `remote-fs syncToRemote mkdir failed: exit ${mkres.code}: ${mkres.stderr}`,
        );
      }
      const sshSpec = [
        "ssh",
        "-p",
        String(port),
        "-o",
        "BatchMode=yes",
        ...buildSshHostKeyArgs(ssh),
      ];
      if (identity !== undefined) sshSpec.push("-i", identity);
      const rsyncArgs = [
        "-az",
        // The staging tree belongs to the operator workstation user. A root
        // SSH receiver can otherwise preserve that numeric uid/gid on the
        // target, leaving deployment directories owned by an unrelated local
        // identity. Target files belong to the authenticated SSH deployer.
        "--no-owner",
        "--no-group",
        "--delete",
        "-e",
        sshSpec.join(" "),
        ...[...atomicRemoteRelativePaths].flatMap((relative) => [
          "--exclude",
          relative,
        ]),
        stagingRoot.replace(/\/$/, "") + "/",
        `${ssh.user}@${ssh.host}:${remoteRoot}/`,
      ];
      const res = await exec("rsync", rsyncArgs, { stdio: "inherit" });
      if (res.code !== 0) {
        throw new Error(
          `remote-fs syncToRemote rsync failed: exit ${res.code}: ${res.stderr}`,
        );
      }
    },
  };

  return fs;
}
