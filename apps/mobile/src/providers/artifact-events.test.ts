import { expect, test } from "bun:test";

import {
  beginArtifactEventLifecycleRecovery,
  shouldCloseArtifactEventStreamForLifecycleRecovery,
  shouldRefreshArtifactEventToken,
  settleArtifactEventStart,
  startArtifactEventSubscription,
} from "./artifact-events-seam";

test("artifact event provider is one server-scoped authenticated SSE fan-out with fenced reconnect invalidation", async () => {
  const source = await Bun.file(new URL("./artifact-events.tsx", import.meta.url)).text();
  const seam = await Bun.file(new URL("./artifact-events-seam.ts", import.meta.url)).text();
  expect(source).toContain("startArtifactEventSubscription");
  expect(source).toContain("generationRef.current === generation");
  expect(source).toContain("refreshedAfterUnauthorized");
  expect(source).toContain("lifecycleRecoveryUsed");
  expect(source).toContain("pendingUnauthorizedRebind");
  expect(source).toContain("pendingTransportClose");
  expect(source).toContain('appLifecycle.addEventListener("change"');
  expect(source).toContain("ensureValidToken(serverId, server.serverUrl, { forceRefresh })");
  expect(seam).toContain('dispatch({ type: "reconnected" })');
  expect(source).toContain("unsubscribe?.()");
  expect(source).not.toContain("setInterval");
  expect(source).not.toContain("setTimeout");
});

test("late token resolution after a server switch neither latches nor subscribes", async () => {
  let resolveToken!: (value: string) => void;
  const token = new Promise<string>((resolve) => { resolveToken = resolve; });
  let current = true;
  let latched = 0;
  let subscribed = 0;
  const start = startArtifactEventSubscription({
    client: { setToken: () => { latched += 1; }, subscribeWorkspaceArtifactEvents: () => { subscribed += 1; return () => {}; } },
    getToken: () => token,
    isCurrent: () => current,
    onAuthDead: () => { throw new Error("unexpected"); },
    dispatch: () => {},
  });
  current = false;
  resolveToken("token");
  expect(await start).toBeUndefined();
  expect(latched).toBe(0);
  expect(subscribed).toBe(0);
});

test("only an explicit current 401 earns one fresh-token rebind", () => {
  expect(shouldRefreshArtifactEventToken(false, true, 401)).toBe(true);
  expect(shouldRefreshArtifactEventToken(true, true, 401)).toBe(false);
  expect(shouldRefreshArtifactEventToken(false, false, 401)).toBe(false);
  expect(shouldRefreshArtifactEventToken(false, true, 0)).toBe(false);
  expect(shouldRefreshArtifactEventToken(false, true, undefined)).toBe(false);
  expect(shouldRefreshArtifactEventToken(false, true, 503)).toBe(false);
  expect(shouldCloseArtifactEventStreamForLifecycleRecovery(undefined)).toBe(true);
  expect(shouldCloseArtifactEventStreamForLifecycleRecovery(0)).toBe(false);
  expect(shouldCloseArtifactEventStreamForLifecycleRecovery(401)).toBe(false);
  expect(shouldCloseArtifactEventStreamForLifecycleRecovery(503)).toBe(false);
});

test("an unauthorized error during async startup is settled into a fresh-token rebind", () => {
  expect(settleArtifactEventStart(true, false)).toBe("refresh-token");
  expect(settleArtifactEventStart(true, true)).toBe("refresh-token");
  expect(settleArtifactEventStart(false, true)).toBe("wait-for-lifecycle");
  expect(settleArtifactEventStart(false, false)).toBe("subscribed");
});

test("one AppState recovery invalidates once and starts an ordinary non-forced stream", () => {
  const recovery = beginArtifactEventLifecycleRecovery({
    nextAppState: "active",
    alreadyUsed: false,
    startInFlight: false,
    hasSubscription: false,
    current: true,
  });
  expect(recovery).toEqual({ invalidate: true, forceRefresh: false });
  expect(beginArtifactEventLifecycleRecovery({
    nextAppState: "active",
    alreadyUsed: true,
    startInFlight: false,
    hasSubscription: false,
    current: true,
  })).toBeUndefined();
  expect(beginArtifactEventLifecycleRecovery({
    nextAppState: "inactive",
    alreadyUsed: false,
    startInFlight: false,
    hasSubscription: false,
    current: true,
  })).toBeUndefined();
});

test("teardown closes a started subscription and reconnect fan-out invalidates consumers", async () => {
  let stop = 0;
  let onOpen: ((reconnected: boolean) => void) | undefined;
  const events: string[] = [];
  const close = await startArtifactEventSubscription({
    client: {
      setToken: () => {},
      subscribeWorkspaceArtifactEvents: (_handler, options) => {
        onOpen = options?.onOpen;
        return () => { stop += 1; };
      },
    },
    getToken: async () => "token",
    isCurrent: () => true,
    onAuthDead: () => {},
    dispatch: (event) => events.push(event.type),
  });
  onOpen?.(true);
  expect(events).toEqual(["reconnected"]);
  close?.();
  expect(stop).toBe(1);
});

test("the seam carries the native handshake status without inventing one for transport errors", async () => {
  let onError: ((error: { status?: number }) => void) | undefined;
  const errors: Array<number | undefined> = [];
  await startArtifactEventSubscription({
    client: {
      setToken: () => {},
      subscribeWorkspaceArtifactEvents: (_handler, options) => {
        onError = options?.onError;
        return () => {};
      },
    },
    getToken: async () => "token",
    isCurrent: () => true,
    onAuthDead: () => { throw new Error("unexpected"); },
    dispatch: () => {},
    onError: ({ status }) => errors.push(status),
  });
  onError?.({ status: 401 });
  onError?.({});
  expect(errors).toEqual([401, undefined]);
});
