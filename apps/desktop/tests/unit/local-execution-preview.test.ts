import { describe, expect, test } from "bun:test";
import { openLocalExecutionPreview, readFromCurrentLocalExecutionOwner, type LocalExecutionPreviewPorts } from "../../electron/local-execution-preview";
import type { LocalExecutionView, LocalExecutionViewRequest } from "../../electron/relay-dispatch/local-execution";

const reference = { generation: "generation-a", executionId: "execution-a", cursor: 0, maxBytes: 4 };
const request = { ...reference, url: "http://127.0.0.1:4123/preview" };
const running: LocalExecutionView = {
  ...reference, session_id: reference.executionId, state: "running", tty: false, pid: 42,
  exitCode: null, signal: null, terminationScope: "owned_process_group", failureCode: null,
  expiresAt: null, resources: "owned", output: { data: "", cursor: 0, nextCursor: 0,
    availableFrom: 0, produced: 0, gap: false, hasMore: false },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const oldRenderer = { destroyed: false, sent: [] as string[] };
  const oldSession = {};
  let renderer: typeof oldRenderer | null = oldRenderer;
  let session = oldSession;
  let generation: string | null = reference.generation;
  const receipt = deferred<LocalExecutionView>();
  const reads: LocalExecutionViewRequest[] = [];
  const ports: LocalExecutionPreviewPorts<{ renderer: typeof oldRenderer; session: object }> = {
    capture: () => {
      if (!renderer || renderer.destroyed || renderer !== oldRenderer || session !== oldSession) throw new Error("inactive sender");
      return { renderer, session };
    },
    read: (input) => { reads.push(input); return receipt.promise; },
    isCurrent: (captured, requestedGeneration) => captured.session === session && captured.renderer === renderer &&
      !captured.renderer.destroyed && generation === requestedGeneration,
    send: (captured, url) => { captured.renderer.sent.push(url); },
  };
  return { ports, receipt, reads, oldRenderer,
    switchSession: () => { session = {}; },
    replaceRenderer: () => { renderer = { destroyed: false, sent: [] }; return renderer; },
    removeRenderer: () => { renderer = null; },
    changeGeneration: (value: string | null) => { generation = value; },
  };
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; return null; } catch (error) { return error; }
}

describe("local execution preview delivery", () => {
  test.each(["http://127.0.0.1:4123/preview", "http://localhost:4123/preview", "http://[::1]:4123/preview"])(
    "delivers %s to the original live renderer after its running receipt", async (url) => {
      const f = fixture();
      const open = openLocalExecutionPreview({ ...request, url }, f.ports);
      expect(f.oldRenderer.sent).toEqual([]);
      expect(f.reads).toEqual([reference]);
      f.receipt.resolve(running);
      await open;
      expect(f.oldRenderer.sent).toEqual([url]);
    },
  );

  test.each(["session switch", "renderer replacement", "renderer destruction", "renderer disappearance", "execution owner replacement", "execution owner retirement"])(
    "%s during the receipt read prevents every delivery", async (change) => {
      const f = fixture();
      const result = rejected(openLocalExecutionPreview(request, f.ports));
      let replacement: ReturnType<typeof f.replaceRenderer> | undefined;
      if (change === "session switch") f.switchSession();
      if (change === "renderer replacement") replacement = f.replaceRenderer();
      if (change === "renderer destruction") f.oldRenderer.destroyed = true;
      if (change === "renderer disappearance") f.removeRenderer();
      if (change === "execution owner replacement") f.changeGeneration("generation-b");
      if (change === "execution owner retirement") f.changeGeneration(null);
      f.receipt.resolve(running);
      expect(await result).toBeInstanceOf(Error);
      expect(f.oldRenderer.sent).toEqual([]);
      expect(replacement?.sent ?? []).toEqual([]);
    },
  );

  test.each(["https://localhost:4123", "http://example.test:4123", "http://localhost.example.test:4123", "http://fixture@example.invalid:4123", "http://user:password@localhost:4123", "file:///tmp/preview", "not a URL"])(
    "rejects %s before any execution read", async (url) => {
      const f = fixture();
      expect(await rejected(openLocalExecutionPreview({ ...request, url }, f.ports))).toBeInstanceOf(Error);
      expect(f.reads).toEqual([]);
      expect(f.oldRenderer.sent).toEqual([]);
    },
  );

  test.each(["starting", "cancelling", "completed", "cancelled", "failed", "unknown"] as const)(
    "rejects a %s receipt without navigating", async (state) => {
      const f = fixture();
      f.receipt.resolve({ ...running, state });
      expect(await rejected(openLocalExecutionPreview(request, f.ports))).toBeInstanceOf(Error);
      expect(f.oldRenderer.sent).toEqual([]);
    },
  );

  test("rejects a real exit while resource cleanup still labels the receipt running", async () => {
    for (const exit of [{ exitCode: 0, signal: null }, { exitCode: null, signal: "SIGTERM" }]) {
      const f = fixture();
      f.receipt.resolve({ ...running, ...exit });
      expect(await rejected(openLocalExecutionPreview(request, f.ports))).toBeInstanceOf(Error);
      expect(f.oldRenderer.sent).toEqual([]);
    }
  });

  test("inactive sender fails before parsing or reading", async () => {
    const f = fixture(); f.switchSession();
    expect(await rejected(openLocalExecutionPreview(request, f.ports))).toBeInstanceOf(Error);
    expect(f.reads).toEqual([]);
  });
});

describe("Human execution reads retain their active Relay owner", () => {
  test.each([false, true])("read/cancel=%s passes the exact request and returns only while its owner remains current", async (cancel) => {
    const calls: unknown[] = [];
    const owner = { closed: false, localExecution: { humanRead: async (...args: unknown[]) => { calls.push(args); return running; } } };
    expect(await readFromCurrentLocalExecutionOwner(() => owner, reference, cancel)).toBe(running);
    expect(calls).toEqual([[reference, cancel]]);
  });

  test.each(["replace", "retire", "detach"])("rejects an owner %s during the read", async (change) => {
    const receipt = deferred<LocalExecutionView>();
    const owner = { closed: false, localExecution: { humanRead: () => receipt.promise } };
    let active: typeof owner | null = owner;
    const result = rejected(readFromCurrentLocalExecutionOwner(() => active, reference));
    if (change === "replace") active = { ...owner };
    if (change === "retire") owner.closed = true;
    if (change === "detach") active = null;
    receipt.resolve(running);
    expect(await result).toBeInstanceOf(Error);
  });
});
