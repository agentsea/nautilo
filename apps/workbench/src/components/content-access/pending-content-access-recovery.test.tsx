import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  BrowserContentAccessPendingOperations,
  type PendingContentAccessOperation,
} from "../../lib/content-access-pending-operations";
import { PendingContentAccessRecoveryNotice } from "./pending-content-access-recovery";

const scope = {
  serverOrigin: "https://alpha.example",
  userId: "user-1",
  roomId: "11111111-1111-4111-8111-111111111111",
};
const operation: PendingContentAccessOperation = {
  command: {
    operationId: "22222222-2222-4222-8222-222222222222",
    object: { kind: "artifact", id: "33333333-3333-4333-8333-333333333333" },
    change: { kind: "make_private" },
  },
  previewToken: "signed-token",
};
const secondOperation: PendingContentAccessOperation = {
  command: {
    operationId: "55555555-5555-4555-8555-555555555555",
    object: { kind: "memory", id: "66666666-6666-4666-8666-666666666666" },
    change: { kind: "remove_person", actorId: "77777777-7777-4777-8777-777777777777" },
  },
  previewToken: "second-signed-token",
};

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class ImmediateLocks {
  request<T>(_name: string, _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object) => Promise<T>): Promise<T> {
    return callback({});
  }
}

async function retainedStore() {
  const store = new BrowserContentAccessPendingOperations(scope, new MemoryStorage(), new ImmediateLocks());
  await store.execute(operation, async () => { throw new Error("response lost"); }, () => false)
    .catch(() => undefined);
  return store;
}

describe("PendingContentAccessRecoveryNotice", () => {
  beforeEach(() => {
    cleanup();
    reapplyHappyDomGlobals();
  });

  test("discovers without auto-retrying and reveals no object, token, or command details", async () => {
    const store = await retainedStore();
    const commitContentAccess = mock(async () => ({ outcome: "applied" }));
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess }} />);

    expect(await view.findByText(/previous access change needs verification/)).toBeTruthy();
    expect(commitContentAccess).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain(operation.command.object.id);
    expect(view.container.textContent).not.toContain(operation.previewToken);
    expect(view.container.textContent).not.toContain("make_private");
  });

  test("retries only the exact saved command and token, then hides on a receipt", async () => {
    const store = await retainedStore();
    const commitContentAccess = mock(async () => ({ outcome: "already_applied" }));
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess }} />);
    fireEvent.click(await view.findByRole("button", { name: "Retry previous change" }));

    await waitFor(() => expect(commitContentAccess).toHaveBeenCalledWith(
      operation.command,
      operation.previewToken,
      expect.objectContaining({ roomId: scope.roomId, signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => expect(view.queryByTestId("pending-content-access-recovery")).toBeNull());
    expect(store.list()).toEqual([]);
  });

  test("retains an unknown result for another explicit retry", async () => {
    const store = await retainedStore();
    const commitContentAccess = mock(async () => { throw new Error("Connection lost"); });
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess }} />);
    fireEvent.click(await view.findByRole("button", { name: "Retry previous change" }));

    expect(await view.findByText("Connection lost")).toBeTruthy();
    expect(store.list()).toEqual([operation]);
    expect(view.getByRole("button", { name: "Retry previous change" })).toBeTruthy();
  });

  test("reports a settled partial receipt after removing its durable retry", async () => {
    const store = await retainedStore();
    const commitContentAccess = mock(async () => ({
      operationId: operation.command.operationId,
      outcome: "partial",
      stateChanged: true,
      originalStateChanged: true,
      replayed: false,
      attachedCount: 2,
      detachedCount: 1,
      skippedCount: 4,
    }));
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess }} />);
    fireEvent.click(await view.findByRole("button", { name: "Retry previous change" }));

    expect(await view.findByText(/previous access change finished partially/i)).toBeTruthy();
    expect(view.getByText(/original item was updated\. 3 related access links were changed\. The receipt reports 4 skipped related items; some access remains/i)).toBeTruthy();
    expect(store.list()).toEqual([]);
    expect(view.container.textContent).not.toContain(operation.command.object.id);
  });

  test("an unknown first operation does not starve a second independent retry", async () => {
    const store = await retainedStore();
    await store.execute(secondOperation, async () => { throw new Error("response lost"); }, () => false)
      .catch(() => undefined);
    const commitContentAccess = mock(async (command: PendingContentAccessOperation["command"]) => {
      if (command.operationId === operation.command.operationId) throw new Error("Still unknown");
      return { operationId: command.operationId, outcome: "applied" };
    });
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess }} />);

    fireEvent.click(await view.findByRole("button", { name: "Retry previous change 1" }));
    expect(await view.findByText("Still unknown")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry previous change 2" }));

    await waitFor(() => expect(commitContentAccess).toHaveBeenCalledWith(
      secondOperation.command,
      secondOperation.previewToken,
      expect.objectContaining({ roomId: scope.roomId, signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => expect(store.list()).toEqual([operation]));
    expect(view.getByRole("button", { name: "Retry previous change" })).toBeTruthy();
  });

  test("clears only an explicit safe prepare-again result", async () => {
    const store = await retainedStore();
    const stale = Object.assign(new Error("Prepare again"), { recovery: "prepare_again" });
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess: async () => { throw stale; } }} />);
    fireEvent.click(await view.findByRole("button", { name: "Retry previous change" }));

    await waitFor(() => expect(view.queryByTestId("pending-content-access-recovery")).toBeNull());
    expect(store.list()).toEqual([]);
  });

  test("same-tab persistence makes a vanished object's recovery reachable", async () => {
    const store = new BrowserContentAccessPendingOperations(scope, new MemoryStorage(), new ImmediateLocks());
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess: async () => ({ outcome: "applied" }) }} />);
    expect(view.queryByTestId("pending-content-access-recovery")).toBeNull();

    await act(async () => {
      await store.execute(operation, async () => { throw new Error("unknown"); }, () => false)
        .catch(() => undefined);
    });
    expect(await view.findByRole("button", { name: "Retry previous change" })).toBeTruthy();
  });

  test("a normal same-tab Apply is presented as active, not as an uncertain recovery", async () => {
    const store = new BrowserContentAccessPendingOperations(scope, new MemoryStorage(), new ImmediateLocks());
    let reject!: (error: unknown) => void;
    const dispatch = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={{ commitContentAccess: async () => ({ outcome: "applied" }) }} />);

    let applying!: Promise<void>;
    act(() => {
      applying = store.execute(operation, () => dispatch, () => false).catch(() => undefined);
    });
    expect(await view.findByText("An access change is being applied.")).toBeTruthy();
    expect(view.queryByText(/previous access change needs verification/)).toBeNull();
    expect(view.queryByRole("button", { name: "Retry previous change" })).toBeNull();

    await act(async () => {
      reject(new Error("response lost"));
      await applying;
    });
    expect(await view.findByRole("button", { name: "Retry previous change" })).toBeTruthy();
  });

  test("auth-generation drift aborts only the HTTP wait and retains durable recovery", async () => {
    const store = await retainedStore();
    let signal: AbortSignal | undefined;
    const never = new Promise<unknown>(() => {});
    const client = { commitContentAccess: mock(async (
      _command: PendingContentAccessOperation["command"],
      _token: string,
      options: { signal?: AbortSignal },
    ) => {
      signal = options.signal;
      return never;
    }) };
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={client} />);
    fireEvent.click(await view.findByRole("button", { name: "Retry previous change" }));
    await waitFor(() => expect(signal).toBeDefined());

    view.rerender(<PendingContentAccessRecoveryNotice {...scope} authGeneration={2}
      pendingStore={store} client={client} />);
    expect(signal?.aborted).toBe(true);
    expect(store.list()).toEqual([operation]);
  });

  test("never renders an old Room snapshot after a scope change", async () => {
    const store = await retainedStore();
    const otherScope = {
      ...scope,
      roomId: "44444444-4444-4444-8444-444444444444",
    };
    const otherStore = new BrowserContentAccessPendingOperations(
      otherScope,
      new MemoryStorage(),
      new ImmediateLocks(),
    );
    const client = { commitContentAccess: async () => ({ outcome: "applied" }) };
    const view = render(<PendingContentAccessRecoveryNotice {...scope} authGeneration={1}
      pendingStore={store} client={client} />);
    expect(await view.findByRole("button", { name: "Retry previous change" })).toBeTruthy();

    view.rerender(<PendingContentAccessRecoveryNotice {...otherScope} authGeneration={1}
      pendingStore={otherStore} client={client} />);
    expect(view.queryByTestId("pending-content-access-recovery")).toBeNull();
  });
});
