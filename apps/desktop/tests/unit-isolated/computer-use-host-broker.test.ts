import { describe, expect, test } from "bun:test";
import {
  ComputerUseHostBroker,
  type ComputerUseHostBrokerRequest,
  type ComputerUseHostLaunchInputs,
  type ComputerUseHostProtocolSession,
} from "../../electron/computer-use-host-runtime/index.ts";
import type { ComputerUseHostRuntimeLaunch } from "../../electron/computer-use-host-runtime/runtime.ts";
import type { ComputerUseHostContract, ComputerUseHostRequest, ComputerUseHostResult } from "@nautilo/computer-use-host-protocol";

const contract: ComputerUseHostContract = {
  contractNamespace: "nautilo.computer_use",
  contractId: "browser.read_page",
  contractVersion: 1,
  schemaDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  effectClass: "read",
  replayClass: "safe",
  authorityClass: "standing_computer_use",
  attachmentClass: "none",
  disclosureClass: "semantic",
};
const endpoint: ComputerUseHostLaunchInputs = {
  driverPath: "/Applications/Nautilo.app/Contents/Resources/tools-cua/cua-driver",
  runtimeRoot: "/tmp/nautilo-computer-use-host-test",
  hostBundleId: "com.nautilo.desktop",
};

function launch(): ComputerUseHostRuntimeLaunch {
  return {
    entrypoint: "/private/nautilo-host/nautilo-computer-use-host",
    generation: 7,
    release: {} as ComputerUseHostRuntimeLaunch["release"],
    lease: { generation: 7, release() {} },
  };
}

function request(signal?: AbortSignal): ComputerUseHostBrokerRequest {
  return {
    authority: { authorityLeaseId: "cu:lease-1", authorityGeneration: 4 },
    cancellationGeneration: 4,
    contract,
    arguments: { target: "opaque-target", includeScreenshot: false },
    requestId: "request:1",
    ...(signal === undefined ? {} : { signal }),
  };
}

function session(onRequest: (message: ComputerUseHostRequest) => Promise<ComputerUseHostResult>): ComputerUseHostProtocolSession {
  return {
    ready: {
      kind: "ready",
      protocol: { major: 3, minor: 0 },
      hostGeneration: "host:7",
      driverGeneration: "cua:host-checked-1",
      contracts: [contract],
    },
    request: async (message) => ({ result: await onRequest(message) }),
    cancel: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

describe("Computer Use Host broker", () => {
  test("forwards an exact catalogue descriptor and arguments through v3", async () => {
    const requests: ComputerUseHostRequest[] = [];
    let released = 0;
    const runtimeLaunch = { ...launch(), lease: { generation: 7, release: () => { released += 1; } } };
    const broker = new ComputerUseHostBroker(
      { bootstrap: async () => ({ state: "ready" }), acquireLaunch: () => runtimeLaunch },
      { launch: async () => session(async (message) => {
        requests.push(message);
        return {
          kind: "result", protocol: { major: 3, minor: 0 }, requestId: message.requestId,
          fence: message.fence, contract: message.contract, settlement: "completed", result: { status: "observed" },
        };
      }) },
      () => endpoint,
    );

    const outcome = await broker.dispatch(request());
    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.kind).toBe("request");
    expect(requests[0]?.protocol).toEqual({ major: 3, minor: 0 });
    expect(requests[0]?.authority).toEqual(request().authority);
    expect(requests[0]?.fence).toEqual({ hostGeneration: "host:7", driverGeneration: "cua:host-checked-1", cancellationGeneration: 4 });
    expect(requests[0]?.contract).toEqual(contract);
    expect(requests[0]?.arguments).toEqual(request().arguments);
    // The probe lease is released; the active generation's lease remains.
    expect(released).toBe(1);
    await broker.close();
    expect(released).toBe(2);
  });

  test("rejects a Host whose descriptor differs", async () => {
    const broker = new ComputerUseHostBroker(
      { bootstrap: async () => ({ state: "ready" }), acquireLaunch: launch },
      { launch: async () => ({ ...session(async () => { throw new Error("must not request"); }), ready: {
        ...session(async () => { throw new Error("must not request"); }).ready,
        contracts: [],
      } }) },
      () => endpoint,
    );
    expect(await broker.dispatch(request())).toEqual({ ok: false, code: "host_unavailable" });
  });

  test("does not launch when the Host-owned runtime inputs are not absolute", async () => {
    let launches = 0;
    const broker = new ComputerUseHostBroker(
      { bootstrap: async () => ({ state: "ready" }), acquireLaunch: launch },
      { launch: async () => { launches += 1; return session(async () => { throw new Error("must not request"); }); } },
      () => ({ ...endpoint, runtimeRoot: "relative-root" }),
    );
    expect(await broker.dispatch(request())).toEqual({ ok: false, code: "host_unavailable" });
    expect(launches).toBe(0);
  });

  test("keeps one Host generation alive across observe, action, and fresh verification", async () => {
    let launches = 0;
    let closes = 0;
    const requests: ComputerUseHostRequest[] = [];
    const broker = new ComputerUseHostBroker(
      { bootstrap: async () => ({ state: "ready" }), acquireLaunch: launch },
      { launch: async () => {
        launches += 1;
        return {
          ...session(async (message) => {
            requests.push(message);
            return { kind: "result", protocol: { major: 3, minor: 0 }, requestId: message.requestId, fence: message.fence, contract: message.contract, settlement: "completed", result: { status: "ok" } };
          }),
          close: async () => { closes += 1; },
        };
      } },
      () => endpoint,
    );
    for (const requestId of ["request:observe", "request:action", "request:verify"]) {
      expect((await broker.dispatch({ ...request(), requestId })).ok).toBe(true);
    }
    expect(launches).toBe(1);
    expect(closes).toBe(0);
    expect(requests.map((item) => item.fence.hostGeneration)).toEqual(["host:7", "host:7", "host:7"]);
    await broker.close();
    expect(closes).toBe(1);
  });

  test("cancels one simultaneous request without closing its sibling's Host session", async () => {
    let launches = 0;
    let closes = 0;
    const cancelled: Parameters<ComputerUseHostProtocolSession["cancel"]>[0][] = [];
    const pending = new Map<string, Readonly<{
      message: ComputerUseHostRequest;
      resolve: (value: Awaited<ReturnType<ComputerUseHostProtocolSession["request"]>>) => void;
    }>>();
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
    const broker = new ComputerUseHostBroker(
      { bootstrap: async () => ({ state: "ready" }), acquireLaunch: launch },
      { launch: async () => {
        launches += 1;
        const base = session(async () => { throw new Error("custom request owns settlement"); });
        return {
          ...base,
          request: (message) => new Promise((resolve) => {
            pending.set(message.requestId, { message, resolve });
            if (pending.size === 2) markBothStarted();
          }),
          cancel: async (message) => {
            cancelled.push(message);
            const target = pending.get(message.requestId);
            if (target === undefined) return;
            target.resolve({ result: {
              kind: "result",
              protocol: { major: 3, minor: 0 },
              requestId: target.message.requestId,
              fence: target.message.fence,
              contract: target.message.contract,
              settlement: "cancelled",
              result: { status: "cancelled" },
            } });
            pending.delete(message.requestId);
          },
          close: async () => { closes += 1; },
        };
      } },
      () => endpoint,
    );
    const firstAbort = new AbortController();
    const first = broker.dispatch({ ...request(firstAbort.signal), requestId: "request:first" });
    const second = broker.dispatch({ ...request(), requestId: "request:second" });
    await bothStarted;

    firstAbort.abort();
    const secondPending = pending.get("request:second");
    expect(secondPending).toBeDefined();
    secondPending!.resolve({ result: {
      kind: "result",
      protocol: { major: 3, minor: 0 },
      requestId: secondPending!.message.requestId,
      fence: secondPending!.message.fence,
      contract: secondPending!.message.contract,
      settlement: "completed",
      result: { status: "observed" },
    } });
    pending.delete("request:second");

    expect(await first).toEqual({ ok: false, code: "host_cancelled" });
    expect(await second).toMatchObject({ ok: true, result: { requestId: "request:second", settlement: "completed" } });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      requestId: "request:first",
      authority: request().authority,
      fence: {
        hostGeneration: "host:7",
        driverGeneration: "cua:host-checked-1",
        cancellationGeneration: 4,
      },
    });
    expect(launches).toBe(1);
    expect(closes).toBe(0);
    await broker.close();
    expect(closes).toBe(1);
  });

  test("retires a crashed Host and fences stale references on the replacement generation", async () => {
    let launches = 0;
    const fences: string[] = [];
    const broker = new ComputerUseHostBroker(
      { bootstrap: async () => ({ state: "ready" }), acquireLaunch: launch },
      { launch: async () => {
        launches += 1;
        if (launches === 1) return session(async () => { throw new Error("host crashed"); });
        const replacement = session(async (message) => {
          fences.push(message.fence.hostGeneration);
          return { kind: "result", protocol: { major: 3, minor: 0 }, requestId: message.requestId, fence: message.fence, contract: message.contract, settlement: "completed", result: { status: "fresh" } };
        });
        return { ...replacement, ready: { ...replacement.ready, hostGeneration: "host:replacement" } };
      } },
      () => endpoint,
    );
    expect(await broker.dispatch({ ...request(), requestId: "request:stale" })).toEqual({ ok: false, code: "host_protocol_rejected" });
    expect((await broker.dispatch({ ...request(), requestId: "request:fresh" })).ok).toBe(true);
    expect(launches).toBe(2);
    expect(fences).toEqual(["host:replacement"]);
  });
});
