import { describe, expect, mock, test } from "bun:test";
import type { DesktopReadyToWorkAPI } from "../../src/lib/desktop";
import {
  canInstallReadyToWorkRendererOwnerAdapter,
  createReadyToWorkRendererOwnerAdapter,
  type ReadyToWorkRendererOwnerPort,
} from "../../src/adapters/nautilo-runtime";

type RestoreRequest = {
  attemptId: string;
  voice: boolean | null;
  autoApprove: boolean | null;
};

function createBridge() {
  let handler: ((request: RestoreRequest) => void) | null = null;
  const unsubscribe = mock(() => undefined);
  const onRestoreRendererOwners = mock((next: (request: RestoreRequest) => void) => {
    handler = next;
    return unsubscribe;
  });
  const acknowledgeRendererOwners = mock(async (_result: {
    attemptId: string;
    voice: boolean;
    autoApprove: boolean;
  }) => undefined);
  const reportRendererOwners = mock(async (_result: { voice: boolean; autoApprove: boolean }) => (
    {} as Awaited<ReturnType<DesktopReadyToWorkAPI["get"]>>
  ));
  const restore = mock(async () => ({} as Awaited<ReturnType<DesktopReadyToWorkAPI["get"]>>));
  return {
    bridge: {
      onRestoreRendererOwners,
      acknowledgeRendererOwners,
      reportRendererOwners,
      restore,
    } as unknown as DesktopReadyToWorkAPI,
    acknowledgeRendererOwners,
    reportRendererOwners,
    restore,
    onRestoreRendererOwners,
    unsubscribe,
    dispatch(request: RestoreRequest): void {
      handler?.(request);
    },
  };
}

function createOwners(initial = { voice: false, autoApprove: false }): {
  owners: ReadyToWorkRendererOwnerPort;
  state: { voice: boolean; autoApprove: boolean };
  setVoice: ReturnType<typeof mock<(enabled: boolean) => void>>;
  setAutoApprove: ReturnType<typeof mock<(enabled: boolean) => void>>;
  primeVoice: ReturnType<typeof mock<() => Promise<void>>>;
} {
  const state = { ...initial };
  const setVoice = mock((enabled: boolean) => { state.voice = enabled; });
  const setAutoApprove = mock((enabled: boolean) => { state.autoApprove = enabled; });
  const primeVoice = mock(async () => undefined);
  return {
    state,
    setVoice,
    setAutoApprove,
    primeVoice,
    owners: {
      readVoice: () => state.voice,
      setVoice,
      primeVoice,
      readAutoApprove: () => state.autoApprove,
      setAutoApprove,
    },
  };
}

describe("Ready-to-work renderer owner adapter", () => {
  test("applies selected enables through existing owners and acknowledges their actual truth", async () => {
    const bridge = createBridge();
    const fixture = createOwners();
    createReadyToWorkRendererOwnerAdapter(bridge.bridge, fixture.owners);

    bridge.dispatch({ attemptId: "attempt-enable", voice: true, autoApprove: true });
    await Promise.resolve();

    expect(fixture.setVoice).toHaveBeenCalledWith(true);
    expect(fixture.primeVoice).toHaveBeenCalledTimes(1);
    expect(fixture.setAutoApprove).toHaveBeenCalledWith(true);
    expect(bridge.acknowledgeRendererOwners).toHaveBeenCalledWith({
      attemptId: "attempt-enable",
      voice: true,
      autoApprove: true,
    });
  });

  test("leaves null owners unchanged while still acknowledging their current truth", async () => {
    const bridge = createBridge();
    const fixture = createOwners({ voice: true, autoApprove: false });
    createReadyToWorkRendererOwnerAdapter(bridge.bridge, fixture.owners);

    bridge.dispatch({ attemptId: "attempt-null", voice: null, autoApprove: null });
    await Promise.resolve();

    expect(fixture.setVoice).not.toHaveBeenCalled();
    expect(fixture.setAutoApprove).not.toHaveBeenCalled();
    expect(bridge.acknowledgeRendererOwners).toHaveBeenCalledWith({
      attemptId: "attempt-null",
      voice: true,
      autoApprove: false,
    });
  });

  test("applies selected disables and never acknowledges requested truth blindly", async () => {
    const bridge = createBridge();
    const fixture = createOwners({ voice: true, autoApprove: true });
    const rejectedVoice = mock((_enabled: boolean) => {
      // Simulate the canonical owner refusing a state change.
    });
    fixture.owners.setVoice = rejectedVoice;
    createReadyToWorkRendererOwnerAdapter(bridge.bridge, fixture.owners);

    bridge.dispatch({ attemptId: "attempt-disable", voice: false, autoApprove: false });
    await Promise.resolve();

    expect(rejectedVoice).toHaveBeenCalledWith(false);
    expect(fixture.setAutoApprove).toHaveBeenCalledWith(false);
    expect(bridge.acknowledgeRendererOwners).toHaveBeenCalledWith({
      attemptId: "attempt-disable",
      voice: true,
      autoApprove: false,
    });
  });

  test("reports live manual drift once without requesting another restore", async () => {
    const bridge = createBridge();
    const fixture = createOwners();
    const adapter = createReadyToWorkRendererOwnerAdapter(bridge.bridge, fixture.owners);

    fixture.state.voice = true;
    adapter.reportIfChanged();
    adapter.reportIfChanged();
    await Promise.resolve();

    expect(bridge.reportRendererOwners).toHaveBeenCalledTimes(1);
    expect(bridge.reportRendererOwners).toHaveBeenCalledWith({ voice: true, autoApprove: false });
    expect(bridge.restore).toHaveBeenCalledTimes(1);
  });

  test("installs its listener before one startup replay and cleans it up", () => {
    const calls: string[] = [];
    let handler: ((request: RestoreRequest) => void) | null = null;
    const bridge = {
      onRestoreRendererOwners(next: (request: RestoreRequest) => void) {
        calls.push("listen");
        handler = next;
        return () => calls.push("unlisten");
      },
      acknowledgeRendererOwners: async () => undefined,
      reportRendererOwners: async () => ({}),
      restore: async () => { calls.push("restore"); return {}; },
    } as unknown as DesktopReadyToWorkAPI;
    const fixture = createOwners();
    const adapter = createReadyToWorkRendererOwnerAdapter(bridge, fixture.owners);

    expect(calls).toEqual(["listen", "restore"]);
    adapter.dispose();
    adapter.dispose();
    handler?.({ attemptId: "late", voice: true, autoApprove: true });

    expect(calls).toEqual(["listen", "restore", "unlisten"]);
    expect(fixture.setVoice).not.toHaveBeenCalled();
  });

  test("waits for the verified Auto-Approve owner before one startup replay", () => {
    const bridge = createBridge();
    const fixture = createOwners();

    expect(canInstallReadyToWorkRendererOwnerAdapter(bridge.bridge, null)).toBe(false);
    expect(bridge.restore).not.toHaveBeenCalled();

    expect(canInstallReadyToWorkRendererOwnerAdapter(bridge.bridge, "human-1")).toBe(true);
    createReadyToWorkRendererOwnerAdapter(bridge.bridge, fixture.owners);
    expect(bridge.restore).toHaveBeenCalledTimes(1);
  });
});
