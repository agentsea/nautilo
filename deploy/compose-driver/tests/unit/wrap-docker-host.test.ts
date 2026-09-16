import { describe, expect, test } from "bun:test";

import type { ExecFn, ExecResult } from "../../src/ComposeDriver.ts";
import {
  createDockerSshAgentManager,
  dockerEnvForProfile,
  dockerHostFor,
  wrapWithDockerHost,
} from "../../src/wrap-docker-host.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

const remoteProfile: ComposeDriverProfile = {
  name: "remote",
  transport: "remote",
  lifecycle: "compose",
  from_source: true,
  ssh: { host: "1.2.3.4", user: "root", port: 22 },
};

describe("dockerHostFor", () => {
  test("default port 22 omits port suffix", () => {
    expect(dockerHostFor(remoteProfile)).toBe("ssh://root@1.2.3.4");
  });

  test("non-default port includes suffix", () => {
    expect(
      dockerHostFor({
        ...remoteProfile,
        ssh: { host: "1.2.3.4", user: "root", port: 2222 },
      }),
    ).toBe("ssh://root@1.2.3.4:2222");
  });

  test("throws for local transport", () => {
    expect(() =>
      dockerHostFor({
        name: "local",
        transport: "local",
        lifecycle: "compose",
      }),
    ).toThrow(/requires transport="remote"/);
  });
});

describe("dockerEnvForProfile", () => {
  function fakeAgent() {
    const calls: Array<{
      cmd: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    let exitHandler: (() => void) | undefined;
    const manager = createDockerSshAgentManager({
      run: (cmd, args, opts) => {
        calls.push(
          opts.env === undefined ? { cmd, args } : { cmd, args, env: opts.env },
        );
        if (cmd === "ssh-agent" && args[0] === "-s") {
          return {
            status: 0,
            stdout:
              "SSH_AUTH_SOCK=/tmp/agent.sock; export SSH_AUTH_SOCK;\n" +
              "SSH_AGENT_PID=4242; export SSH_AGENT_PID;\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      registerExit: (handler) => {
        exitHandler = handler;
      },
    });
    return { calls, manager, runExit: () => exitHandler?.() };
  }

  test("loads identity once and propagates its private agent to Docker", () => {
    const fake = fakeAgent();
    const profile: ComposeDriverProfile = {
      ...remoteProfile,
      ssh: {
        ...remoteProfile.ssh!,
        identity_file: "/keys/qa_deploy_ed25519",
      },
    };

    const first = dockerEnvForProfile(
      profile,
      { PATH: "/usr/bin" },
      fake.manager,
    ).env!;
    const second = dockerEnvForProfile(
      profile,
      { PATH: "/usr/bin" },
      fake.manager,
    ).env!;

    expect(first["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");
    expect(first["SSH_AUTH_SOCK"]).toBe("/tmp/agent.sock");
    expect(first["SSH_AGENT_PID"]).toBe("4242");
    expect(second["SSH_AUTH_SOCK"]).toBe("/tmp/agent.sock");
    expect(fake.calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ["ssh-agent", "-s"],
      ["ssh-add", "/keys/qa_deploy_ed25519"],
    ]);
    expect(fake.calls[1]!.env?.["SSH_AUTH_SOCK"]).toBe("/tmp/agent.sock");
  });

  test("terminates cached agents through the registered exit hook", () => {
    const fake = fakeAgent();
    fake.manager.envForIdentity("/keys/qa_deploy_ed25519", {});

    fake.runExit();

    expect(fake.calls.at(-1)?.cmd).toBe("ssh-agent");
    expect(fake.calls.at(-1)?.args).toEqual(["-k"]);
    expect(fake.calls.at(-1)?.env?.["SSH_AGENT_PID"]).toBe("4242");
  });

  test("terminates a newly-started agent when ssh-add fails", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const manager = createDockerSshAgentManager({
      run: (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "ssh-agent" && args[0] === "-s") {
          return {
            status: 0,
            stdout:
              "SSH_AUTH_SOCK=/tmp/agent.sock; export SSH_AUTH_SOCK;\n" +
              "SSH_AGENT_PID=4242; export SSH_AGENT_PID;\n",
            stderr: "",
          };
        }
        if (cmd === "ssh-add") {
          return { status: 1, stdout: "", stderr: "bad key" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      registerExit: () => {
        throw new Error("exit hook must not register after failed ssh-add");
      },
    });

    expect(() => manager.envForIdentity("/keys/bad", {})).toThrow(
      /Could not load ssh\.identity_file.*bad key/u,
    );
    expect(calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ["ssh-agent", "-s"],
      ["ssh-add", "/keys/bad"],
      ["ssh-agent", "-k"],
    ]);
  });
});

describe("wrapWithDockerHost", () => {
  test("docker commands use localExec with DOCKER_HOST", async () => {
    const innerCalls: string[] = [];
    const localCalls: { cmd: string; dockerHost?: string }[] = [];
    const inner: ExecFn = async (cmd) => {
      innerCalls.push(cmd);
      return ok;
    };
    const localExec: ExecFn = async (cmd, _args, opts) => {
      const dh = opts.env?.["DOCKER_HOST"];
      localCalls.push(dh !== undefined ? { cmd, dockerHost: dh } : { cmd });
      return ok;
    };
    const wrapped = wrapWithDockerHost(inner, "ssh://root@1.2.3.4", localExec);
    await wrapped("docker", ["compose", "ps"], { stdio: "pipe" });
    expect(localCalls.length).toBe(1);
    expect(localCalls[0]!.cmd).toBe("docker");
    expect(localCalls[0]!.dockerHost).toBe("ssh://root@1.2.3.4");
    expect(innerCalls.length).toBe(0);
  });

  test("non-docker commands use inner exec", async () => {
    const innerCalls: string[] = [];
    const localCalls: string[] = [];
    const inner: ExecFn = async (cmd) => {
      innerCalls.push(cmd);
      return ok;
    };
    const localExec: ExecFn = async (cmd) => {
      localCalls.push(cmd);
      return ok;
    };
    const wrapped = wrapWithDockerHost(inner, "ssh://root@1.2.3.4", localExec);
    await wrapped("ls", [], { stdio: "pipe" });
    expect(innerCalls).toEqual(["ls"]);
    expect(localCalls.length).toBe(0);
  });
});
