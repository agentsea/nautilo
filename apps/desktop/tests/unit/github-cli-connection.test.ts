import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createAdmittedGitHubCliConnection,
  GITHUB_DEVICE_URL,
  type GitHubCliInvocation,
} from "../../electron/github-cli-connection";

const getInstallation = async () => ({
  verify: async () => ({ executable: "/trusted/runtime/gh", cwd: "/trusted/runtime",
    env: { HOME: "/trusted/home", GH_CONFIG_DIR: "/trusted/home/.config/gh" }, isCurrent: () => true }),
  retire() {},
});

describe("GitHub CLI connection", () => {
  test("reports only redacted installation and authentication state", async () => {
    const commands: GitHubCliInvocation[] = [];
    const connection = createAdmittedGitHubCliConnection({
      subscribeAuthorityChanges: () => () => {},
      getInstallation,
      openExternal: async () => undefined,
      runCommand: async (command) => {
        commands.push(command);
        if (command.argv[0] === "--version") {
          return { code: 0, stdout: "gh version 2.93.0 (date)\n", stderr: "" };
        }
        return {
          code: 0,
          stdout: "",
          stderr:
            "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token: secret",
        };
      },
    });

    expect(await connection.status()).toEqual({
      installed: true,
      authenticated: true,
      login: "octocat",
      version: "2.93.0",
      loginPending: false,
    });
    expect(commands.map(command => command.argv)).toEqual([
      ["--version"], ["auth", "status", "--hostname", "github.com"],
    ]);
    expect(commands.every(command => command.executable === "/trusted/runtime/gh")).toBe(true);
  });

  test("opens the fixed GitHub device URL and returns the CLI-issued code", async () => {
    const opened: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    const connection = createAdmittedGitHubCliConnection({
      subscribeAuthorityChanges: () => () => {},
      getInstallation,
      openExternal: async (url) => {
        opened.push(url);
      },
      spawnProcess: (() => child) as never,
    });

    const pending = connection.connect();
    await new Promise(resolve => setImmediate(resolve));
    child.stderr.write("First copy your one-time code: ABCD-EFGH\n");
    const result = await pending;
    expect(result).toEqual({ url: GITHUB_DEVICE_URL, code: "ABCD-EFGH" });
    await Promise.resolve();
    expect(opened).toEqual([GITHUB_DEVICE_URL]);
    const written: unknown = child.stdin.read();
    expect(Buffer.isBuffer(written) ? written.toString() : null).toBe("\n");
    child.emit("close", 0);
  });

  test("reports gh as unavailable without attempting auth status", async () => {
    let calls = 0;
    const connection = createAdmittedGitHubCliConnection({
      subscribeAuthorityChanges: () => () => {},
      getInstallation,
      openExternal: async () => undefined,
      runCommand: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "command not found" };
      },
    });
    expect(await connection.status()).toEqual({
      installed: false,
      authenticated: false,
      login: null,
      version: null,
      loginPending: false,
    });
    expect(calls).toBe(1);
  });
});

test("cancel during installation admission prevents spawn and concurrent login", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let spawns = 0;
  const connection = createAdmittedGitHubCliConnection({ subscribeAuthorityChanges: () => () => {}, openExternal: async () => undefined,
    getInstallation: async () => { await barrier; return await getInstallation(); },
    spawnProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never });
  const pending = connection.connect().then(() => "success", error => (error as Error).message);
  expect(await connection.connect().then(() => "success", error => (error as Error).message)).toBe("A GitHub sign-in is already in progress.");
  connection.cancel(); release();
  expect(await pending).toBe("GitHub installation is unavailable.");
  expect(spawns).toBe(0);
});

test("status suppresses a stale account after authority changes during a command", async () => {
  let current = true;
  const base = await getInstallation();
  const connection = createAdmittedGitHubCliConnection({ subscribeAuthorityChanges: () => () => {}, openExternal: async () => undefined,
    getInstallation: async () => ({ ...base, verify: async () => ({ ...await base.verify(), isCurrent: () => current }) }),
    runCommand: async input => {
      if (input.argv[0] === "--version") return { code: 0, stdout: "gh version 2.102.0", stderr: "" };
      current = false;
      return { code: 0, stdout: "Logged in to github.com account stale-account", stderr: "" };
    } });
  expect(await connection.status()).toEqual({ installed: false, authenticated: false, login: null, version: null, loginPending: false });
});

test("authority reduction after device-code delivery kills only that login and releases its subscription", async () => {
  let current = true;
  let listener: (() => void) | undefined;
  let subscriptions = 0;
  const children: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kills: number; kill: () => boolean })[] = [];
  const base = await getInstallation();
  const connection = createAdmittedGitHubCliConnection({ openExternal: async () => undefined,
    getInstallation: async () => ({ ...base, verify: async () => ({ ...await base.verify(), isCurrent: () => current }) }),
    subscribeAuthorityChanges: callback => { listener = callback; subscriptions++; return () => { if (listener === callback) listener = undefined; subscriptions--; }; },
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kills: 0,
        kill() { this.kills++; return true; } });
      children.push(child); return child;
    }) as never,
  });
  const first = connection.connect();
  await new Promise(resolve => setImmediate(resolve));
  children[0]!.stderr.write("Device code: ABCD-EFGH");
  expect((await first).code).toBe("ABCD-EFGH");
  expect(subscriptions).toBe(1);
  const staleListener = listener;
  current = false; listener?.();
  expect(children[0]!.kills).toBe(1); expect(subscriptions).toBe(0);
  current = true;
  expect(await connection.connect().then(() => "success", error => (error as Error).message)).toBe("A GitHub sign-in is already in progress.");
  expect(children).toHaveLength(1);
  children[0]!.emit("close", 1);
  const second = connection.connect();
  await new Promise(resolve => setImmediate(resolve));
  children[1]!.stderr.write("Device code: IJKL-MNOP");
  expect((await second).code).toBe("IJKL-MNOP");
  staleListener?.(); children[0]!.emit("close", 1);
  expect(children[1]!.kills).toBe(0); expect(subscriptions).toBe(1);
  connection.cancel();
  expect(children[1]!.kills).toBe(1); expect(subscriptions).toBe(0);
  expect(await connection.connect().then(() => "success", error => (error as Error).message)).toBe("A GitHub sign-in is already in progress.");
  connection.cancel();
  expect(children[1]!.kills).toBe(1);
  children[1]!.emit("close", 1);
  const third = connection.connect();
  await new Promise(resolve => setImmediate(resolve));
  children[2]!.stderr.write("Device code: QRST-UVWX");
  expect((await third).code).toBe("QRST-UVWX");
  children[1]!.emit("close", 1);
  expect(children[2]!.kills).toBe(0);
  expect(subscriptions).toBe(1);
  children[2]!.emit("close", 0);
  expect(subscriptions).toBe(0);
});
