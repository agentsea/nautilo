/**
 * ISSUE-D443 — real assistant-ui middle-delete lifecycle regression.
 *
 * This intentionally mirrors the production seam:
 * AssistantRuntimeProvider + useExternalStoreRuntime + synchronized AUI
 * messages + real TranscriptWindow + production's id-stable
 * ThreadPrimitive.Unstable_MessageById custom-list primitive. Updates use
 * async `act`, matching assistant-ui's own tests, so runtime adapter effects
 * and external-store subscribers flush before checks.
 */
import "../bun-dom-preload";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createElement,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useAuiState,
  useMessage,
  ThreadPrimitive,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  TranscriptWindow,
  type TranscriptWindowHandle,
} from "../../src/components/transcript-window";
import { deriveTranscriptSync } from "../../src/components/conversation-transcript-sync";

type Msg = { id: string; role: "user" | "assistant"; text: string };

const convertMessage = (m: Msg): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: [{ type: "text", text: m.text }],
});

function makeMessages(count: number): Msg[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i}`,
  }));
}

function MinimalMessage(): ReactNode {
  const role = useMessage((s) => s.role);
  const id = useMessage((s) => String(s.id));
  const [mountId] = useState(() => {
    nextMessageMountId += 1;
    return nextMessageMountId;
  });
  return (
    <div
      data-message-row="true"
      data-role={role}
      data-message-id={id}
      data-message-mount-id={mountId}
    >
      {id}
    </div>
  );
}

let nextMessageMountId = 0;

const MESSAGE_COMPONENTS = { Message: MinimalMessage };

function TranscriptLeaf({
  viewportRef,
  handleRef,
  resetKey,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  handleRef: RefObject<TranscriptWindowHandle | null>;
  resetKey: string;
}): ReactNode {
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const { count, keys } = useMemo(
    () => deriveTranscriptSync(messages),
    [messages],
  );
  const getItemKey = useCallback(
    (index: number): string => keys[index] ?? String(index),
    [keys],
  );
  const renderItem = useCallback(
    (_index: number, id: string): ReactNode => (
      <ThreadPrimitive.Unstable_MessageById
        messageId={id}
        components={MESSAGE_COMPONENTS}
      />
    ),
    [],
  );
  return (
    <TranscriptWindow
      count={count}
      getItemKey={getItemKey}
      renderItem={renderItem}
      viewportRef={viewportRef}
      isRunning={isRunning}
      resetKey={resetKey}
      handleRef={handleRef}
    />
  );
}

interface HarnessHandle {
  deleteById: (id: string) => Promise<void>;
  runtimeMessageIds: () => readonly string[];
}

interface MountedHarness {
  harness: HarnessHandle;
  container: HTMLElement;
  handleRef: RefObject<TranscriptWindowHandle | null>;
  errors: Error[];
  cleanup: () => Promise<void>;
}

const mountedCleanups = new Set<() => Promise<void>>();

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function flushRuntimeLifecycle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function mountHarness(opts: {
  initial: Msg[];
  resetKey?: string;
}): Promise<MountedHarness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const errors: Error[] = [];
  const root: Root = createRoot(container, {
    onCaughtError: (error) => {
      errors.push(errorFrom(error));
    },
    onRecoverableError: (error) => {
      errors.push(errorFrom(error));
    },
    onUncaughtError: (error) => {
      errors.push(errorFrom(error));
    },
  });
  const viewportRef: RefObject<HTMLElement | null> = {
    current: container,
  };
  const handleRef: RefObject<TranscriptWindowHandle | null> = { current: null };
  const holder = { messages: opts.initial.slice() };
  let dispatch: ((updater: (prev: Msg[]) => Msg[]) => void) | null = null;
  let runtime: AssistantRuntime | null = null;

  function App(): ReactNode {
    const [messages, setMessages] = useState<Msg[]>(opts.initial);
    dispatch = setMessages;
    runtime = useExternalStoreRuntime<Msg>({
      messages,
      setMessages: () => {},
      onNew: async () => {},
      isRunning: false,
      convertMessage,
    });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <TranscriptLeaf
          viewportRef={viewportRef}
          handleRef={handleRef}
          resetKey={opts.resetKey ?? "room-d443"}
        />
      </AssistantRuntimeProvider>
    );
  }

  await act(async () => {
    root.render(createElement(App));
    await flushRuntimeLifecycle();
  });
  holder.messages = opts.initial.slice();

  const harness: HarnessHandle = {
    deleteById: async (id: string): Promise<void> => {
      const targetId = String(id);
      const next = holder.messages.filter((m) => String(m.id) !== targetId);
      holder.messages = next;
      await act(async () => {
        dispatch!(() => next.slice());
        await flushRuntimeLifecycle();
      });
    },
    runtimeMessageIds: (): readonly string[] =>
      runtime?.thread.getState().messages.map((message) => String(message.id)) ?? [],
  };

  const cleanup = async (): Promise<void> => {
    mountedCleanups.delete(cleanup);
    await act(async () => {
      root.unmount();
      await flushRuntimeLifecycle();
    });
    container.remove();
  };
  mountedCleanups.add(cleanup);

  return {
    harness,
    container,
    handleRef,
    errors,
    cleanup,
  };
}

function rowIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-message-id]"),
  ).map((el) => el.getAttribute("data-message-id") ?? "");
}

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll("[data-message-row='true']").length;
}

function messageMountId(container: HTMLElement, id: string): string | null {
  return container
    .querySelector(`[data-message-id="${id}"]`)
    ?.getAttribute("data-message-mount-id") ?? null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const cleanup of [...mountedCleanups]) await cleanup();
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function commitScrolledBackAnchor(
  handleRef: RefObject<TranscriptWindowHandle | null>,
  container: HTMLElement,
  id: string,
): Promise<void> {
  let found = false;
  await act(async () => {
    found = handleRef.current?.materializeById(id) ?? false;
    await flushRuntimeLifecycle();
  });
  expect(found).toBe(true);
  expect(container.querySelector(`[data-message-id="${id}"]`)).not.toBeNull();
}

async function captureLifecycleErrors(
  rootErrors: Error[],
  action: () => Promise<void>,
): Promise<Error[]> {
  const captured = rootErrors;
  const originalConsoleError = console.error;
  const onWindowError = (event: ErrorEvent): void => {
    captured.push(errorFrom(event.error ?? event.message));
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    captured.push(errorFrom(event.reason));
  };
  console.error = (...args: unknown[]): void => {
    captured.push(errorFrom(args[0]));
    originalConsoleError(...args);
  };
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  try {
    await action();
    await act(async () => {
      await flushRuntimeLifecycle();
    });
  } finally {
    console.error = originalConsoleError;
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }
  return captured;
}

describe("ISSUE-D443 — real runtime middle-delete lifecycle", () => {
  test("mounts 34 real id-stable rows and commits a scrolled-back id anchor", async () => {
    const initial = makeMessages(34);
    const { container, handleRef, errors, cleanup } = await mountHarness({
      initial,
    });
    try {
      expect(rowCount(container)).toBe(34);
      expect(rowIds(container)).toContain("m33");
      await commitScrolledBackAnchor(handleRef, container, "m4");
      expect(errors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("survives the live 34→33 short-list middle deletion with stable tail identity", async () => {
    const initial = makeMessages(34);
    const { harness, container, handleRef, errors, cleanup } = await mountHarness({
      initial,
    });
    try {
      expect(rowCount(container)).toBe(34);
      await commitScrolledBackAnchor(handleRef, container, "m4");
      const tailMountId = messageMountId(container, "m33");
      expect(tailMountId).not.toBeNull();

      const lifecycleErrors = await captureLifecycleErrors(errors, async () => {
        // m6 is a visible, older user-authored middle row, matching live repro.
        await harness.deleteById("m6");
      });

      const runtimeIds = harness.runtimeMessageIds();
      expect(runtimeIds).toHaveLength(33);
      expect(runtimeIds).not.toContain("m6");
      expect(runtimeIds[32]).toBe("m33");
      expect(rowCount(container)).toBe(33);
      expect(rowIds(container)).not.toContain("m6");
      expect(rowIds(container)[32]).toBe("m33");
      expect(messageMountId(container, "m33")).toBe(tailMountId);
      expect(lifecycleErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("keeps a >60 id-stable window bounded through anchored contraction", async () => {
    const initial = makeMessages(80);
    const { harness, container, handleRef, errors, cleanup } = await mountHarness({
      initial,
    });
    try {
      expect(rowCount(container)).toBeLessThanOrEqual(60);
      expect(container.querySelector('[data-message-id="m10"]')).toBeNull();
      await commitScrolledBackAnchor(handleRef, container, "m20");
      expect(container.querySelector('[data-message-id="m20"]')).not.toBeNull();

      const lifecycleErrors = await captureLifecycleErrors(errors, async () => {
        await harness.deleteById("m20");
      });
      expect(harness.runtimeMessageIds()).toHaveLength(79);
      expect(harness.runtimeMessageIds()).not.toContain("m20");
      expect(rowCount(container)).toBeLessThanOrEqual(60);
      expect(rowIds(container)).not.toContain("m20");
      expect(rowIds(container)).toContain("m79");
      expect(lifecycleErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
