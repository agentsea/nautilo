import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
  findSingleBrowserUsePageTargetAtOrigin,
  navigateBrowserUseCdpPage,
  resolveBrowserUseCdpWebSocketUrl,
  verifyBrowserUseCdpSignIn,
} from "../../src/connected-web-accounts/cdp-navigator";

const CDP_HOST = "11111111-1111-4111-8111-111111111111.cdp.browser-use.com";

async function expectNavigationUnavailable(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ message: "navigation unavailable" });
}

class FakeCdpSocket extends EventEmitter {
  readonly commands: Record<string, unknown>[] = [];
  closed = false;

  constructor(private readonly targetInfos: readonly Record<string, unknown>[]) {
    super();
  }

  open(): void { queueMicrotask(() => this.emit("open")); }

  send(raw: string, callback: (error?: Error) => void): void {
    const command = JSON.parse(raw) as Record<string, unknown>;
    this.commands.push(command);
    callback();
    const method = command["method"];
    const result = method === "Target.getTargets"
      ? { targetInfos: this.targetInfos }
      : method === "Target.attachToTarget"
        ? { sessionId: "attached-session" }
        : method === "Page.navigate"
          ? { frameId: "frame" }
          : {};
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: command["id"], result }))));
  }

  close(): void { this.closed = true; }
}

type PageInspection = Readonly<{
  visible: boolean;
  atExpectedOrigin: boolean;
  authenticationRequired: boolean;
}>;

class VerificationCdpSocket extends EventEmitter {
  readonly commands: Record<string, unknown>[] = [];
  closed = false;

  constructor(
    private readonly targetInfos: readonly Record<string, unknown>[],
    private readonly inspections: Readonly<Record<string, PageInspection>>,
  ) {
    super();
  }

  open(): void { queueMicrotask(() => this.emit("open")); }

  send(raw: string, callback: (error?: Error) => void): void {
    const command = JSON.parse(raw) as Record<string, unknown>;
    this.commands.push(command);
    callback();
    const method = command["method"];
    let result: unknown = {};
    if (method === "Target.getTargets") result = { targetInfos: this.targetInfos };
    if (method === "Target.attachToTarget") {
      const targetId = (command["params"] as { targetId: string }).targetId;
      result = { sessionId: `session:${targetId}` };
    }
    if (method === "Runtime.evaluate") {
      const targetId = String(command["sessionId"]).replace(/^session:/u, "");
      result = { result: { type: "object", value: this.inspections[targetId] } };
    }
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: command["id"], result }))));
  }

  close(): void { this.closed = true; }
}

function discoveryResponse(): Response {
  return Response.json({ webSocketDebuggerUrl: `wss://${CDP_HOST}/devtools/browser/opaque` });
}

test("D568 resolves Browser Use's HTTPS discovery capability to its same-host WSS endpoint", async () => {
  const requests: string[] = [];
  const resolved = await resolveBrowserUseCdpWebSocketUrl(
    `https://${CDP_HOST}`,
    1_000,
    async (input) => {
      requests.push(String(input));
      return Response.json({ webSocketDebuggerUrl: `wss://${CDP_HOST}/devtools/browser/opaque` });
    },
  );

  expect(requests).toEqual([`https://${CDP_HOST}/json/version`]);
  expect(resolved).toBe(`wss://${CDP_HOST}/devtools/browser/opaque`);
});

test("D568 rejects non-provider discovery and cross-host WebSocket capabilities", async () => {
  let called = false;
  await expectNavigationUnavailable(resolveBrowserUseCdpWebSocketUrl(
    "https://attacker.example",
    1_000,
    async () => { called = true; return Response.json({}); },
  ));
  expect(called).toBe(false);

  await expectNavigationUnavailable(resolveBrowserUseCdpWebSocketUrl(
    `https://${CDP_HOST}`,
    1_000,
    async () => Response.json({ webSocketDebuggerUrl: "wss://attacker.example/devtools/browser/opaque" }),
  ));
});

test("D568 rejects malformed or oversized discovery responses", async () => {
  await expectNavigationUnavailable(resolveBrowserUseCdpWebSocketUrl(
    `https://${CDP_HOST}`,
    1_000,
    async () => new Response("not json", { status: 200 }),
  ));

  await expectNavigationUnavailable(resolveBrowserUseCdpWebSocketUrl(
    `https://${CDP_HOST}`,
    1_000,
    async () => new Response("x".repeat(16_385), { status: 200 }),
  ));
});

test("D568 reuses and foregrounds Browser Use's initial blank page instead of opening a second tab", async () => {
  const socket = new FakeCdpSocket([
    { targetId: "existing-page", type: "page", url: "https://stale.example" },
    { targetId: "initial-blank", type: "page", url: "about:blank" },
  ]);

  await navigateBrowserUseCdpPage(
    `https://${CDP_HOST}`,
    "https://www.airbnb.com",
    1_000,
    {
      fetch: async () => discoveryResponse(),
      createSocket: () => { socket.open(); return socket as unknown as WebSocket; },
    },
  );

  expect(socket.closed).toBe(true);
  expect(socket.commands).toEqual([
    { id: 1, method: "Target.getTargets" },
    { id: 2, method: "Target.attachToTarget", params: { targetId: "initial-blank", flatten: true } },
    { id: 3, method: "Page.navigate", params: { url: "https://www.airbnb.com" }, sessionId: "attached-session" },
    { id: 4, method: "Page.bringToFront", sessionId: "attached-session" },
    { id: 5, method: "Target.activateTarget", params: { targetId: "initial-blank" } },
  ]);
  expect(socket.commands.some((command) => command["method"] === "Target.createTarget")).toBe(false);
});

test("D568 fails closed when Browser Use exposes no page target to navigate", async () => {
  const socket = new FakeCdpSocket([{ targetId: "worker", type: "service_worker", url: "https://example.com/sw.js" }]);
  await expectNavigationUnavailable(navigateBrowserUseCdpPage(
    `https://${CDP_HOST}`,
    "https://example.com",
    1_000,
    {
      fetch: async () => discoveryResponse(),
      createSocket: () => { socket.open(); return socket as unknown as WebSocket; },
    },
  ));
  expect(socket.commands).toEqual([{ id: 1, method: "Target.getTargets" }]);
});

test("D568 accepts Done only from one visible signed-in page at the durable origin", async () => {
  const socket = new VerificationCdpSocket(
    [{ targetId: "account", type: "page", url: "https://console.example.test/projects" }],
    { account: { visible: true, atExpectedOrigin: true, authenticationRequired: false } },
  );

  expect(await verifyBrowserUseCdpSignIn(
    `https://${CDP_HOST}`,
    "https://console.example.test",
    1_000,
    {
      fetch: async () => discoveryResponse(),
      createSocket: () => { socket.open(); return socket as unknown as WebSocket; },
    },
  )).toEqual({ atExpectedOrigin: true, authenticationRequired: false });
  expect(socket.closed).toBe(true);
  expect(socket.commands.map((command) => command["method"])).toEqual([
    "Target.getTargets",
    "Target.attachToTarget",
    "Runtime.evaluate",
  ]);
});

test("D568 reports a visible same-origin login or verification surface as incomplete", async () => {
  const socket = new VerificationCdpSocket(
    [{ targetId: "login", type: "page", url: "https://console.example.test/login" }],
    { login: { visible: true, atExpectedOrigin: true, authenticationRequired: true } },
  );

  expect(await verifyBrowserUseCdpSignIn(
    `https://${CDP_HOST}`,
    "https://console.example.test",
    1_000,
    {
      fetch: async () => discoveryResponse(),
      createSocket: () => { socket.open(); return socket as unknown as WebSocket; },
    },
  )).toEqual({ atExpectedOrigin: true, authenticationRequired: true });
});

test("D568 checks the visible OAuth page instead of accepting a hidden stale origin tab", async () => {
  const socket = new VerificationCdpSocket(
    [
      { targetId: "stale", type: "page", url: "https://console.example.test/" },
      { targetId: "oauth", type: "page", url: "https://login.example.net/" },
    ],
    {
      stale: { visible: false, atExpectedOrigin: true, authenticationRequired: false },
      oauth: { visible: true, atExpectedOrigin: false, authenticationRequired: true },
    },
  );

  expect(await verifyBrowserUseCdpSignIn(
    `https://${CDP_HOST}`,
    "https://console.example.test",
    1_000,
    {
      fetch: async () => discoveryResponse(),
      createSocket: () => { socket.open(); return socket as unknown as WebSocket; },
    },
  )).toEqual({ atExpectedOrigin: false, authenticationRequired: true });
});

test("D568 fails closed when Browser Use exposes no unambiguous visible page", async () => {
  for (const inspections of [
    {
      one: { visible: false, atExpectedOrigin: true, authenticationRequired: false },
      two: { visible: false, atExpectedOrigin: false, authenticationRequired: false },
    },
    {
      one: { visible: true, atExpectedOrigin: true, authenticationRequired: false },
      two: { visible: true, atExpectedOrigin: false, authenticationRequired: true },
    },
  ]) {
    const socket = new VerificationCdpSocket(
      [
        { targetId: "one", type: "page", url: "https://console.example.test/" },
        { targetId: "two", type: "page", url: "https://login.example.net/" },
      ],
      inspections,
    );
    await expectNavigationUnavailable(verifyBrowserUseCdpSignIn(
      `https://${CDP_HOST}`,
      "https://console.example.test",
      1_000,
      {
        fetch: async () => discoveryResponse(),
        createSocket: () => { socket.open(); return socket as unknown as WebSocket; },
      },
    ));
  }
});

test("D568 direct target discovery binds exactly one page at the durable account origin", async () => {
  const socket = new FakeCdpSocket([
    { targetId: "right-tab", type: "page", url: "https://console.example.test/projects" },
    { targetId: "other-tab", type: "page", url: "https://example.net/" },
  ]);
  const target = await findSingleBrowserUsePageTargetAtOrigin(
    `wss://${CDP_HOST}/devtools/browser/opaque`, "https://console.example.test", 1_000,
    { createSocket: () => { socket.open(); return socket as unknown as WebSocket; } },
  );
  expect(target).toBe("right-tab");
  expect(socket.commands).toEqual([{ id: 1, method: "Target.getTargets" }]);
});

test("D568 direct target discovery rejects absent and ambiguous origin tabs without choosing", async () => {
  for (const targets of [
    [{ targetId: "other", type: "page", url: "https://example.net/" }],
    [
      { targetId: "one", type: "page", url: "https://console.example.test/a" },
      { targetId: "two", type: "page", url: "https://console.example.test/b" },
    ],
  ]) {
    const socket = new FakeCdpSocket(targets);
    await expectNavigationUnavailable(findSingleBrowserUsePageTargetAtOrigin(
      `wss://${CDP_HOST}/devtools/browser/private-token`, "https://console.example.test", 1_000,
      { createSocket: () => { socket.open(); return socket as unknown as WebSocket; } },
    ));
  }
});
