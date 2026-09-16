import { existsSync, statSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import {
  assertRemoteDeploymentManifestIdentity,
  buildSshHostKeyArgs,
  composeProjectName,
  dockerEnvForProfile,
  localInstanceRootDir,
  remoteDeploymentManifestSchema,
  remoteInstanceRootDir,
  resolveRemoteBaseDir,
  type SshProfile,
} from "@nautilo/compose-driver";
import type { Profile } from "./profile-schema.ts";

export type DoctorCheck = { name: string; status: "ok" | "warn" | "fail"; message: string };

/**
 * D427 (Wave 3 task 3.2.2) — a read-only DNS resolution observation used by
 * the remote doctor's split-horizon checks. `ipv4`/`ipv6` are the unique
 * resolved addresses (order preserved); `error` is set when no resolver
 * was available or the lookup failed. The doctor NEVER mutates DNS or
 * `/etc/hosts` — these checks only READ.
 */
export interface DnsResolution {
  host: string;
  ipv4: string[];
  ipv6: string[];
  error?: string;
}

export interface RemoteDoctorDeps {
  home: string;
  /** Inject for tests. Default uses node:child_process.spawnSync. */
  runCmd?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
  /** Inject for tests (docker via DOCKER_HOST). */
  runCmdWithEnv?: (
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => { code: number; stdout: string; stderr: string };
  /** Inject for tests. */
  fileExists?: (path: string) => boolean;
  /** Inject for tests. */
  fileMode?: (path: string) => number;
  /** Inject for tests. */
  which?: (binary: string) => string | null;
  /**
   * D427 (Wave 3 task 3.2.2) — injectable read-only DNS resolver for the
   * split-horizon checks. `scope="operator"` resolves from the operator
   * machine; `scope="target"` resolves from the remote target over SSH.
   * Defaults to `getent ahosts` / `dig +short` (read-only).
   */
  resolveDns?: (host: string, scope: "operator" | "target") => DnsResolution;
}

export interface RemoteDoctorOptions {
  /**
   * Trust an unseen host key using OpenSSH TOFU semantics. OpenSSH still
   * rejects changed keys, so this can never overwrite a mismatch.
   */
  acceptNewHostKey?: boolean;
}

export function runRemoteDoctorChecks(
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
  deps: RemoteDoctorDeps,
  options: RemoteDoctorOptions = {},
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const run = deps.runCmd ?? defaultRunCmd;
  const runWithEnv = deps.runCmdWithEnv ?? defaultRunCmdWithEnv;
  const fileExists = deps.fileExists ?? existsSync;
  const fileMode = deps.fileMode ?? ((p) => statSync(p).mode & 0o777);
  const which = deps.which ?? defaultWhich;

  for (const bin of ["docker", "ssh", "rsync"]) {
    const path = which(bin);
    checks.push(
      path
        ? { name: `operator binary: ${bin}`, status: "ok", message: path }
        : { name: `operator binary: ${bin}`, status: "fail", message: `not found on operator PATH — install ${bin}` },
    );
  }

  if (profile.ssh === undefined) {
    checks.push({ name: "profile.ssh", status: "fail", message: "missing ssh block (schema bug?)" });
    return checks;
  }
  const hostKeyArgs = doctorSshHostKeyArgs(
    profile.ssh,
    options.acceptNewHostKey === true,
  );

  if (profile.ssh.identity_file !== undefined) {
    const ident = profile.ssh.identity_file.startsWith("~/")
      ? deps.home + profile.ssh.identity_file.slice(1)
      : profile.ssh.identity_file;
    if (!fileExists(ident)) {
      checks.push({ name: `ssh.identity_file`, status: "fail", message: `${ident}: file not found` });
    } else {
      try {
        const mode = fileMode(ident);
        if (mode !== 0o600 && mode !== 0o400) {
          checks.push({ name: `ssh.identity_file`, status: "warn", message: `${ident}: chmod is 0${mode.toString(8)} (recommended 0600 or 0400)` });
        } else {
          checks.push({ name: `ssh.identity_file`, status: "ok", message: `${ident} (chmod 0${mode.toString(8)})` });
        }
      } catch {
        checks.push({ name: `ssh.identity_file`, status: "warn", message: `${ident}: stat failed` });
      }
    }
  }

  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-p",
    String(profile.ssh.port ?? 22),
    ...hostKeyArgs,
  ];
  if (profile.ssh.identity_file !== undefined) sshArgs.push("-i", profile.ssh.identity_file);
  sshArgs.push(`${profile.ssh.user}@${profile.ssh.host}`, "--", "echo", "ok");
  const sshRes = run("ssh", sshArgs);
  checks.push(
    sshRes.code === 0
      ? { name: "ssh reachable", status: "ok", message: `${profile.ssh.user}@${profile.ssh.host}:${profile.ssh.port ?? 22} OK` }
      : {
          name: "ssh reachable",
          status: "fail",
          message: formatSshReachabilityFailure(
            profile,
            sshRes.code,
            sshRes.stderr,
            options.acceptNewHostKey === true,
          ),
        },
  );

  if (sshRes.code === 0) {
    const remoteSshArgs = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-p",
      String(profile.ssh.port ?? 22),
      ...hostKeyArgs,
    ];
    if (profile.ssh.identity_file !== undefined) remoteSshArgs.push("-i", profile.ssh.identity_file);
    remoteSshArgs.push(`${profile.ssh.user}@${profile.ssh.host}`, "--", "command", "-v", "docker");
    const remoteDockerRes = run("ssh", remoteSshArgs);
    if (remoteDockerRes.code !== 0 || remoteDockerRes.stdout.trim() === "") {
      checks.push({
        name: "remote: docker on PATH",
        status: "fail",
        message:
          "remote SSH session has no `docker` in PATH. Install Docker on the remote (macOS: `brew install --cask orbstack`; Linux: distro package). " +
          "If docker is installed but missing in non-interactive SSH sessions, append PATH to `~/.zshenv` (zsh) or `~/.bashrc` (bash) on the remote.",
      });
    } else {
      checks.push({
        name: "remote: docker on PATH",
        status: "ok",
        message: remoteDockerRes.stdout.trim(),
      });

      // Remote instance dir writable.
      let remoteBase: string | undefined;
      try {
        remoteBase =
          profile.remote_path !== undefined && profile.remote_path.trim() !== ""
            ? profile.remote_path
            : resolveRemoteBaseDir(profile.ssh, {
                runProbe: (cmd, args) => run(cmd, args),
              });
      } catch (err) {
        checks.push({
          name: "remote: instance dir writable",
          status: "fail",
          message: err instanceof Error ? err.message : String(err),
        });
        remoteBase = undefined;
      }
      if (remoteBase !== undefined) {
        const remoteRoot = remoteInstanceRootDir({
          remote_path: remoteBase,
          instance_id: profile.instance_id,
        });
        const writeArgs: string[] = [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "-p",
          String(profile.ssh.port ?? 22),
          ...hostKeyArgs,
        ];
        if (profile.ssh.identity_file !== undefined) writeArgs.push("-i", profile.ssh.identity_file);
        writeArgs.push(
          `${profile.ssh.user}@${profile.ssh.host}`,
          "--",
          `mkdir -p ${remoteRoot} 2>&1 && test -w ${remoteRoot}`,
        );
        const writeRes = run("ssh", writeArgs);
        checks.push(
          writeRes.code === 0
            ? {
                name: "remote: instance dir writable",
                status: "ok",
                message: `${remoteRoot} OK`,
              }
            : {
                name: "remote: instance dir writable",
                status: "fail",
                message:
                  `${remoteRoot} not writable by ${profile.ssh.user}: ` +
                  (writeRes.stderr.trim() || writeRes.stdout.trim() || `exit ${writeRes.code}`).slice(0, 200) +
                  ` — set \`remote_path = "/path/under/${profile.ssh.user}-home"\` in the profile TOML.`,
              },
        );

        checks.push(checkRemoteDeploymentManifest(profile, remoteRoot, run));
      }

      const dockerEnv = dockerEnvForProfile(profile as never).env ?? process.env;
      const dockerRes = runWithEnv("docker", ["info", "--format", "{{.ServerVersion}}"], dockerEnv);
      checks.push(
        dockerRes.code === 0
          ? { name: "docker daemon (via SSH)", status: "ok", message: `Docker ${dockerRes.stdout.trim()}` }
          : {
              name: "docker daemon (via SSH)",
              status: "fail",
              message:
                (dockerRes.stderr.trim().slice(0, 200) || `exit ${dockerRes.code}`) +
                " — daemon may not be running; start Docker Desktop / OrbStack / colima on the remote.",
            },
      );
    }
  }

  const instanceRoot = localInstanceRootDir(deps.home, profile.instance_id);
  try {
    const parentExists = fileExists(deps.home);
    checks.push(
      parentExists
        ? { name: "operator state dir", status: "ok", message: `${instanceRoot} (parent writable)` }
        : { name: "operator state dir", status: "fail", message: `${deps.home}: HOME not found` },
    );
  } catch {
    checks.push({ name: "operator state dir", status: "warn", message: `${instanceRoot}: stat failed` });
  }

  // D427 (Wave 3 task 3.2.2) — read-only DNS / base_url / target-IP split-horizon
  // observations. These checks NEVER mutate DNS or /etc/hosts; they only READ
  // resolved addresses so a mismatch is visible BEFORE any deploy mutation.
  const resolveDns =
    deps.resolveDns ?? ((host: string, scope: "operator" | "target") =>
      defaultResolveDns(host, scope, profile, run));
  checks.push(...runDnsObservationChecks(profile, resolveDns));

  return checks;
}

function doctorSshHostKeyArgs(
  ssh: SshProfile,
  acceptNewHostKey: boolean,
): string[] {
  const args = buildSshHostKeyArgs(ssh);
  if (!acceptNewHostKey) return args;
  const strictIndex = args.indexOf("StrictHostKeyChecking=yes");
  if (strictIndex >= 0) {
    args[strictIndex] = "StrictHostKeyChecking=accept-new";
    return args;
  }
  return [...args, "-o", "StrictHostKeyChecking=accept-new"];
}

function formatSshReachabilityFailure(
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
  code: number,
  stderr: string,
  acceptNewHostKey: boolean,
): string {
  const detail = stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/u.test(detail)) {
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(detail)) {
      return (
        `exit ${code}: SSH host key changed for ${profile.ssh!.host}; refusing to trust it. ` +
        "Verify the server fingerprint and remove the stale known_hosts entry manually only if the replacement is expected."
      );
    }
    if (!acceptNewHostKey) {
      return (
        `exit ${code}: host key is not trusted for ${profile.ssh!.host}. ` +
        `After verifying the server fingerprint, rerun \`nautilo doctor remote ${profile.name} --accept-new-host-key\`.`
      );
    }
    return (
      `exit ${code}: host-key enrollment failed for ${profile.ssh!.host}; ` +
      "verify the server fingerprint and inspect the applicable known_hosts entry."
    );
  }
  return `exit ${code}: ${detail.slice(0, 200) || "no stderr"}`;
}

function buildSshArgs(
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
  ...remoteCmd: string[]
): string[] {
  const ssh = profile.ssh!;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-p",
    String(ssh.port ?? 22),
    ...buildSshHostKeyArgs(ssh),
  ];
  if (ssh.identity_file !== undefined) args.push("-i", ssh.identity_file);
  args.push(`${ssh.user}@${ssh.host}`, "--", ...remoteCmd);
  return args;
}

function checkRemoteDeploymentManifest(
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
  remoteRoot: string,
  run: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string },
): DoctorCheck {
  const manifestPath = `${remoteRoot}/deployment-manifest.json`;
  const catRes = run("ssh", buildSshArgs(profile, "cat", manifestPath));
  const checkName = "remote: deployment manifest";

  if (catRes.code !== 0) {
    const errSnippet = (catRes.stderr.trim() || catRes.stdout.trim()).slice(0, 120);
    return {
      name: checkName,
      status: "warn",
      message:
        `${manifestPath} not found or unreadable` +
        (errSnippet ? ` (${errSnippet})` : "") +
        `. Deploy will only proceed if ${remoteRoot} is fresh (empty) or you explicitly adopt the existing remote deployment.`,
    };
  }

  const raw = catRes.stdout.trim();
  if (raw === "") {
    return {
      name: checkName,
      status: "warn",
      message: `${manifestPath} is empty — re-deploy the instance or fix the file on the remote host.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      name: checkName,
      status: "warn",
      message: `${manifestPath} is not valid JSON — re-deploy the instance or fix the file on the remote host.`,
    };
  }

  const validated = remoteDeploymentManifestSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      name: checkName,
      status: "warn",
      message: `${manifestPath} failed schema validation — re-deploy the instance or fix the file on the remote host.`,
    };
  }

  const instanceId = (profile.instance_id ?? "").trim();
  try {
    assertRemoteDeploymentManifestIdentity(validated.data, {
      instanceId,
      composeProjectName: composeProjectName(profile),
      remoteRoot,
    });
  } catch (err) {
    return {
      name: checkName,
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    name: checkName,
    status: "ok",
    message: `instanceId=${validated.data.instanceId} composeProjectName=${validated.data.composeProjectName} remoteRoot=${validated.data.remoteRoot}`,
  };
}

function defaultRunCmd(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function defaultRunCmdWithEnv(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function defaultWhich(bin: string): string | null {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// D427 (Wave 3 task 3.2.2) — read-only DNS / base_url / target-IP split-horizon
// observations. The doctor reports app/auth DNS A/AAAA, profile/base_url
// consistency, the expected target IP, and operator-vs-target split-horizon
// differences. It NEVER edits DNS or /etc/hosts — every helper below only
// READS resolved addresses.
// ---------------------------------------------------------------------------

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isIpLiteral(host: string): boolean {
  return IPV4_RE.test(host) || host.includes(":");
}

/**
 * Resolve the DNS hostnames the doctor should observe for a remote compose
 * profile, plus the expected target IP. Returns `appHost`/`authHost` only
 * when a real DNS NAME (not an IP literal) is configured — DNS observation
 * is meaningless for an `http://<ssh.host>:<port>` base_url whose host is an
 * IP. `expectedTargetIp` is `ssh.host` when it is itself an IP literal.
 */
function resolveProfileDnsHosts(
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
): {
  appHost: string | undefined;
  authHost: string | undefined;
  expectedTargetIp: string | undefined;
  baseUrlHost: string | undefined;
  domain: string | undefined;
} {
  const domain = profile.domain?.trim() || undefined;
  const baseUrl = profile.base_url?.trim() || undefined;
  let baseUrlHost: string | undefined;
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      baseUrlHost = u.hostname;
    } catch {
      baseUrlHost = undefined;
    }
  }
  // appHost: prefer the base_url hostname, then the apex domain. Skip IP
  // literals — there is no DNS record to observe for an IP.
  const appHostCandidate = baseUrlHost ?? domain;
  const appHost = appHostCandidate && !isIpLiteral(appHostCandidate) ? appHostCandidate : undefined;
  // authHost: only meaningful under letsencrypt, where Caddy fronts auth.<domain>.
  const authHost =
    profile.https === "letsencrypt" && domain && !isIpLiteral(domain) ? `auth.${domain}` : undefined;
  const expectedTargetIp = profile.ssh?.host && isIpLiteral(profile.ssh.host) ? profile.ssh.host : undefined;
  return { appHost, authHost, expectedTargetIp, baseUrlHost, domain };
}

function formatDns(res: DnsResolution): string {
  if (res.error) return `${res.host}: ${res.error}`;
  const parts: string[] = [];
  if (res.ipv4.length > 0) parts.push(`A=${res.ipv4.join(",")}`);
  if (res.ipv6.length > 0) parts.push(`AAAA=${res.ipv6.join(",")}`);
  if (parts.length === 0) return `${res.host}: no addresses resolved`;
  return `${res.host}: ${parts.join(" ")}`;
}

function uniqueAddresses(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Build the read-only DNS observation checks. Mismatches are `warn` (never
 * `fail`) so `nautilo upgrade`'s doctor preflight — which fails only on
 * `fail`-status checks — does not block on a DNS split-horizon that the
 * operator may have intentionally configured. The checks surface the
 * mismatch clearly so it can be reviewed before deploy mutation.
 */
function runDnsObservationChecks(
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
  resolveDns: (host: string, scope: "operator" | "target") => DnsResolution,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const { appHost, authHost, expectedTargetIp, baseUrlHost, domain } = resolveProfileDnsHosts(profile);

  // profile / base_url consistency: under letsencrypt the base_url host MUST
  // equal the apex domain (Caddy serves the apex vhost). A mismatch is a
  // config bug worth surfacing before mutation.
  if (profile.https === "letsencrypt" && domain && baseUrlHost && baseUrlHost !== domain) {
    checks.push({
      name: "remote: profile base_url consistency",
      status: "warn",
      message: `base_url host '${baseUrlHost}' differs from domain '${domain}' (https=letsencrypt serves the apex domain); correct the profile before deploy.`,
    });
  } else if (baseUrlHost && domain && baseUrlHost !== domain && !isIpLiteral(baseUrlHost)) {
    checks.push({
      name: "remote: profile base_url consistency",
      status: "ok",
      message: `base_url host '${baseUrlHost}' (domain='${domain ?? "<unset>"}')`,
    });
  }

  if (appHost === undefined && authHost === undefined) {
    // No DNS NAME is configured (base_url/domain unset or an IP literal).
    // Deploy routes via ssh.host IP, so public DNS cannot direct an upgrade
    // to a different host — the D427 3.1.1 risk does not apply. This is ok,
    // not a warning: there is genuinely nothing to observe.
    checks.push({
      name: "remote: DNS observation",
      status: "ok",
      message:
        "no DNS hostname configured (base_url/domain unset or an IP literal); deploy routes via ssh.host IP, so public DNS cannot misroute an upgrade and split-horizon DNS is not observable.",
    });
    return checks;
  }

  if (appHost) {
    const opRes = resolveDns(appHost, "operator");
    const tgtRes = resolveDns(appHost, "target");
    checks.push(
      opRes.error
        ? { name: "remote: app DNS (operator)", status: "warn", message: formatDns(opRes) }
        : { name: "remote: app DNS (operator)", status: "ok", message: formatDns(opRes) },
    );
    checks.push(
      tgtRes.error
        ? { name: "remote: app DNS (target)", status: "warn", message: formatDns(tgtRes) }
        : { name: "remote: app DNS (target)", status: "ok", message: formatDns(tgtRes) },
    );

    // Expected target IP: the app host should resolve (from the operator) to
    // the deployment target IP. A mismatch means public DNS would direct an
    // upgrade elsewhere — exactly the D427 3.1.1 risk.
    if (expectedTargetIp) {
      const opIps = [...opRes.ipv4, ...opRes.ipv6];
      if (opRes.error || opIps.length === 0) {
        checks.push({
          name: "remote: target IP vs app DNS",
          status: "warn",
          message: `expected target IP ${expectedTargetIp}; operator could not resolve ${appHost} (${opRes.error ?? "no addresses"})`,
        });
      } else if (opIps.includes(expectedTargetIp)) {
        checks.push({
          name: "remote: target IP vs app DNS",
          status: "ok",
          message: `${appHost} → ${opIps.join(",")} (includes target ${expectedTargetIp})`,
        });
      } else {
        checks.push({
          name: "remote: target IP vs app DNS",
          status: "warn",
          message: `${appHost} → ${opIps.join(",")} does NOT include the SSH target ${expectedTargetIp}; public DNS would route an upgrade to a different host than the SSH deployment target.`,
        });
      }
    }

    // Split-horizon: operator vs target resolution of the SAME name.
    const opIps = uniqueAddresses([...opRes.ipv4, ...opRes.ipv6]);
    const tgtIps = uniqueAddresses([...tgtRes.ipv4, ...tgtRes.ipv6]);
    const same =
      opIps.length === tgtIps.length && opIps.every((ip, i) => ip === tgtIps[i]);
    if (opRes.error || tgtRes.error) {
      // already surfaced per-scope above; no extra check.
    } else if (same) {
      checks.push({
        name: "remote: app DNS split-horizon",
        status: "ok",
        message: `operator and target resolve ${appHost} identically (${opIps.join(",") || "none"})`,
      });
    } else {
      checks.push({
        name: "remote: app DNS split-horizon",
        status: "warn",
        message: `operator resolves ${appHost} → [${opIps.join(",") || "none"}] but target resolves → [${tgtIps.join(",") || "none"}]; a /etc/hosts override or split-horizon DNS on the target may route the deploy differently than the operator expects.`,
      });
    }
  }

  if (authHost) {
    const opRes = resolveDns(authHost, "operator");
    const tgtRes = resolveDns(authHost, "target");
    checks.push(
      opRes.error
        ? { name: "remote: auth DNS (operator)", status: "warn", message: formatDns(opRes) }
        : { name: "remote: auth DNS (operator)", status: "ok", message: formatDns(opRes) },
    );
    checks.push(
      tgtRes.error
        ? { name: "remote: auth DNS (target)", status: "warn", message: formatDns(tgtRes) }
        : { name: "remote: auth DNS (target)", status: "ok", message: formatDns(tgtRes) },
    );
    const opIps = uniqueAddresses([...opRes.ipv4, ...opRes.ipv6]);
    const tgtIps = uniqueAddresses([...tgtRes.ipv4, ...tgtRes.ipv6]);
    const same =
      opIps.length === tgtIps.length && opIps.every((ip, i) => ip === tgtIps[i]);
    if (!opRes.error && !tgtRes.error && !same) {
      checks.push({
        name: "remote: auth DNS split-horizon",
        status: "warn",
        message: `operator resolves ${authHost} → [${opIps.join(",") || "none"}] but target resolves → [${tgtIps.join(",") || "none"}]`,
      });
    } else if (!opRes.error && !tgtRes.error && same) {
      checks.push({
        name: "remote: auth DNS split-horizon",
        status: "ok",
        message: `operator and target resolve ${authHost} identically (${opIps.join(",") || "none"})`,
      });
    }
  }

  return checks;
}

function parseGetentAhosts(stdout: string): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const ip = line.trim().split(/\s+/)[0] ?? "";
    if (!ip) continue;
    if (IPV4_RE.test(ip)) ipv4.push(ip);
    else if (ip.includes(":")) ipv6.push(ip);
  }
  return { ipv4: uniqueAddresses(ipv4), ipv6: uniqueAddresses(ipv6) };
}

function parseDigShort(stdout: string): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const ip = line.trim();
    if (!ip) continue;
    if (IPV4_RE.test(ip)) ipv4.push(ip);
    else if (ip.includes(":")) ipv6.push(ip);
  }
  return { ipv4: uniqueAddresses(ipv4), ipv6: uniqueAddresses(ipv6) };
}

/**
 * Default read-only DNS resolver. Operator scope uses a local `getent ahosts`
 * (falls back to `dig +short`); target scope runs the same lookup over SSH on
 * the deployment target. Both paths are READ-ONLY — no DNS or /etc/hosts
 * mutation is ever performed.
 */
function defaultResolveDns(
  host: string,
  scope: "operator" | "target",
  profile: Profile & { transport: "remote"; lifecycle: "compose" },
  run: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string },
): DnsResolution {
  const base: DnsResolution = { host, ipv4: [], ipv6: [] };
  if (scope === "operator") {
    const getent = spawnSync("getent", ["ahosts", host], { encoding: "utf8" });
    if (getent.status === 0 && getent.stdout.trim() !== "") {
      return { ...base, ...parseGetentAhosts(getent.stdout) };
    }
    const digA = spawnSync("dig", ["+short", host, "A"], { encoding: "utf8" });
    const digAaaa = spawnSync("dig", ["+short", host, "AAAA"], { encoding: "utf8" });
    if (digA.status === 0 || digAaaa.status === 0) {
      return {
        ...base,
        ...parseDigShort(`${digA.stdout ?? ""}${digAaaa.stdout ?? ""}`),
      };
    }
    return { ...base, error: "no local DNS resolver (getent/dig) available on the operator" };
  }
  // target scope — run the same read-only lookup over SSH.
  const sshArgs = buildSshArgs(profile, "getent", "ahosts", host);
  const getentRes = run("ssh", sshArgs);
  if (getentRes.code === 0 && getentRes.stdout.trim() !== "") {
    return { ...base, ...parseGetentAhosts(getentRes.stdout) };
  }
  const digArgs = buildSshArgs(profile, "sh", "-c", `dig +short ${host} A; dig +short ${host} AAAA`);
  const digRes = run("ssh", digArgs);
  if (digRes.code === 0 && digRes.stdout.trim() !== "") {
    return { ...base, ...parseDigShort(digRes.stdout) };
  }
  return { ...base, error: "no DNS resolver (getent/dig) available on the remote target" };
}
