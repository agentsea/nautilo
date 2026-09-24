import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import type { HumanPresenceStatus, RoomPresenceResponse } from "@nautilo/types";
import { dispatchAuthTransition } from "../../../../lib/auth-transition";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const requests: Array<{
  roomId: string;
  signal: AbortSignal;
  result: Deferred<RoomPresenceResponse>;
}> = [];
const getRoomPresence = mock((roomId: string, options: { signal: AbortSignal }) => {
  const result = deferred<RoomPresenceResponse>();
  requests.push({ roomId, signal: options.signal, result });
  return result.promise;
});

mock.module("../../../../lib/api", () => ({ apiClient: { getRoomPresence } }));

const { useRoomPresence } = await import("../use-room-presence");
const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

function PresenceProbe({
  roomId,
  viewerActorId,
}: {
  roomId: string;
  viewerActorId: string;
}) {
  const statuses = useRoomPresence(roomId, viewerActorId);
  const value = [...statuses.entries()]
    .map(([actorId, status]) => `${actorId}=${status}`)
    .sort()
    .join(",");
  return <output data-testid="presence">{value}</output>;
}

function response(actorId: string, status: HumanPresenceStatus): RoomPresenceResponse {
  return { members: [{ actorId, status }] };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(happyWindow.document, "visibilityState", {
    configurable: true,
    value: state,
  });
  happyWindow.document.dispatchEvent(new happyWindow.Event("visibilitychange"));
}

beforeAll(() => {
  for (const key of ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    CustomEvent: happyWindow.CustomEvent,
  });
  setVisibility("visible");
});

beforeEach(() => {
  requests.length = 0;
  getRoomPresence.mockClear();
  setVisibility("visible");
});

afterEach(() => cleanup());

afterAll(() => {
  cleanup();
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});

describe("useRoomPresence", () => {
  test("room and viewer changes clear old status and fence the prior response", async () => {
    const view = render(<PresenceProbe roomId="room-a" viewerActorId="viewer-a" />);
    expect(requests).toHaveLength(1);
    await act(async () => requests[0]!.result.resolve(response("human-a", "online")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-a=online"));

    act(() => view.rerender(<PresenceProbe roomId="room-b" viewerActorId="viewer-b" />));
    expect(view.getByTestId("presence").textContent).toBe("");
    expect(requests).toHaveLength(2);

    await act(async () => requests[0]!.result.resolve(response("stale-human", "offline")));
    expect(view.getByTestId("presence").textContent).toBe("");
    await act(async () => requests[1]!.result.resolve(response("human-b", "idle")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-b=idle"));

    act(() => view.rerender(<PresenceProbe roomId="room-c" viewerActorId="viewer-c" />));
    expect(view.getByTestId("presence").textContent).toBe("");
    act(() => view.rerender(<PresenceProbe roomId="room-d" viewerActorId="viewer-d" />));
    expect(requests[2]!.signal.aborted).toBe(true);
    await act(async () => requests[2]!.result.resolve(response("stale-human", "offline")));
    expect(view.getByTestId("presence").textContent).toBe("");
    await act(async () => requests[3]!.result.resolve(response("human-d", "online")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-d=online"));
    view.unmount();
  });

  test("hidden pauses and clears, visible immediately fetches again", async () => {
    const view = render(<PresenceProbe roomId="room-a" viewerActorId="viewer-a" />);
    await act(async () => requests[0]!.result.resolve(response("human-a", "online")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-a=online"));

    act(() => setVisibility("hidden"));
    expect(view.getByTestId("presence").textContent).toBe("");
    expect(getRoomPresence).toHaveBeenCalledTimes(1);

    act(() => setVisibility("visible"));
    expect(getRoomPresence).toHaveBeenCalledTimes(2);
    await act(async () => requests[1]!.result.resolve(response("human-a", "idle")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-a=idle"));
    view.unmount();
  });

  test("matching membership changes refetch; unmount aborts the pending request", async () => {
    const view = render(<PresenceProbe roomId="room-a" viewerActorId="viewer-a" />);
    await act(async () => requests[0]!.result.resolve(response("human-a", "online")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-a=online"));

    act(() => happyWindow.dispatchEvent(new happyWindow.CustomEvent("nautilo:room-members-changed", {
      detail: { roomId: "other-room" },
    })));
    expect(getRoomPresence).toHaveBeenCalledTimes(1);
    act(() => happyWindow.dispatchEvent(new happyWindow.CustomEvent("nautilo:room-members-changed", {
      detail: { roomId: "room-a" },
    })));
    expect(getRoomPresence).toHaveBeenCalledTimes(2);
    expect(view.getByTestId("presence").textContent).toBe("");
    view.unmount();
    expect(requests[1]!.signal.aborted).toBe(true);
  });

  test("sign-out clears status and pauses an in-flight response", async () => {
    const view = render(<PresenceProbe roomId="room-a" viewerActorId="viewer-a" />);
    await act(async () => requests[0]!.result.resolve(response("human-a", "online")));
    await waitFor(() => expect(view.getByTestId("presence").textContent).toBe("human-a=online"));

    act(() => dispatchAuthTransition({
      credentialGeneration: 2,
      viewerGeneration: 2,
      reason: "signed-out",
    }));
    expect(view.getByTestId("presence").textContent).toBe("");
    expect(getRoomPresence).toHaveBeenCalledTimes(1);

    // A later identity transition reactivates polling only if the roster stays visible.
    act(() => dispatchAuthTransition({
      credentialGeneration: 3,
      viewerGeneration: 3,
      reason: "signed-in",
    }));
    expect(getRoomPresence).toHaveBeenCalledTimes(2);
    expect(requests[1]!.signal.aborted).toBe(false);
    view.unmount();
  });
});
