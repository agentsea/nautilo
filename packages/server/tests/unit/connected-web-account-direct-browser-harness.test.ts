import { expect, test } from "bun:test";
import { agentBrowserCdpArgv } from "@nautilo/relay";
import {
  createServerDirectBrowserHarness,
  directBrowserTransportDeadlineMs,
  DirectBrowserHarnessError,
  resolveServerVendoredAgentBrowserBinary,
  type DirectBrowserHarnessProcess,
} from "../../src/connected-web-accounts/direct-browser-harness";

const CDP_URL = "wss://11111111-1111-4111-8111-111111111111.cdp.browser-use.com/devtools/browser/private-token";

const manifest = {
  "agent-browser": {
    version: "0.35.2",
    binaryName: "agent-browser",
    artifacts: Object.fromEntries(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map((key) => [
        key,
        { sha256: "a".repeat(64), sizeMin: 10_000_000 },
      ]),
    ),
  },
};

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function process(stdout: string, stderr = "", exitCode = 0): DirectBrowserHarnessProcess {
  return {
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => undefined,
  };
}

function hangingProcess(onKill: () => void): DirectBrowserHarnessProcess {
  let closeStdout: (() => void) | null = null;
  let closeStderr: (() => void) | null = null;
  let resolveExit: ((code: number) => void) | null = null;
  return {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { closeStdout = () => controller.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { closeStderr = () => controller.close(); } }),
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill: () => {
      onKill();
      closeStdout?.();
      closeStderr?.();
      resolveExit?.(137);
    },
  };
}

function harnessInput() {
  return {
    argv: agentBrowserCdpArgv("browser_snapshot", {}, "operation-1-account-1-epoch-1"),
    environment: { AGENT_BROWSER_CDP: CDP_URL },
    socketDirectory: "/run/nautilo/op-1",
    homeDirectory: "/var/lib/nautilo/direct/op-1",
  };
}

test("D568 resolves the exact checksum-pinned server artifact for the runtime platform", async () => {
  const binary = await resolveServerVendoredAgentBrowserBinary({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async (path) => path === "/srv/agent-browser/linux-x64/agent-browser",
  });
  expect(binary).toBe("/srv/agent-browser/linux-x64/agent-browser");
});

test("D568 harness starts an exact argv with only private CDP, socket, and HOME environment", async () => {
  const calls: Array<{ command: readonly string[]; environment: Readonly<Record<string, string>> }> = [];
  const harness = createServerDirectBrowserHarness({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async () => true,
    spawn: (input) => { calls.push(input); return process("- button Continue\n"); },
  });

  const result = await harness.invoke(harnessInput());
  expect(result).toEqual({ text: "- button Continue", truncated: false });
  expect(calls).toEqual([{
    command: ["/srv/agent-browser/linux-x64/agent-browser", "--session", "operation-1-account-1-epoch-1", "snapshot"],
    environment: {
      HOME: "/var/lib/nautilo/direct/op-1",
      AGENT_BROWSER_CDP: CDP_URL,
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
      AGENT_BROWSER_PIN_TAB: "1",
      AGENT_BROWSER_SOCKET_DIR: "/run/nautilo/op-1",
    },
  }]);
  expect(calls[0]!.command).not.toContain("--cdp");
  expect(calls[0]!.command).not.toContain("--provider");
  expect(calls[0]!.command).not.toContain("--config");
});

test("D568 preserves an exactly within-limit command output and truncates only real overflow", async () => {
  const makeHarness = (output: string) => createServerDirectBrowserHarness({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async () => true,
    maxStdoutBytes: 4,
    spawn: () => process(output),
  });
  expect(await makeHarness("1234").invoke(harnessInput())).toEqual({ text: "1234", truncated: false });
  expect(await makeHarness("12345").invoke(harnessInput())).toEqual({ text: "1234", truncated: true });
});

test("D568 gives the maximum permitted semantic browser_wait its full duration plus transport allowance", () => {
  const session = "operation-1-account-1-epoch-1";
  const maxWait = agentBrowserCdpArgv("browser_wait", { milliseconds: 30_000 }, session);
  const ordinaryCommand = agentBrowserCdpArgv("browser_snapshot", {}, session);
  expect(directBrowserTransportDeadlineMs(maxWait, 30_000)).toBe(60_000);
  expect(directBrowserTransportDeadlineMs(ordinaryCommand, 30_000)).toBe(30_000);
  expect(directBrowserTransportDeadlineMs(["--session", session, "wait", "30001"], 30_000)).toBe(30_000);
});

test("D568 strips echoed capabilities and invisible page formatting while every failed path is generic", async () => {
  const harness = createServerDirectBrowserHarness({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async () => true,
    spawn: () => process(`connected \u2066${CDP_URL}\u2069\n- text \u2068Billing\u2069`),
  });
  const result = await harness.invoke(harnessInput());
  expect(result.text).toBe("connected [redacted]\n- text Billing");
  expect(result.text).not.toContain(CDP_URL);
  expect(result.text).not.toMatch(/[\u2066-\u2069]/u);

  const throwing = createServerDirectBrowserHarness({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async () => true,
    spawn: () => { throw new Error(`spawn ${CDP_URL}`); },
  });
  const error = await throwing.invoke(harnessInput()).then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(DirectBrowserHarnessError);
  expect(error).toMatchObject({ code: "unavailable", message: "direct browser harness unavailable" });
  expect(String(error)).not.toContain(CDP_URL);
});

test("D568 fails closed before spawn when the real Unix socket path exceeds agent-browser's 103-byte payload budget", async () => {
  let spawned = false;
  const harness = createServerDirectBrowserHarness({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async () => true,
    spawn: () => { spawned = true; return process(""); },
  });
  const tooLongSocketDirectory = `/${"a".repeat(80)}`;
  const error = await harness.invoke({ ...harnessInput(), socketDirectory: tooLongSocketDirectory }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ code: "unavailable", message: "direct browser harness unavailable" });
  expect(spawned).toBe(false);
});

test("D568 bounds one command transport without creating an operation lifetime limit", async () => {
  let killed = false;
  const harness = createServerDirectBrowserHarness({
    platform: "linux",
    arch: "x64",
    vendorRoot: "/srv/agent-browser",
    manifest,
    binaryExists: async () => true,
    commandTimeoutMs: 1,
    spawn: () => hangingProcess(() => { killed = true; }),
  });
  const error = await harness.invoke(harnessInput()).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "timeout", message: "direct browser harness unavailable" });
  expect(killed).toBe(true);
});

test("D568 harness binds and reads one sticky target, then closes only its private daemon inventory", async () => {
  const calls: Array<{ command: readonly string[]; environment: Readonly<Record<string, string>> }> = [];
  const harness = createServerDirectBrowserHarness({
    platform: "linux", arch: "x64", vendorRoot: "/srv/agent-browser", manifest,
    binaryExists: async () => true,
    spawn: (input) => {
      calls.push(input);
      return process(input.command.includes("get") ? "https://console.example.test/projects\n" : "");
    },
  });
  const common = {
    session: "operation-1-account-1-epoch-1",
    environment: { AGENT_BROWSER_CDP: CDP_URL },
    socketDirectory: "/run/nautilo/op-1",
    homeDirectory: "/var/lib/nautilo/direct/op-1",
  };
  await harness.bindPinnedTarget!({ ...common, targetId: "target-1" });
  expect(await harness.readPinnedUrl!(common)).toBe("https://console.example.test/projects");
  await harness.closePrivateDaemons!({ socketDirectory: common.socketDirectory, homeDirectory: common.homeDirectory });

  expect(calls.map((call) => call.command.slice(1))).toEqual([
    ["--session", common.session, "--pin-tab", "tab", "target-1"],
    ["--session", common.session, "get", "url"],
    ["close", "--all"],
  ]);
  expect(calls[0]!.environment["AGENT_BROWSER_PIN_TAB"]).toBe("1");
  expect(calls[1]!.environment["AGENT_BROWSER_PIN_TAB"]).toBe("1");
  expect(calls[2]!.environment).toEqual({
    HOME: common.homeDirectory,
    AGENT_BROWSER_SOCKET_DIR: common.socketDirectory,
  });
});
