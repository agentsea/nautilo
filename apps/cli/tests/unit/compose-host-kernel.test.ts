import { afterEach, describe, expect, test } from "bun:test";
import type { ComposeDriverProfile } from "@nautilo/compose-driver";
import {
  assertComposeHostKernelReady,
  inspectComposeHostKernel,
  setComposeHostKernelRunnerForTests,
} from "../../src/lib/compose-host-kernel.ts";

const profile: ComposeDriverProfile = {
  name: "fixture", transport: "local", lifecycle: "compose", instance_id: "fixture",
};
const image = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;
const originalHost = process.env["DOCKER_HOST"];
const originalContext = process.env["DOCKER_CONTEXT"];

afterEach(() => {
  setComposeHostKernelRunnerForTests(undefined);
  if (originalHost === undefined) delete process.env["DOCKER_HOST"];
  else process.env["DOCKER_HOST"] = originalHost;
  if (originalContext === undefined) delete process.env["DOCKER_CONTEXT"];
  else process.env["DOCKER_CONTEXT"] = originalContext;
});

describe("selected Docker host kernel admission", () => {
  test("probes the selected daemon in an isolated disposable container", () => {
    process.env["DOCKER_HOST"] = "tcp://daemon.example.test:2376";
    setComposeHostKernelRunnerForTests((args, env) => {
      expect(env["DOCKER_HOST"]).toBe("tcp://daemon.example.test:2376");
      expect(args.slice(0, 6)).toEqual(["run", "--rm", "--network", "none", "--read-only", "--cap-drop"]);
      expect(args).toContain("no-new-privileges");
      expect(args).toContain("io.nautilo.purpose=host-kernel-check");
      expect(args).not.toContain("--privileged");
      expect(args).not.toContain("--volume");
      expect(args).toContain(image);
      expect(args.at(-1)).toContain("/proc/version_signature");
      return { code: 0, stdout: JSON.stringify({ signature: "Ubuntu 6.8.0-149.149-generic 6.8.12" }), stderr: "" };
    });
    expect(inspectComposeHostKernel(profile, image).status).toBe("fixed");
  });

  test("refuses an affected kernel even when userspace and image are current", () => {
    setComposeHostKernelRunnerForTests(() => ({ code: 0,
      stdout: JSON.stringify({ signature: "Ubuntu 6.8.0-147.147-generic 6.8.12" }), stderr: "" }));
    expect(() => assertComposeHostKernelReady(profile, image)).toThrow("CVE-2026-98432");
  });

  test("never certifies a non-Ubuntu kernel or hidden signature", () => {
    setComposeHostKernelRunnerForTests(() => ({ code: 0, stdout: '{"signature":null}', stderr: "" }));
    expect(inspectComposeHostKernel(profile, image).status).toBe("unknown");
  });

  test("probe execution failure cannot become unknown or fixed", () => {
    setComposeHostKernelRunnerForTests(() => ({ code: 1,
      stdout: JSON.stringify({ signature: "Ubuntu 6.8.0-149.149-generic 6.8.12" }), stderr: "denied" }));
    expect(() => inspectComposeHostKernel(profile, image)).toThrow("isolated Docker probe failed");
  });

  test.each(["not JSON", "{}", '{"signature":42}'])("refuses malformed probe evidence: %s", (stdout) => {
    setComposeHostKernelRunnerForTests(() => ({ code: 0, stdout, stderr: "" }));
    expect(() => inspectComposeHostKernel(profile, image)).toThrow("invalid evidence");
  });

  test("source upgrades inspect the current image without executing its server", () => {
    const calls: string[][] = [];
    const current = `sha256:${"b".repeat(64)}`;
    setComposeHostKernelRunnerForTests((args) => {
      calls.push(args);
      return { code: 0, stdout: args[0] === "ps" ? "c".repeat(64) : args[0] === "inspect" ? current
        : JSON.stringify({ signature: "Ubuntu 6.8.0-149.149-generic 6.8.12" }), stderr: "" };
    });
    expect(inspectComposeHostKernel(profile).status).toBe("fixed");
    expect(calls[0]).toEqual(["ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=nautilo-fixture",
      "--filter", "label=com.docker.compose.service=nautilo-server"]);
    expect(calls[1]).toEqual(["inspect", "--format", "{{.Image}}", "c".repeat(64)]);
    expect(calls[2]).toContain(current);
    expect(calls[2]).toContain("--entrypoint");
  });

  test.each(["", `${"c".repeat(64)}\n${"d".repeat(64)}`])("ambiguous source server discovery refuses before a probe: %s", (stdout) => {
    setComposeHostKernelRunnerForTests((args) => {
      expect(args[0]).toBe("ps");
      return { code: 0, stdout, stderr: "" };
    });
    expect(() => inspectComposeHostKernel(profile)).toThrow("exactly one existing Nautilo server container");
  });

  test("rejects remote context ambiguity before opening a Docker connection", () => {
    process.env["DOCKER_CONTEXT"] = "different-daemon";
    setComposeHostKernelRunnerForTests(() => { throw new Error("must not run"); });
    expect(() => inspectComposeHostKernel({ ...profile, transport: "remote",
      ssh: { host: "example.test", user: "fixture" } }, image)).toThrow("DOCKER_CONTEXT");
  });

  test("remote probe retains the profile's pinned host key, identity and port", () => {
    delete process.env["DOCKER_CONTEXT"];
    setComposeHostKernelRunnerForTests((args, _env, command) => {
      expect(command).toBe("ssh");
      expect(args.slice(0, 2)).toEqual(["-p", "2202"]);
      expect(args).toContain("UserKnownHostsFile=/fixture/known_hosts");
      expect(args).toContain("StrictHostKeyChecking=yes");
      expect(args).toContain("/fixture/identity");
      expect(args).toContain("user@example.test");
      expect(args.at(-1)).toContain("docker run --rm --network none");
      expect(args.at(-1)).toContain(image);
      return { code: 0, stdout: JSON.stringify({ signature: "Ubuntu 6.8.0-149.149-generic 6.8.12" }), stderr: "" };
    });
    expect(inspectComposeHostKernel({ ...profile, transport: "remote", ssh: {
      host: "example.test", user: "user", port: 2202,
      identity_file: "/fixture/identity", known_hosts_file: "/fixture/known_hosts",
    } }, image).status).toBe("fixed");
  });
});
