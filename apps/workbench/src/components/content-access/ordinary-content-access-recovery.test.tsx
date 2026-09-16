import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  OrdinaryContentAccessRecoveryNotice,
  type OrdinaryContentAccessRecoveryClient,
} from "./ordinary-content-access-recovery";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";
const coordinate = {
  originalJobId: "job-1",
  checkpointId: "checkpoint-1",
  turnId: "turn-1",
  toolCallId: "tool-1",
  agentId: "agent-1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OrdinaryContentAccessRecoveryNotice", () => {
  beforeEach(() => {
    cleanup();
    reapplyHappyDomGlobals();
  });

  test("shows only a server-discovered opaque recovery and submits it exactly", async () => {
    const recovery = deferred<{ outcome: "completed" }>();
    const discover = mock()
      .mockResolvedValueOnce([coordinate])
      .mockResolvedValueOnce([]);
    const recover = mock(() => recovery.promise);
    const client = { discoverAllOrdinaryContentAccessRecoveries: discover,
      recoverOrdinaryContentAccess: recover } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);

    await waitFor(() => expect(view.getByText("Sharing outcome needs verification")).toBeTruthy());
    expect(view.container.textContent).not.toContain("job-1");
    const button = view.getByRole("button", { name: "Check and continue" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(recover).toHaveBeenCalledWith(coordinate, expect.objectContaining({ roomId: ROOM_A }));

    recovery.resolve({ outcome: "completed" });
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.queryByText("Sharing outcome needs verification")).toBeNull());
  });

  test("retains the coordinate and refreshes durable truth after an unknown POST failure", async () => {
    const discover = mock()
      .mockResolvedValueOnce([coordinate])
      .mockResolvedValueOnce([coordinate]);
    const client = {
      discoverAllOrdinaryContentAccessRecoveries: discover,
      recoverOrdinaryContentAccess: mock(async () => { throw new Error("connection lost"); }),
    } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" });
    fireEvent.click(button);

    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(view.getByText("Sharing outcome needs verification")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test("busy retains the exact recovery without inventing a completed result", async () => {
    const discover = mock(async () => [coordinate]);
    const client = {
      discoverAllOrdinaryContentAccessRecoveries: discover,
      recoverOrdinaryContentAccess: mock(async () => ({ outcome: "busy" as const })),
    } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(discover).toHaveBeenCalledTimes(1);
    expect(view.getByText("Sharing outcome needs verification")).toBeTruthy();
  });

  test("hides stale results and aborts pending work on Room or authority drift", async () => {
    const firstDiscovery = deferred<[typeof coordinate]>();
    const recovery = deferred<{ outcome: "completed" }>();
    const signals: AbortSignal[] = [];
    const discover = mock((_options: { roomId: string; signal?: AbortSignal }) => {
      if (_options.signal) signals.push(_options.signal);
      return signals.length === 1
        ? firstDiscovery.promise
        : Promise.resolve([]);
    });
    const recover = mock((_coordinate: typeof coordinate, options: { signal?: AbortSignal }) => {
      if (options.signal) signals.push(options.signal);
      return recovery.promise;
    });
    const client = { discoverAllOrdinaryContentAccessRecoveries: discover,
      recoverOrdinaryContentAccess: recover } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);
    firstDiscovery.resolve([coordinate]);
    const button = await view.findByRole("button", { name: "Check and continue" });
    fireEvent.click(button);

    view.rerender(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_B}
      scopeKey="server-a:viewer-2:room-b"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);
    expect(view.queryByText("Sharing outcome needs verification")).toBeNull();
    await waitFor(() => expect(signals.some((signal) => signal.aborted)).toBe(true));
    recovery.resolve({ outcome: "completed" });
    await Promise.resolve();
    expect(view.queryByText("Sharing outcome needs verification")).toBeNull();
  });

  test("disables continuation while the foreground Room is running", async () => {
    const client = {
      discoverAllOrdinaryContentAccessRecoveries: mock(async () => [coordinate]),
      recoverOrdinaryContentAccess: mock(async () => ({ outcome: "completed" as const })),
    } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(client.recoverOrdinaryContentAccess).not.toHaveBeenCalled();
  });

  test("keeps independently paged fork recoveries reachable", async () => {
    const second = { ...coordinate, originalJobId: "job-2", toolCallId: "tool-2" };
    const recover = mock(async () => ({ outcome: "busy" as const }));
    const client = {
      discoverAllOrdinaryContentAccessRecoveries: mock(async () => [coordinate, second]),
      recoverOrdinaryContentAccess: recover,
    } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);
    const buttons = await view.findAllByRole("button", { name: "Check and continue" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(recover).toHaveBeenCalledWith(
      coordinate,
      expect.objectContaining({ roomId: ROOM_A }),
    ));
    await waitFor(() => expect((buttons[1] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(recover).toHaveBeenLastCalledWith(
      second,
      expect.objectContaining({ roomId: ROOM_A }),
    ));
  });

  test("keeps a POST disabled across background rediscovery", async () => {
    const pending = deferred<{ outcome: "busy" }>();
    const recover = mock(() => pending.promise);
    const client = {
      discoverAllOrdinaryContentAccessRecoveries: mock(async () => [coordinate]),
      recoverOrdinaryContentAccess: recover,
    } as OrdinaryContentAccessRecoveryClient;
    const view = render(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={0}
      foregroundRunning={false}
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" });
    fireEvent.click(button);
    expect((view.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<OrdinaryContentAccessRecoveryNotice
      roomId={ROOM_A}
      scopeKey="server-a:viewer-1:room-a"
      discoveryGeneration={1}
      foregroundRunning={false}
      client={client}
    />);
    await waitFor(() => expect(client.discoverAllOrdinaryContentAccessRecoveries).toHaveBeenCalledTimes(2));
    expect((view.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    pending.resolve({ outcome: "busy" });
    await waitFor(() => expect(view.getByRole("button", { name: "Check and continue" })).toBeTruthy());
  });
});
