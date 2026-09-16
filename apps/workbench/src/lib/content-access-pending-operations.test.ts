import { describe, expect, mock, test } from "bun:test";

import {
  BrowserContentAccessPendingOperations,
  ContentAccessPendingOperationError,
  type ContentAccessPendingScope,
  type PendingContentAccessOperation,
} from "./content-access-pending-operations";

const scope: ContentAccessPendingScope = {
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

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  failSet = false;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    if (this.failSet) throw new DOMException("quota", "QuotaExceededError");
    this.values.set(key, value);
  }
}

class ImmediateLocks {
  available = true;
  request<T>(
    _name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T> {
    return callback(this.available ? {} : null);
  }
}

function store(storage = new MemoryStorage(), locks = new ImmediateLocks()) {
  return { storage, locks, pending: new BrowserContentAccessPendingOperations(scope, storage, locks) };
}

describe("BrowserContentAccessPendingOperations", () => {
  test("durably writes and verifies the exact command and token before dispatch", async () => {
    const fixture = store();
    const dispatch = mock(async () => {
      expect(fixture.storage.length).toBe(1);
      expect(fixture.pending.list()).toEqual([operation]);
      throw new Error("response lost");
    });
    await expect(fixture.pending.execute(operation, dispatch, () => false)).rejects.toThrow("response lost");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.pending.restore([operation.command.object])).toEqual([operation]);
  });

  test("removes only a known terminal result or explicit prepare-again result", async () => {
    const fixture = store();
    await expect(fixture.pending.execute(operation, async () => "receipt", () => false))
      .resolves.toBe("receipt");
    expect(fixture.pending.list()).toEqual([]);

    const prepareAgain = Object.assign(new Error("prepare again"), { recovery: "prepare_again" });
    await expect(fixture.pending.execute(operation, async () => { throw prepareAgain; },
      (error) => (error as { recovery?: unknown }).recovery === "prepare_again"))
      .rejects.toBe(prepareAgain);
    expect(fixture.pending.list()).toEqual([]);
  });

  test("quota failure and a held cross-tab lock prevent network dispatch", async () => {
    const quota = store();
    quota.storage.failSet = true;
    const quotaDispatch = mock(async () => "receipt");
    const quotaError = await quota.pending.execute(operation, quotaDispatch, () => false)
      .catch((error: unknown) => error);
    expect(quotaError).toBeInstanceOf(ContentAccessPendingOperationError);
    expect(quotaError).toMatchObject({ beforeDispatch: true });
    expect(quotaDispatch).not.toHaveBeenCalled();

    const locked = store();
    locked.locks.available = false;
    const lockedDispatch = mock(async () => "receipt");
    await expect(locked.pending.execute(operation, lockedDispatch, () => false))
      .rejects.toThrow("another window");
    expect(lockedDispatch).not.toHaveBeenCalled();
  });

  test("ignores other server, account, and Room scopes", async () => {
    const storage = new MemoryStorage();
    const locks = new ImmediateLocks();
    for (const otherScope of [
      { ...scope, serverOrigin: "https://beta.example" },
      { ...scope, userId: "user-2" },
      { ...scope, roomId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      const other = new BrowserContentAccessPendingOperations(otherScope, storage, locks);
      await other.execute(operation, async () => { throw new Error("unknown"); }, () => false)
        .catch(() => undefined);
    }
    const current = new BrowserContentAccessPendingOperations(scope, storage, locks);
    expect(current.list()).toEqual([]);
    expect(current.restore([operation.command.object])).toEqual([]);
  });

  test("fails closed for a malformed current-scope record", async () => {
    const fixture = store();
    await fixture.pending.execute(operation, async () => { throw new Error("unknown"); }, () => false)
      .catch(() => undefined);
    const key = fixture.storage.key(0)!;
    fixture.storage.setItem(key, JSON.stringify({ v: 1, previewToken: "forged" }));
    expect(() => fixture.pending.list()).toThrow("could not be verified");
    expect(() => fixture.pending.restore([operation.command.object])).toThrow("could not be verified");
  });

  test("does not overwrite a different exact operation for the same object", async () => {
    const fixture = store();
    await fixture.pending.execute(operation, async () => { throw new Error("unknown"); }, () => false)
      .catch(() => undefined);
    const different = {
      ...operation,
      command: {
        ...operation.command,
        operationId: "55555555-5555-4555-8555-555555555555",
      },
    };
    const dispatch = mock(async () => "receipt");
    await expect(fixture.pending.execute(different, dispatch, () => false))
      .rejects.toThrow("different access change");
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.pending.list()).toEqual([operation]);
  });
});
