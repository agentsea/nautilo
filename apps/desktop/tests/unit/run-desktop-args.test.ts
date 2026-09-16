/**
 * Stack 198 / M161 Phase 5 — pin `buildDesktopArgs` (the root desktop launcher
 * argument builder) behavior, including the `NAUTILO_REMOTE_DEBUGGING_PORT`
 * → `--remote-debugging-port=<port>` threading that the live QA gap showed was
 * missing.
 *
 * Load-bearing: the launcher MUST append the CDP flag when the env is set, MUST
 * NOT append it when the env is absent (normal app path unchanged), and MUST
 * fail before spawn on any non-decimal / out-of-range value. The pure builder
 * is imported (no spawn) so `bun:test` can assert argv deterministically.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDesktopArgs,
  buildDesktopChildEnv,
  REMOTE_DEBUGGING_PORT_ENV,
} from "../../scripts/run-desktop";

const MAIN = "/path/to/dist/main.js";

describe("buildDesktopChildEnv — explicit cloned-default connection", () => {
  test("explicit server URL skips the picker so dev loopback trust can pair the relay", () => {
    const env = buildDesktopChildEnv({
      NAUTILO_CONNECT_SERVER_URL: "http://127.0.0.1:6001",
      NAUTILO_PROFILE: "d491qa",
    });
    expect(env["NAUTILO_CONNECT_SERVER_URL"]).toBe("http://127.0.0.1:6001");
    expect(env["NAUTILO_PROFILE"]).toBe("d491qa");
    expect(env["NAUTILO_FORCE_FIRST_RUN"]).toBe("0");
  });

  test("without an explicit URL the launcher reuses a saved profile connection", () => {
    const env = buildDesktopChildEnv({});
    expect(env["NAUTILO_FORCE_FIRST_RUN"]).toBe("0");
    expect(env["NAUTILO_PREFER_PERSISTED_CONNECTION"]).toBe("1");
  });

  test("an explicit force-first-run request still reopens the picker", () => {
    const env = buildDesktopChildEnv({ NAUTILO_FORCE_FIRST_RUN: "1" });
    expect(env["NAUTILO_FORCE_FIRST_RUN"]).toBe("1");
    expect(env["NAUTILO_PREFER_PERSISTED_CONNECTION"]).toBe("1");
  });
});

describe("buildDesktopArgs — main bundle + profile (M167 preserved)", () => {
  test("always leads with the main bundle path", () => {
    const { args } = buildDesktopArgs({ argv: [], env: {}, mainBundlePath: MAIN });
    expect(args[0]).toBe(MAIN);
  });

  test("no profile, no env → args is just the main bundle", () => {
    const { args, profile, remoteDebuggingPort } = buildDesktopArgs({
      argv: [],
      env: {},
      mainBundlePath: MAIN,
    });
    expect(args).toEqual([MAIN]);
    expect(profile).toBeUndefined();
    expect(remoteDebuggingPort).toBeUndefined();
  });

  test("positional profile is appended as --profile <slug>", () => {
    const { args, profile } = buildDesktopArgs({
      argv: ["second"],
      env: {},
      mainBundlePath: MAIN,
    });
    expect(profile).toBe("second");
    expect(args).toEqual([MAIN, "--profile", "second"]);
  });

  test("--profile <slug> is appended as --profile <slug>", () => {
    const { args, profile } = buildDesktopArgs({
      argv: ["--profile", "second"],
      env: {},
      mainBundlePath: MAIN,
    });
    expect(profile).toBe("second");
    expect(args).toEqual([MAIN, "--profile", "second"]);
  });

  test("invalid profile throws (clear, non-secret message)", () => {
    expect(() =>
      buildDesktopArgs({ argv: ["Bad!"], env: {}, mainBundlePath: MAIN }),
    ).toThrow(/Invalid profile/);
  });
});

describe("buildDesktopArgs — NAUTILO_REMOTE_DEBUGGING_PORT threading", () => {
  test("set → appends --remote-debugging-port=<port>", () => {
    const { args, remoteDebuggingPort } = buildDesktopArgs({
      argv: [],
      env: { [REMOTE_DEBUGGING_PORT_ENV]: "9222" },
      mainBundlePath: MAIN,
    });
    expect(remoteDebuggingPort).toBe(9222);
    expect(args).toEqual([MAIN, "--remote-debugging-port=9222"]);
  });

  test("threads alongside a resolved profile (second-copy plumbing)", () => {
    const { args, profile, remoteDebuggingPort } = buildDesktopArgs({
      argv: ["--profile", "work"],
      env: { [REMOTE_DEBUGGING_PORT_ENV]: "9223" },
      mainBundlePath: MAIN,
    });
    expect(profile).toBe("work");
    expect(remoteDebuggingPort).toBe(9223);
    expect(args).toEqual([MAIN, "--profile", "work", "--remote-debugging-port=9223"]);
  });

  test("absent → no CDP flag appended (normal app path unchanged)", () => {
    const { args, remoteDebuggingPort } = buildDesktopArgs({
      argv: [],
      env: {},
      mainBundlePath: MAIN,
    });
    expect(remoteDebuggingPort).toBeUndefined();
    expect(args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
  });

  test("empty-string env is treated as absent", () => {
    const { args, remoteDebuggingPort } = buildDesktopArgs({
      argv: [],
      env: { [REMOTE_DEBUGGING_PORT_ENV]: "" },
      mainBundlePath: MAIN,
    });
    expect(remoteDebuggingPort).toBeUndefined();
    expect(args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
  });

  test("whitespace-surrounded port is trimmed and accepted", () => {
    const { args, remoteDebuggingPort } = buildDesktopArgs({
      argv: [],
      env: { [REMOTE_DEBUGGING_PORT_ENV]: "  9222  " },
      mainBundlePath: MAIN,
    });
    expect(remoteDebuggingPort).toBe(9222);
    expect(args).toEqual([MAIN, "--remote-debugging-port=9222"]);
  });
});

describe("buildDesktopArgs — NAUTILO_REMOTE_DEBUGGING_PORT validation", () => {
  test("non-decimal throws before spawn", () => {
    expect(() =>
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "9222abc" },
        mainBundlePath: MAIN,
      }),
    ).toThrow(/decimal integer 1\.\.65535/);
  });

  test("hex / sign throws", () => {
    expect(() =>
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "0x24" },
        mainBundlePath: MAIN,
      }),
    ).toThrow(/decimal integer/);
    expect(() =>
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "+9222" },
        mainBundlePath: MAIN,
      }),
    ).toThrow(/decimal integer/);
  });

  test("zero is rejected (port must be 1..65535)", () => {
    expect(() =>
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "0" },
        mainBundlePath: MAIN,
      }),
    ).toThrow(/1\.\.65535/);
  });

  test("above 65535 is rejected", () => {
    expect(() =>
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "65536" },
        mainBundlePath: MAIN,
      }),
    ).toThrow(/1\.\.65535/);
  });

  test("boundary 1 and 65535 are accepted", () => {
    expect(
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "1" },
        mainBundlePath: MAIN,
      }).remoteDebuggingPort,
    ).toBe(1);
    expect(
      buildDesktopArgs({
        argv: [],
        env: { [REMOTE_DEBUGGING_PORT_ENV]: "65535" },
        mainBundlePath: MAIN,
      }).remoteDebuggingPort,
    ).toBe(65535);
  });
});
