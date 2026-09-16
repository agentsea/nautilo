import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createGitHubCliConnection,
  GITHUB_DEVICE_URL,
} from "../../electron/github-cli-connection";

describe("GitHub CLI connection", () => {
  test("reports only redacted installation and authentication state", async () => {
    const commands: string[] = [];
    const connection = createGitHubCliConnection({
      openExternal: async () => undefined,
      runCommand: async (command) => {
        commands.push(command);
        if (command === "gh --version") {
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
    expect(commands).toEqual([
      "gh --version",
      "gh auth status --hostname github.com",
    ]);
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
    const connection = createGitHubCliConnection({
      openExternal: async (url) => {
        opened.push(url);
      },
      spawnProcess: (() => child) as never,
    });

    const pending = connection.connect();
    child.stderr.write("First copy your one-time code: ABCD-EFGH\n");
    const result = await pending;
    expect(result).toEqual({ url: GITHUB_DEVICE_URL, code: "ABCD-EFGH" });
    await Promise.resolve();
    expect(opened).toEqual([GITHUB_DEVICE_URL]);
    expect(child.stdin.read()?.toString()).toBe("\n");
    child.emit("close", 0);
  });

  test("reports gh as unavailable without attempting auth status", async () => {
    let calls = 0;
    const connection = createGitHubCliConnection({
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
