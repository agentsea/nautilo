import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeProjectName, remoteInstanceRootDir } from "@nautilo/compose-driver";
import type { Profile } from "../../src/lib/profile-schema.ts";
import { runRemoteDoctorChecks } from "../../src/lib/remote-doctor.ts";

const remoteProfile: Profile & { transport: "remote"; lifecycle: "compose" } = {
  name: "do-test",
  transport: "remote",
  lifecycle: "compose",
  instance_id: "prod",
  ssh: { host: "203.0.113.7", user: "root", port: 22 },
};

function expectedRemoteRoot(profile: typeof remoteProfile): string {
  const base =
    profile.remote_path !== undefined && profile.remote_path.trim() !== ""
      ? profile.remote_path
      : profile.ssh!.user === "root"
        ? "/opt/nautilo"
        : "/Users/alice/nautilo";
  return remoteInstanceRootDir({ remote_path: base, instance_id: profile.instance_id });
}

function validManifestJson(profile: typeof remoteProfile, remoteRoot: string): string {
  return JSON.stringify({
    version: 1,
    instanceId: (profile.instance_id ?? "").trim(),
    composeProjectName: composeProjectName(profile),
    lifecycle: "compose",
    image: { mode: "registry", reference: "ghcr.io/example/nautilo:1.0.0" },
    remoteRoot,
    https: "off",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function baseDeps(
  home: string,
  profile: typeof remoteProfile = remoteProfile,
  over: Partial<Parameters<typeof runRemoteDoctorChecks>[1]> = {},
) {
  const remoteRoot = expectedRemoteRoot(profile);
  const manifestJson = validManifestJson(profile, remoteRoot);
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  return {
    deps: {
      home,
      which: (bin: string) => `/usr/bin/${bin}`,
      fileExists: (p: string) => p === home || p.startsWith(home),
      fileMode: () => 0o600,
      runCmd: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === "ssh" && args.includes("cat") && args.some((a) => a.includes("deployment-manifest.json"))) {
          return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
        }
        if (cmd === "ssh") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      runCmdWithEnv: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
        calls.push({ cmd, args, env });
        if (cmd === "docker") {
          return { code: 0, stdout: "24.0.7\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      ...over,
    },
    calls,
    remoteRoot,
  };
}

describe("runRemoteDoctorChecks", () => {
  test("all binaries present + ssh reachable + docker info OK → all checks ok", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps } = baseDeps(home);
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.find((c) => c.name === "docker daemon (via SSH)")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "remote: deployment manifest")?.status).toBe("ok");
  });

  test("dedicated known_hosts file applies strict host-key checking to every SSH doctor probe", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const profile: typeof remoteProfile = {
      ...remoteProfile,
      ssh: {
        host: remoteProfile.ssh!.host,
        user: remoteProfile.ssh!.user,
        port: remoteProfile.ssh!.port,
        known_hosts_file: "/tmp/nautilo-known-hosts",
      },
    };
    const { deps, calls } = baseDeps(home, profile);

    runRemoteDoctorChecks(profile, deps);

    const sshCalls = calls.filter((call) => call.cmd === "ssh");
    expect(sshCalls.length).toBeGreaterThan(0);
    for (const call of sshCalls) {
      expect(call.args).toContain("UserKnownHostsFile=/tmp/nautilo-known-hosts");
      expect(call.args).toContain("StrictHostKeyChecking=yes");
    }
  });

  test("missing rsync → that check fail, others fine", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps } = baseDeps(home, remoteProfile, {
      which: (bin: string) => (bin === "rsync" ? null : `/usr/bin/${bin}`),
    });
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    expect(checks.find((c) => c.name === "operator binary: rsync")?.status).toBe("fail");
    expect(checks.find((c) => c.name === "operator binary: docker")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "ssh reachable")?.status).toBe("ok");
  });

  test("SSH reachability fails → SSH fail, docker not attempted", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const calls: { cmd: string }[] = [];
    const { deps } = baseDeps(home, remoteProfile, {
      runCmd: (cmd, _args) => {
        calls.push({ cmd });
        if (cmd === "ssh") {
          return { code: 255, stdout: "", stderr: "Connection refused" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      runCmdWithEnv: (cmd, _args) => {
        calls.push({ cmd });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    expect(checks.find((c) => c.name === "ssh reachable")?.status).toBe("fail");
    expect(checks.some((c) => c.name === "docker daemon (via SSH)")).toBe(false);
    expect(checks.some((c) => c.name === "remote: deployment manifest")).toBe(false);
    expect(calls.some((c) => c.cmd === "docker")).toBe(false);
  });

  test("unknown host key failure points to explicit TOFU enrollment", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps, calls } = baseDeps(home, remoteProfile, {
      runCmd: (cmd, args) => {
        calls.push({ cmd, args });
        return {
          code: 255,
          stdout: "",
          stderr: "Host key verification failed.",
        };
      },
    });

    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    const reachable = checks.find((c) => c.name === "ssh reachable");

    expect(reachable?.status).toBe("fail");
    expect(reachable?.message).toContain(
      "nautilo doctor remote do-test --accept-new-host-key",
    );
    expect(calls[0]!.args).not.toContain(
      "StrictHostKeyChecking=accept-new",
    );
  });

  test("explicit TOFU applies accept-new while preserving a dedicated known_hosts file", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const profile: typeof remoteProfile = {
      ...remoteProfile,
      ssh: {
        ...remoteProfile.ssh!,
        known_hosts_file: "/tmp/nautilo-known-hosts",
      },
    };
    const { deps, calls } = baseDeps(home, profile);

    runRemoteDoctorChecks(profile, deps, { acceptNewHostKey: true });

    const reachability = calls.find(
      (call) =>
        call.cmd === "ssh" &&
        call.args.at(-3) === "--" &&
        call.args.at(-2) === "echo",
    );
    expect(reachability?.args).toContain(
      "UserKnownHostsFile=/tmp/nautilo-known-hosts",
    );
    expect(reachability?.args).toContain(
      "StrictHostKeyChecking=accept-new",
    );
    expect(reachability?.args).not.toContain("StrictHostKeyChecking=yes");
  });

  test("changed host key remains a hard refusal even with TOFU enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps } = baseDeps(home, remoteProfile, {
      runCmd: () => ({
        code: 255,
        stdout: "",
        stderr:
          "@@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@@",
      }),
    });

    const checks = runRemoteDoctorChecks(remoteProfile, deps, {
      acceptNewHostKey: true,
    });
    const reachable = checks.find((c) => c.name === "ssh reachable");

    expect(reachable?.status).toBe("fail");
    expect(reachable?.message).toContain("SSH host key changed");
    expect(reachable?.message).toContain("refusing to trust it");
  });

  test("M207: no bootstrap token check for connection-only day-two operator", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps } = baseDeps(home);
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    expect(checks.some((c) => c.name === "bootstrap token")).toBe(false);
    expect(checks.filter((c) => c.status === "fail").length).toBe(0);
  });

  test("remote deployment manifest present and identity matches → ok", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps, remoteRoot } = baseDeps(home);
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    const manifest = checks.find((c) => c.name === "remote: deployment manifest");
    expect(manifest?.status).toBe("ok");
    expect(manifest?.message).toContain(`remoteRoot=${remoteRoot}`);
    expect(manifest?.message).toContain("composeProjectName=nautilo-prod");
  });

  test("remote deployment manifest absent → warn with fresh/adopt guidance", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps, remoteRoot } = baseDeps(home, remoteProfile, {
      runCmd: (cmd: string, args: string[]) => {
        if (cmd === "ssh" && args.includes("cat") && args.some((a) => a.includes("deployment-manifest.json"))) {
          return { code: 1, stdout: "", stderr: "cat: deployment-manifest.json: No such file or directory" };
        }
        if (cmd === "ssh") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    const manifest = checks.find((c) => c.name === "remote: deployment manifest");
    expect(manifest?.status).toBe("warn");
    expect(manifest?.message).toContain(`${remoteRoot}/deployment-manifest.json`);
    expect(manifest?.message).toMatch(/fresh \(empty\)|explicitly adopt/);
    expect(checks.filter((c) => c.status === "fail").length).toBe(0);
  });

  test("remote deployment manifest invalid JSON → warn, not fail", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { deps } = baseDeps(home, remoteProfile, {
      runCmd: (cmd: string, args: string[]) => {
        if (cmd === "ssh" && args.includes("cat") && args.some((a) => a.includes("deployment-manifest.json"))) {
          return { code: 0, stdout: "not-json\n", stderr: "" };
        }
        if (cmd === "ssh") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(remoteProfile, deps);
    const manifest = checks.find((c) => c.name === "remote: deployment manifest");
    expect(manifest?.status).toBe("warn");
    expect(manifest?.message).toMatch(/not valid JSON/);
  });

  test("remote deployment manifest identity mismatch → fail", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const { remoteRoot } = baseDeps(home);
    const badJson = validManifestJson(
      { ...remoteProfile, instance_id: "staging" },
      remoteRoot,
    );
    const { deps: mismatchDeps } = baseDeps(home, remoteProfile, {
      runCmd: (cmd: string, args: string[]) => {
        if (cmd === "ssh" && args.includes("cat") && args.some((a) => a.includes("deployment-manifest.json"))) {
          return { code: 0, stdout: `${badJson}\n`, stderr: "" };
        }
        if (cmd === "ssh") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(remoteProfile, mismatchDeps);
    const manifest = checks.find((c) => c.name === "remote: deployment manifest");
    expect(manifest?.status).toBe("fail");
    expect(manifest?.message).toMatch(/identity mismatch/);
    expect(manifest?.message).toMatch(/instanceId/);
  });

  test("remote instance dir not writable → fail with actionable message", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const nonRootProfile: Profile & { transport: "remote"; lifecycle: "compose" } = {
      ...remoteProfile,
      ssh: { host: "1.2.3.4", user: "alice", port: 22 },
      remote_path: "/opt/nautilo",
    };
    const { deps } = baseDeps(home, nonRootProfile, {
      runCmd: (cmd: string, args: string[]) => {
        if (cmd === "ssh" && args.some((a) => a.includes("mkdir -p"))) {
          return { code: 1, stdout: "", stderr: "mkdir: /opt/nautilo-prod: Permission denied" };
        }
        if (cmd === "ssh") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(nonRootProfile, deps);
    const writable = checks.find((c) => c.name === "remote: instance dir writable");
    expect(writable?.status).toBe("fail");
    expect(writable?.message).toMatch(/Permission denied/);
    expect(writable?.message).toMatch(/remote_path/);
  });

  test("non-root user with no remote_path → probes remote $HOME via pwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-"));
    const nonRootProfile: Profile & { transport: "remote"; lifecycle: "compose" } = {
      ...remoteProfile,
      ssh: { host: "1.2.3.4", user: "alice", port: 22 },
    };
    const pwdCalls: string[] = [];
    const { deps } = baseDeps(home, nonRootProfile, {
      runCmd: (cmd: string, args: string[]) => {
        if (cmd === "ssh" && args.includes("pwd")) {
          pwdCalls.push("probe");
          return { code: 0, stdout: "/Users/alice\n", stderr: "" };
        }
        if (cmd === "ssh") {
          return { code: 0, stdout: "ok\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(nonRootProfile, deps);
    expect(pwdCalls).toHaveLength(1);
    const writable = checks.find((c) => c.name === "remote: instance dir writable");
    expect(writable?.status).toBe("ok");
    expect(writable?.message).toContain("/Users/alice/nautilo-prod");
  });
});

// D427 (Wave 3 task 3.2.2) — read-only DNS / base_url / target-IP split-horizon
// observations. The doctor NEVER mutates DNS or /etc/hosts; mismatches are
// `warn` (never `fail`) so the upgrade doctor preflight does not block on a
// split-horizon the operator may have configured intentionally.
describe("runRemoteDoctorChecks DNS / split-horizon observations (D427 3.2.2)", () => {
  const leProfile: Profile & { transport: "remote"; lifecycle: "compose" } = {
    name: "do-le",
    transport: "remote",
    lifecycle: "compose",
    instance_id: "prod",
    https: "letsencrypt",
    domain: "nautilo.example.com",
    ssh: { host: "203.0.113.7", user: "root", port: 22 },
  };

  function dnsDeps(
    home: string,
    profile: typeof leProfile,
    over: Partial<Parameters<typeof runRemoteDoctorChecks>[1]> = {},
  ) {
    return baseDeps(home, profile, over);
  }

  test("app + auth DNS A/AAAA observed from operator and target; matching → ok", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const { deps } = dnsDeps(home, leProfile, {
      resolveDns: (host, scope) => ({
        host,
        ipv4: ["203.0.113.7"],
        ipv6: scope === "operator" ? [] : ["2001:db8::7"],
      }),
    });
    const checks = runRemoteDoctorChecks(leProfile, deps);
    const appOp = checks.find((c) => c.name === "remote: app DNS (operator)");
    const appTgt = checks.find((c) => c.name === "remote: app DNS (target)");
    const authOp = checks.find((c) => c.name === "remote: auth DNS (operator)");
    const authTgt = checks.find((c) => c.name === "remote: auth DNS (target)");
    expect(appOp?.status).toBe("ok");
    expect(appOp?.message).toContain("A=203.0.113.7");
    expect(appTgt?.status).toBe("ok");
    expect(authOp?.message).toContain("auth.nautilo.example.com");
    expect(authTgt?.status).toBe("ok");
  });

  test("operator app DNS missing the SSH target IP → warn (public DNS would misroute an upgrade)", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const { deps } = dnsDeps(home, leProfile, {
      resolveDns: (host) => ({ host, ipv4: ["198.51.100.50"], ipv6: [] }),
    });
    const checks = runRemoteDoctorChecks(leProfile, deps);
    const target = checks.find((c) => c.name === "remote: target IP vs app DNS");
    expect(target?.status).toBe("warn");
    expect(target?.message).toMatch(/does NOT include the SSH target 203\.0\.113\.7/);
  });

  test("operator app DNS includes the SSH target IP → ok", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const { deps } = dnsDeps(home, leProfile, {
      resolveDns: (host) => ({ host, ipv4: ["203.0.113.7"], ipv6: [] }),
    });
    const checks = runRemoteDoctorChecks(leProfile, deps);
    const target = checks.find((c) => c.name === "remote: target IP vs app DNS");
    expect(target?.status).toBe("ok");
  });

  test("operator vs target split-horizon difference → warn naming both address sets", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const { deps } = dnsDeps(home, leProfile, {
      resolveDns: (host, scope) => ({
        host,
        ipv4: scope === "operator" ? ["203.0.113.7"] : ["198.51.100.50"],
        ipv6: [],
      }),
    });
    const checks = runRemoteDoctorChecks(leProfile, deps);
    const split = checks.find((c) => c.name === "remote: app DNS split-horizon");
    expect(split?.status).toBe("warn");
    expect(split?.message).toContain("203.0.113.7");
    expect(split?.message).toContain("198.51.100.50");
  });

  test("letsencrypt base_url host != domain → warn (config consistency)", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const profile: typeof leProfile = {
      ...leProfile,
      base_url: "https://other.example.com",
    };
    const { deps } = dnsDeps(home, profile, {
      resolveDns: () => ({ host: "", ipv4: [], ipv6: [] }),
    });
    const checks = runRemoteDoctorChecks(profile, deps);
    const consistency = checks.find((c) => c.name === "remote: profile base_url consistency");
    expect(consistency?.status).toBe("warn");
    expect(consistency?.message).toContain("other.example.com");
    expect(consistency?.message).toContain("nautilo.example.com");
  });

  test("no DNS hostname configured (IP-only base_url) → ok info, no app/auth DNS checks", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const profile: typeof leProfile = {
      ...leProfile,
      https: "off",
      domain: undefined,
      base_url: "http://203.0.113.7:4001",
    };
    const { deps } = dnsDeps(home, profile, {
      resolveDns: () => ({ host: "", ipv4: [], ipv6: [] }),
    });
    const checks = runRemoteDoctorChecks(profile, deps);
    expect(checks.find((c) => c.name === "remote: DNS observation")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "remote: app DNS (operator)")).toBeUndefined();
    expect(checks.find((c) => c.name === "remote: auth DNS (operator)")).toBeUndefined();
  });

  test("DNS resolver error → per-scope warn, never fail", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const { deps } = dnsDeps(home, leProfile, {
      resolveDns: (host) => ({ host, ipv4: [], ipv6: [], error: "no resolver" }),
    });
    const checks = runRemoteDoctorChecks(leProfile, deps);
    const appOp = checks.find((c) => c.name === "remote: app DNS (operator)");
    const appTgt = checks.find((c) => c.name === "remote: app DNS (target)");
    expect(appOp?.status).toBe("warn");
    expect(appTgt?.status).toBe("warn");
    // No fail-status DNS checks — a resolver gap must not block the upgrade preflight.
    expect(checks.filter((c) => c.name.startsWith("remote:") && c.status === "fail")).toHaveLength(0);
  });

  test("DNS observations never mutate DNS or /etc/hosts — only read-only ssh commands issued", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-rdoc-dns-"));
    const issued: string[] = [];
    const { deps } = dnsDeps(home, leProfile, {
      resolveDns: (host, scope) => {
        issued.push(`${scope}:${host}`);
        return { host, ipv4: ["203.0.113.7"], ipv6: [] };
      },
      runCmd: (cmd: string, args: string[]) => {
        // Assert no DNS/hosts mutation commands are ever issued via ssh.
        const joined = args.join(" ");
        if (/\/etc\/hosts|resolv\.conf|systemd-resolv|sed -i|echo .*>>/.test(joined)) {
          throw new Error(`doctor issued a mutating command: ${joined}`);
        }
        if (cmd === "ssh" && args.includes("cat") && args.some((a) => a.includes("deployment-manifest.json"))) {
          return { code: 0, stdout: `${validManifestJson(leProfile, expectedRemoteRoot(leProfile))}\n`, stderr: "" };
        }
        if (cmd === "ssh") return { code: 0, stdout: "ok\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const checks = runRemoteDoctorChecks(leProfile, deps);
    // The resolver was actually consulted for app + auth, operator + target.
    expect(issued).toContain("operator:nautilo.example.com");
    expect(issued).toContain("target:nautilo.example.com");
    expect(issued).toContain("operator:auth.nautilo.example.com");
    expect(issued).toContain("target:auth.nautilo.example.com");
    // No DNS check failed.
    expect(checks.filter((c) => c.name.startsWith("remote:") && c.name.includes("DNS") && c.status === "fail")).toHaveLength(0);
  });
});
