import { expect, test } from "bun:test";
import { agentBrowserCdpArgv } from "../../../relay/src/browser";
import {
  createDirectBrowserControlSession,
  DirectBrowserControlError,
  type DirectBrowserControlDependencies,
} from "../../src/connected-web-accounts/direct-browser-control";

const CDP_DISCOVERY = "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com";
const RESOLVED_CDP = "wss://11111111-1111-4111-8111-111111111111.cdp.browser-use.com/devtools/browser/private-token";

function makeDependencies(overrides: Partial<DirectBrowserControlDependencies> = {}): {
  readonly deps: DirectBrowserControlDependencies;
  readonly calls: {
    readonly stopped: string[];
    readonly invoked: Array<{ argv: readonly string[]; environment: Readonly<{ AGENT_BROWSER_CDP: string }>; socketDirectory: string; homeDirectory: string }>;
    readonly resolved: Array<{ cdpUrl: string; timeoutMs: number }>;
  };
} {
  const calls: {
    stopped: string[];
    invoked: Array<{ argv: readonly string[]; environment: Readonly<{ AGENT_BROWSER_CDP: string }>; socketDirectory: string; homeDirectory: string }>;
    resolved: Array<{ cdpUrl: string; timeoutMs: number }>;
  } = { stopped: [], invoked: [], resolved: [] };
  const harness: NonNullable<DirectBrowserControlDependencies["harness"]> = {
    buildArgv: ({ toolName, args, session }) => agentBrowserCdpArgv(toolName, args as Record<string, unknown>, session),
    invoke: async (input) => { calls.invoked.push(input); return { text: "browser output", truncated: false }; },
    bindPinnedTarget: async () => undefined,
    readPinnedUrl: async () => "https://console.example.test/page",
    closePrivateDaemons: async () => undefined,
    ...overrides.harness,
  };
  const deps: DirectBrowserControlDependencies = {
    provider: {
      stopBrowser: async (browserId) => { calls.stopped.push(browserId); },
    },
    isCurrentControlEpoch: async () => true,
    resolveCdpWebSocketUrl: async (cdpUrl, timeoutMs) => {
      calls.resolved.push({ cdpUrl, timeoutMs });
      return RESOLVED_CDP;
    },
    findPageTargetAtOrigin: async () => "target-1",
    ...overrides,
    harness,
  };
  return { deps, calls };
}

async function start(overrides: Partial<DirectBrowserControlDependencies> = {}) {
  const { deps, calls } = makeDependencies(overrides);
  const session = await createDirectBrowserControlSession({
    identity: { operationId: "operation-1", accountId: "account-1", controlEpoch: 4 },
    browser: { browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY },
    allowedOrigin: "https://console.example.test",
    harnessSession: "operation-1-account-1-epoch-4",
    socketDirectory: "/private/direct-operation/socket",
    homeDirectory: "/private/direct-operation/home",
  }, deps);
  return { session, calls };
}

test("D568 direct adapter resolves CDP once and passes it only through AGENT_BROWSER_CDP", async () => {
  const { session, calls } = await start();
  expect(await session.invoke({ toolName: "browser_click", args: { ref: "e9" } })).toEqual({
    text: "browser output",
    truncated: false,
  });

  expect(calls.resolved).toEqual([{ cdpUrl: CDP_DISCOVERY, timeoutMs: 15_000 }]);
  expect(calls.invoked).toEqual([{
    argv: ["--session", "operation-1-account-1-epoch-4", "click", "@e9"],
    environment: { AGENT_BROWSER_CDP: RESOLVED_CDP },
    socketDirectory: "/private/direct-operation/socket",
    homeDirectory: "/private/direct-operation/home",
  }]);
  const invoked = calls.invoked[0]!;
  expect(invoked.argv).not.toContain("--cdp");
  expect(invoked.argv).not.toContain("--provider");
  expect(invoked.argv).not.toContain("--config");
  expect(invoked.argv.join(" ")).not.toContain(RESOLVED_CDP);
  expect(calls.stopped).toEqual([]);

  expect(await session.close()).toEqual({ status: "stopped" });
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("D568 direct adapter rejects a stale epoch before it can invoke a harness", async () => {
  const { deps, calls } = makeDependencies({ isCurrentControlEpoch: async () => false });
  const error = await createDirectBrowserControlSession({
    identity: { operationId: "operation-1", accountId: "account-1", controlEpoch: 4 },
    browser: { browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY },
    allowedOrigin: "https://console.example.test",
    harnessSession: "operation-1-account-1-epoch-4",
    socketDirectory: "/private/direct-operation/socket",
    homeDirectory: "/private/direct-operation/home",
  }, deps).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({
    code: "stale_control",
    message: "direct browser control unavailable",
  });
  expect(calls.invoked).toEqual([]);
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("D568 rechecks the epoch before every command after a session has started", async () => {
  let current = true;
  const { session, calls } = await start({ isCurrentControlEpoch: async () => current });
  current = false;
  const error = await session.invoke({ toolName: "browser_snapshot", args: {} }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ code: "stale_control", message: "direct browser control unavailable" });
  expect(calls.invoked).toEqual([]);
  expect(calls.stopped).toEqual([]);
  expect(await session.close()).toEqual({ status: "stopped" });
});

test("D568 direct adapter rejects an unsafe harness argv and stops the exact provider browser", async () => {
  const { session, calls } = await start({
    harness: {
      buildArgv: () => ["--provider", "browseruse", "snapshot"],
      invoke: async () => { throw new Error("must not run"); },
    },
  });
  const error = await session.invoke({ toolName: "browser_snapshot", args: {} }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({
    code: "unavailable",
    message: "direct browser control unavailable",
  });
  expect(calls.invoked).toEqual([]);
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("D568 direct adapter redacts a harness failure and stops even when the failure contains CDP data", async () => {
  const { session, calls } = await start({
    harness: {
      buildArgv: ({ toolName, args, session: harnessSession }) => agentBrowserCdpArgv(toolName, args as Record<string, unknown>, harnessSession),
      invoke: async () => { throw new Error(`failed to attach ${RESOLVED_CDP}`); },
    },
  });
  const error = await session.invoke({ toolName: "browser_snapshot", args: {} }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(DirectBrowserControlError);
  expect(error).toMatchObject({ code: "unavailable", message: "direct browser control unavailable" });
  expect(String(error)).not.toContain(RESOLVED_CDP);
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(await session.close()).toEqual({ status: "stopped" });
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("D568 setup failure stops the exact browser without exposing a discovery capability", async () => {
  const { deps, calls } = makeDependencies({
    resolveCdpWebSocketUrl: async () => { throw new Error(`bad discovery ${CDP_DISCOVERY}`); },
  });
  const error = await createDirectBrowserControlSession({
    identity: { operationId: "operation-1", accountId: "account-1", controlEpoch: 4 },
    browser: { browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY },
    allowedOrigin: "https://console.example.test",
    harnessSession: "operation-1-account-1-epoch-4",
    socketDirectory: "/private/direct-operation/socket",
    homeDirectory: "/private/direct-operation/home",
  }, deps).then(() => null, (cause: unknown) => cause);

  expect(error).toMatchObject({ code: "unavailable", message: "direct browser control unavailable" });
  expect(String(error)).not.toContain(CDP_DISCOVERY);
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("D568 rejects a pre-rotation epoch and cleans up the exact browser", async () => {
  const { deps, calls } = makeDependencies();
  const error = await createDirectBrowserControlSession({
    identity: { operationId: "operation-1", accountId: "account-1", controlEpoch: 0 },
    browser: { browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY },
    allowedOrigin: "https://console.example.test",
    harnessSession: "operation-1-account-1-epoch-0",
    socketDirectory: "/private/direct-operation/socket",
    homeDirectory: "/private/direct-operation/home",
  }, deps).then(() => null, (cause: unknown) => cause);

  expect(error).toMatchObject({ code: "unavailable", message: "direct browser control unavailable" });
  expect(calls.resolved).toEqual([]);
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("D568 concurrent closes share an attempt and a failed stop can be retried without restoring input", async () => {
  const { session, calls } = await start({
    provider: { stopBrowser: async (browserId) => { calls.stopped.push(browserId); if (calls.stopped.length === 1) throw new Error("provider failure"); } },
  });
  const [first, second] = await Promise.all([session.close(), session.close()]);
  expect(first).toEqual({ status: "cleanup_unresolved" });
  expect(second).toEqual({ status: "cleanup_unresolved" });
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(await session.close()).toEqual({ status: "stopped" });
  expect(await session.close()).toEqual({ status: "stopped" });
  expect(calls.stopped).toEqual(["browser-private-id", "browser-private-id"]);
  expect(await session.invoke({ toolName: "browser_snapshot", args: {} }).catch((error: unknown) => error)).toBeInstanceOf(Error);
});
