import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createWorkstationShellHost } from "../../electron/workstation-shell-host";
import { WorkstationShellConsentStore } from "../../electron/workstation-shell-consent-store";

const roots: string[] = [];
const testSubject = {
  instanceId: "",
  userId: "user-1",
  relayId: "relay-1",
  serverOrigin: "https://nautilo.example",
  pairingFingerprint: "pairing-fingerprint-1",
};
const resolveTestSubject = async () => testSubject;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.NAUTILO_D486_TEST_MARKER;
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-d486-workstation-"));
  roots.push(root);
  return root;
}

describe("workstation shell host", () => {
  test("runs in the canonical Current Folder with the real host environment", async () => {
    const cwd = workspace();
    process.env.NAUTILO_D486_TEST_MARKER = "host-visible";
    const consent: string[] = [];
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async (path) => {
        consent.push(path);
        return true;
      },
    });

    const result = await host.execute({
      command: "printf '%s|%s' \"$PWD\" \"$NAUTILO_D486_TEST_MARKER\"",
      cwd,
    });

    expect(result.status).toBe("ok");
    expect(result.result?.stdout).toBe(`${realpathSync(cwd)}|host-visible`);
    expect(consent).toEqual([realpathSync(cwd)]);
  });

  test("verified uncontained sessions skip legacy folder consent and identity storage", async () => {
    const cwd = workspace();
    let consentCalls = 0;
    let subjectReads = 0;
    let spawnCalls = 0;
    let storageReads = 0;
    let storageWrites = 0;
    const host = createWorkstationShellHost({
      consentStore: new WorkstationShellConsentStore({
        instanceId: "",
        filePath: "/unused",
        storage: {
          read: async () => {
            storageReads += 1;
            return null;
          },
          writeAtomic: async () => {
            storageWrites += 1;
          },
        },
      }),
      resolveSubject: async () => {
        subjectReads += 1;
        return testSubject;
      },
      requestConsent: async () => {
        consentCalls += 1;
        return "durable";
      },
      spawnProcess: (() => {
        spawnCalls += 1;
        throw new Error("bounded no-process fixture");
      }) as never,
    });

    const result = await host.execute({
      command: "true",
      cwd,
      consentMode: "verified_uncontained_session",
    });

    expect(result).toMatchObject({
      status: "error",
      errorCode: "WORKSTATION_SPAWN_FAILED",
      error: "bounded no-process fixture",
    });
    expect(consentCalls).toBe(0);
    expect(subjectReads).toBe(0);
    expect(spawnCalls).toBe(1);
    expect(storageReads).toBe(0);
    expect(storageWrites).toBe(0);
    expect(await host.consentStatus(cwd)).toBe("none");
    expect(storageWrites).toBe(0);
  });

  test("consents once per canonical workspace and supports revocation", async () => {
    const cwd = workspace();
    let prompts = 0;
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => {
        prompts += 1;
        return true;
      },
    });
    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    expect(prompts).toBe(1);
    expect(await host.consentStatus(cwd)).toBe("session");
    await host.revoke(cwd);
    expect(await host.consentStatus(cwd)).toBe("none");
    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    expect(prompts).toBe(2);
  });

  test("session consent is invalidated by re-pair, relay drift, or folder replacement", async () => {
    const parent = workspace();
    const cwd = join(parent, "project");
    mkdirSync(cwd);
    let currentSubject = testSubject;
    let prompts = 0;
    const host = createWorkstationShellHost({
      resolveSubject: async () => currentSubject,
      requestConsent: async () => {
        prompts += 1;
        return "session";
      },
    });

    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    currentSubject = { ...testSubject, relayId: "relay-2" };
    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    expect(prompts).toBe(2);

    currentSubject = {
      ...currentSubject,
      pairingFingerprint: "pairing-fingerprint-2",
    };
    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    expect(prompts).toBe(3);

    renameSync(cwd, join(parent, "old-project"));
    mkdirSync(cwd);
    expect((await host.execute({ command: "true", cwd })).status).toBe("ok");
    expect(prompts).toBe(4);
  });

  test("missing local Human identity fails before prompting or spawning", async () => {
    const cwd = workspace();
    let prompts = 0;
    const host = createWorkstationShellHost({
      resolveSubject: async () => null,
      requestConsent: async () => {
        prompts += 1;
        return "session";
      },
    });

    const result = await host.execute({ command: "touch should-not-exist", cwd });
    expect(result.errorCode).toBe("WORKSTATION_IDENTITY_UNAVAILABLE");
    expect(result.status).toBe("error");
    expect(prompts).toBe(0);

    const unresolved = createWorkstationShellHost({
      resolveSubject: async () => {
        throw new Error("identity lookup failed");
      },
      requestConsent: async () => "session",
    });
    expect((await unresolved.execute({ command: "true", cwd })).errorCode).toBe(
      "WORKSTATION_IDENTITY_UNAVAILABLE",
    );
  });

  test("durable consent fails closed when persistence is unavailable", async () => {
    const cwd = workspace();
    const withoutStore = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => "durable",
    });
    expect((await withoutStore.execute({ command: "true", cwd })).errorCode).toBe(
      "WORKSTATION_CONSENT_STORE_UNAVAILABLE",
    );

    const corruptStore = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      consentStore: new WorkstationShellConsentStore({
        instanceId: "",
        filePath: "/unused",
        storage: {
          read: async () => "{not-json",
          writeAtomic: async () => undefined,
        },
      }),
      requestConsent: async () => "session",
    });
    expect((await corruptStore.execute({ command: "true", cwd })).errorCode).toBe(
      "WORKSTATION_CONSENT_STORE_UNAVAILABLE",
    );
  });

  test("denial and invalid Current Folder fail before spawning", async () => {
    const cwd = workspace();
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => false,
    });
    const denied = await host.execute({ command: "touch should-not-exist", cwd });
    const invalid = await host.execute({ command: "true", cwd: join(cwd, "missing") });
    expect(denied.errorCode).toBe("WORKSTATION_CONSENT_REQUIRED");
    expect(denied.status).toBe("error");
    expect(invalid.errorCode).toBe("WORKSTATION_CURRENT_FOLDER_INVALID");
    expect(invalid.status).toBe("error");
    expect(invalid.error).toContain("Current Folder is unavailable");
  });

  test("rejects blank commands and a Current Folder that is a file", async () => {
    const cwd = workspace();
    const file = join(cwd, "not-a-folder");
    writeFileSync(file, "x");
    let prompts = 0;
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => {
        prompts += 1;
        return true;
      },
    });
    expect(await host.execute({ command: "   ", cwd })).toEqual({
      status: "error",
      errorCode: "WORKSTATION_COMMAND_REQUIRED",
      error: "No command provided",
    });
    expect((await host.execute({ command: "true", cwd: file })).errorCode).toBe(
      "WORKSTATION_CURRENT_FOLDER_INVALID",
    );
    expect(prompts).toBe(0);
  });

  test("returns one structured result for non-zero exit and timeout", async () => {
    const cwd = workspace();
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
    });
    const failed = await host.execute({ command: "printf out; printf nope >&2; exit 7", cwd });
    const timedOut = await host.execute({ command: "sleep 2", cwd, timeoutMs: 1 });
    expect(failed).toMatchObject({
      status: "ok",
      result: { execution: "workstation", exitCode: 7, stdout: "out", stderr: "nope", timedOut: false },
    });
    expect(timedOut).toMatchObject({ status: "ok", result: { timedOut: true, cancelled: false } });
  });

  test("preserves ordinary output and bounds large output to head plus tail", async () => {
    const cwd = workspace();
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
    });
    const ordinary = await host.execute({
      command: "printf '  out  \\n'; printf '  err  \\n' >&2",
      cwd,
    });
    expect(ordinary.result).toMatchObject({ stdout: "  out  \n", stderr: "  err  \n" });

    const exactLimit = await host.execute({
      command: "printf '%*s' 16384 '' | tr ' ' A",
      cwd,
    });
    expect(exactLimit.result?.stdout).toHaveLength(16 * 1024);
    expect(exactLimit.result?.stdoutTruncated).toBeFalse();

    const oneOverLimit = await host.execute({
      command: "printf '%*s' 16385 '' | tr ' ' A",
      cwd,
    });
    expect(oneOverLimit.result?.stdoutTruncated).toBeTrue();
    expect(oneOverLimit.result?.stdout).toContain("1 bytes truncated by Nautilo");

    const large = await host.execute({
      command:
        "printf HEAD; yes A | tr -d '\\n' | head -c 600000; printf TAIL",
      cwd,
    });
    expect(large.status).toBe("ok");
    expect(large.result?.stdout).toStartWith("HEAD");
    expect(large.result?.stdout).toEndWith("TAIL");
    expect(large.result?.stdout?.includes("bytes truncated by Nautilo")).toBeTrue();
    expect(Buffer.byteLength(large.result?.stdout ?? "", "utf8")).toBeLessThanOrEqual(
      16 * 1024 + 128,
    );
  });

  test("spawns the fixed platform login shell with detached pipes and reports spawn errors", async () => {
    const cwd = workspace();
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const fakeChild = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        pid: number;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.pid = 12345;
      child.kill = () => true;
      return child;
    };
    const goodChild = fakeChild();
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
      spawnProcess: ((file: string, args: readonly string[], options: Record<string, unknown>) => {
        calls.push({ file, args, options });
        queueMicrotask(() => goodChild.emit("close", 0, null));
        return goodChild;
      }) as never,
    });
    expect((await host.execute({ command: "gh auth status", cwd })).status).toBe("ok");
    expect(calls[0]?.file).toBe(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    expect(calls[0]?.args).toEqual(["-l", "-c", "gh auth status"]);
    expect(calls[0]?.options["cwd"]).toBe(realpathSync(cwd));
    expect(calls[0]?.options["detached"]).toBe(true);
    expect(calls[0]?.options["stdio"]).toEqual(["ignore", "pipe", "pipe"]);
    expect((calls[0]?.options["env"] as NodeJS.ProcessEnv).PATH).toBe(process.env.PATH);

    const badChild = fakeChild();
    const failingHost = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
      spawnProcess: (() => {
        queueMicrotask(() => badChild.emit("error", new Error("spawn denied")));
        return badChild;
      }) as never,
    });
    const failed = await failingHost.execute({ command: "true", cwd });
    expect(failed).toEqual({
      status: "error",
      errorCode: "WORKSTATION_SPAWN_FAILED",
      error: "spawn denied",
    });
  });

  test("isolates progress observer faults without changing the canonical outcome", async () => {
    const cwd = workspace();
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
    });
    const result = await host.execute({
      command: "printf visible; printf diagnostic >&2",
      cwd,
      onStdoutChunk: () => { throw new Error("renderer disconnected"); },
      onStderrChunk: () => { throw new Error("renderer disconnected"); },
    });
    expect(result).toMatchObject({
      status: "ok",
      result: { stdout: "visible", stderr: "diagnostic", exitCode: 0 },
    });
  });

  test("dispose clears every app-session workspace and invalid status is false", async () => {
    const first = workspace();
    const second = workspace();
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
    });
    await host.execute({ command: "true", cwd: first });
    await host.execute({ command: "true", cwd: second });
    expect(await host.consentStatus(first)).toBe("session");
    expect(await host.consentStatus(second)).toBe("session");
    expect(await host.consentStatus(join(first, "missing"))).toBe("none");
    host.dispose();
    expect(await host.consentStatus(first)).toBe("none");
    expect(await host.consentStatus(second)).toBe("none");
  });

  test("revoke kills an active process and fences its late completion", async () => {
    const cwd = workspace();
    let killedWith: string | undefined;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: undefined;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = undefined;
    child.kill = (signal) => {
      killedWith = signal;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    };
    let spawnedResolve!: () => void;
    const spawned = new Promise<void>((resolve) => {
      spawnedResolve = resolve;
    });
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
      spawnProcess: (() => {
        spawnedResolve();
        return child;
      }) as never,
    });
    const observed: string[] = [];
    const pending = host.execute({
      command: "long-running-command",
      cwd,
      onStdoutChunk: (chunk) => observed.push(chunk.toString("utf8")),
    });
    await spawned;
    child.stdout.write("before");
    await host.revoke(cwd);
    const result = await pending;
    expect(killedWith).toBe("SIGKILL");
    expect(result).toMatchObject({ status: "ok", result: { cancelled: true, timedOut: false } });
    child.emit("close", 0, null);
    child.stdout.write("late");
    expect(observed).toEqual(["before"]);
    expect(result.status).toBe("ok");
  });

  test("app-session revoke kills active processes in every workspace", async () => {
    const first = workspace();
    const second = workspace();
    const children = [first, second].map(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        pid: undefined;
        kill: (signal?: string) => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.pid = undefined;
      child.kill = () => {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      };
      return child;
    });
    let index = 0;
    let spawnedCount = 0;
    let bothSpawnedResolve!: () => void;
    const bothSpawned = new Promise<void>((resolve) => {
      bothSpawnedResolve = resolve;
    });
    const host = createWorkstationShellHost({
      resolveSubject: resolveTestSubject,
      requestConsent: async () => true,
      spawnProcess: (() => {
        const child = children[index++];
        spawnedCount += 1;
        if (spawnedCount === 2) bothSpawnedResolve();
        return child;
      }) as never,
    });

    const pending = [
      host.execute({ command: "first-long-command", cwd: first }),
      host.execute({ command: "second-long-command", cwd: second }),
    ];
    await bothSpawned;
    host.dispose();

    for (const result of await Promise.all(pending)) {
      expect(result).toMatchObject({ status: "ok", result: { cancelled: true } });
    }
    expect(await host.consentStatus(first)).toBe("none");
    expect(await host.consentStatus(second)).toBe("none");
  });

  test("durable consent survives host restart and is revocable", async () => {
    const cwd = workspace();
    const filePath = join(cwd, "consent.json");
    let prompts = 0;
    const first = createWorkstationShellHost({
      consentStore: new WorkstationShellConsentStore({ instanceId: "", filePath }),
      resolveSubject: resolveTestSubject,
      requestConsent: async () => {
        prompts += 1;
        return "durable";
      },
    });
    expect((await first.execute({ command: "true", cwd })).status).toBe("ok");
    expect(await first.consentStatus(cwd)).toBe("durable");
    first.dispose();

    const restarted = createWorkstationShellHost({
      consentStore: new WorkstationShellConsentStore({ instanceId: "", filePath }),
      resolveSubject: resolveTestSubject,
      requestConsent: async () => {
        prompts += 1;
        return null;
      },
    });
    expect((await restarted.execute({ command: "true", cwd })).status).toBe("ok");
    expect(prompts).toBe(1);

    await restarted.revoke(cwd, testSubject);
    expect(await restarted.consentStatus(cwd)).toBe("none");
  });
});
