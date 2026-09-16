import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, mock, afterAll } from "bun:test";
import type { ReactNode } from "react";
import { ThreadRequestError } from "../api";

beforeEach(() => {
  reapplyHappyDomGlobals();
});

let findExistingResult: string | null = null;
let findExistingError: Error | null = null;
const findExistingSubthread = mock(async (_roomId: string, _messageId: number) => findExistingResult);
const createSubthread = mock(async (_roomId: string, _messageId: number) => ({
  subthreadRoomId: "new-thread-456",
}));
describe("use-open-thread", () => {
  let DrawerProvider: typeof import("../drawer-state.tsx").DrawerProvider;
  let useDrawer: typeof import("../drawer-state.tsx").useDrawer;
  let useOpenThread: typeof import("../use-open-thread").useOpenThread;

  beforeAll(async () => {
    ({ DrawerProvider, useDrawer } = await import("../drawer-state.tsx"));
    ({ useOpenThread } = await import("../use-open-thread"));
  });

  afterAll(() => {
    mock.restore();
    reapplyHappyDomGlobals();
  });

  beforeEach(() => {
    findExistingResult = null;
    findExistingError = null;
    findExistingSubthread.mockImplementation(async () => {
      if (findExistingError) throw findExistingError;
      return findExistingResult;
    });
    findExistingSubthread.mockClear();
    createSubthread.mockClear();
  });

  it("creates a new subthread if none exists", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DrawerProvider>{children}</DrawerProvider>
    );

    const { result } = renderHook(
      () => {
        const drawer = useDrawer();
        const openThread = useOpenThread({ findExistingSubthread, createSubthread });
        return { drawer, openThread };
      },
      { wrapper },
    );

    await result.current.openThread("room-123", 999);

    await waitFor(() => {
      expect(result.current.drawer.current.kind).toBe("thread");
    });

    expect(findExistingSubthread).toHaveBeenCalledWith("room-123", 999);
    expect(createSubthread).toHaveBeenCalledWith("room-123", 999);
    expect(result.current.drawer.current).toEqual({
      kind: "thread",
      parentRoomId: "room-123",
      subthreadRoomId: "new-thread-456",
      anchorMessageId: 999,
    });
  });

  it("opens existing subthread if found", async () => {
    findExistingResult = "existing-thread-789";

    const wrapper = ({ children }: { children: ReactNode }) => (
      <DrawerProvider>{children}</DrawerProvider>
    );

    const { result } = renderHook(
      () => {
        const drawer = useDrawer();
        const openThread = useOpenThread({ findExistingSubthread, createSubthread });
        return { drawer, openThread };
      },
      { wrapper },
    );

    await result.current.openThread("room-123", 999);

    await waitFor(() => {
      expect(result.current.drawer.current.kind).toBe("thread");
    });

    expect(findExistingSubthread).toHaveBeenCalledWith("room-123", 999);
    expect(createSubthread).not.toHaveBeenCalled();
    expect(result.current.drawer.current).toEqual({
      kind: "thread",
      parentRoomId: "room-123",
      subthreadRoomId: "existing-thread-789",
      anchorMessageId: 999,
    });
  });

  it("does not create when the existing-thread lookup fails", async () => {
    findExistingError = new Error("transport failed");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DrawerProvider>{children}</DrawerProvider>
    );
    const { result } = renderHook(
      () => useOpenThread({ findExistingSubthread, createSubthread }),
      { wrapper },
    );

    const outcome = await result.current("room-123", 999);

    expect(outcome).toEqual({ opened: false, reason: "failed" });
    expect(createSubthread).not.toHaveBeenCalled();
  });

  it("classifies a hidden existing child without creating or opening", async () => {
    findExistingError = new ThreadRequestError(404);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DrawerProvider>{children}</DrawerProvider>
    );
    const { result } = renderHook(
      () => useOpenThread({ findExistingSubthread, createSubthread }),
      { wrapper },
    );

    const outcome = await result.current("room-123", 999);

    expect(outcome).toEqual({ opened: false, reason: "not_visible" });
    expect(createSubthread).not.toHaveBeenCalled();
  });

  it("does nothing if no active room", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DrawerProvider>{children}</DrawerProvider>
    );

    const { result } = renderHook(
      () => {
        const drawer = useDrawer();
        const openThread = useOpenThread({ findExistingSubthread, createSubthread });
        return { drawer, openThread };
      },
      { wrapper },
    );

    await result.current.openThread(null, 999);

    expect(result.current.drawer.current.kind).toBe("closed");
    expect(findExistingSubthread).not.toHaveBeenCalled();
  });
});
