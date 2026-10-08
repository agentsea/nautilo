import { describe, expect, mock, test } from "bun:test";
import type { DesktopLocalExecutionAPI, LocalExecutionSnapshot } from "../../src/lib/desktop";
import { clearLocalExecutionHistoryOverlays, observeLocalExecution, parseLocalExecutionSnapshot,
  publishLocalExecutionHistoryOverlay, type LocalExecutionObservation } from "../../src/lib/local-execution-observation";

function snapshot(overrides: Partial<LocalExecutionSnapshot> = {}): LocalExecutionSnapshot {
  return { generation: "generation-fixture", executionId: "execution-fixture", session_id: "execution-fixture",
    state: "running", tty: false, pid: 123, exitCode: null, signal: null, terminationScope: "owned_process_group",
    output: { data: "", cursor: 0, nextCursor: 0, availableFrom: 0, produced: 0, gap: false, hasMore: false },
    failureCode: null, resources: "owned", expiresAt: null, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }
function fixture() {
  let listener: ((event: { generation: string | null }) => void) | undefined;
  let current = snapshot();
  const unsubscribe = mock(() => { listener = undefined; });
  const api: DesktopLocalExecutionAPI = {
    read: mock(async () => current), cancel: mock(async () => current), openPreview: mock(async () => {}),
    onChanged: mock((callback: (event: { generation: string | null }) => void) => { listener = callback; return unsubscribe; }),
  };
  const values: LocalExecutionObservation[] = [];
  const watch = () => observeLocalExecution(api, snapshot(), (value) => values.push(value));
  return { api, values, watch, unsubscribe, change: (generation: string | null = "generation-fixture") => listener?.({ generation }),
    set: (value: LocalExecutionSnapshot) => { current = value; } };
}

describe("shared managed execution observation", () => {
  test("browser search receipts share terminal truth without inventing output or moving its cursor", () => {
    const values: LocalExecutionObservation[] = [];
    const initial = snapshot({ output: { data: "original", cursor: 0, nextCursor: 8, availableFrom: 0, produced: 8, gap: false, hasMore: false } });
    const first = observeLocalExecution(undefined, initial, value => values.push(value));
    first.publish(initial);
    const completed = snapshot({ state: "completed", exitCode: 7, resources: "released",
      output: { data: "match", cursor: 10, nextCursor: 15, availableFrom: 0, produced: 15, gap: false, hasMore: false },
      search: { matchedAt: 10, nextSearchCursor: 11, complete: false, gap: false, availableFrom: 0, produced: 15 } });
    first.publish(completed);
    expect(values.at(-1)?.snapshot).toEqual({ ...initial, state: "completed", exitCode: 7, resources: "released",
      output: { ...initial.output, produced: 15, hasMore: true } });
    first.unsubscribe();
    const empty = observeLocalExecution(undefined, completed, value => values.push(value));
    empty.publish(completed);
    expect(values.at(-1)?.snapshot).toBeNull();
    empty.unsubscribe();
  });

  test("browser terminal search trims an evicted Unicode prefix and discloses unread tail bytes", () => {
    const values: LocalExecutionObservation[] = [];
    const initial = snapshot({ output: { data: "α\ufeffβ", cursor: 0, nextCursor: 7, availableFrom: 0, produced: 7, gap: false, hasMore: false } });
    const watcher = observeLocalExecution(undefined, initial, value => values.push(value));
    watcher.publish(initial);
    watcher.publish(snapshot({ state: "completed", exitCode: 0, resources: "released",
      output: { data: "tail", cursor: 10, nextCursor: 14, availableFrom: 2, produced: 14, gap: false, hasMore: false },
      search: { matchedAt: 10, nextSearchCursor: 11, complete: false, gap: true, availableFrom: 2, produced: 14 } }));
    expect(values.at(-1)?.snapshot?.output).toEqual({ data: "\ufeffβ", cursor: 2, nextCursor: 7,
      availableFrom: 2, produced: 14, gap: true, hasMore: true });
    expect(values.at(-1)?.snapshot?.search).toBeUndefined();
    watcher.unsubscribe();
  });
  test("search metadata is closed and cannot claim a running miss is complete", () => {
    const hit = snapshot({ output: { data: "tail", cursor: 10, nextCursor: 14, availableFrom: 0, produced: 20, gap: false, hasMore: true },
      search: { matchedAt: 10, nextSearchCursor: 11, complete: false, gap: false, availableFrom: 0, produced: 20 } });
    expect(parseLocalExecutionSnapshot(JSON.stringify(hit))).toEqual(hit);
    for (const search of [{ ...hit.search, complete: true }, { ...hit.search, nextSearchCursor: 10 },
      { ...hit.search, produced: 21 }, { ...hit.search, extra: "opaque" }, { ...hit.search, gap: [false] }]) {
      expect(parseLocalExecutionSnapshot(JSON.stringify({ ...hit, search }))).toBeNull();
    }
    const miss = snapshot({ search: { matchedAt: null, nextSearchCursor: 0, complete: true, gap: false, availableFrom: 0, produced: 0 } });
    expect(parseLocalExecutionSnapshot(JSON.stringify(miss))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...miss, state: "completed", exitCode: 0, resources: "released" }))).not.toBeNull();
  });

  test("a search match page cannot overwrite the shared window or its paging cursor", async () => {
    const f = fixture();
    const full = snapshot({ output: { data: "before match after", cursor: 0, nextCursor: 18, availableFrom: 0, produced: 18, gap: false, hasMore: false } });
    f.set(full);
    const watcher = f.watch(); watcher.publish(full);
    const match = snapshot({ output: { data: "match", cursor: 7, nextCursor: 12, availableFrom: 0, produced: 18, gap: false, hasMore: true },
      search: { matchedAt: 7, nextSearchCursor: 8, complete: false, gap: false, availableFrom: 0, produced: 18 } });
    watcher.publish(match);
    expect(f.values.at(-1)?.snapshot).toEqual(full);
    await flush();
    expect(f.api.read).toHaveBeenLastCalledWith({ generation: full.generation, executionId: full.executionId, cursor: 0, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(f.values.at(-1)?.snapshot).toEqual(full);
    expect(f.values.some(value => value.snapshot?.search)).toBe(false);
    watcher.unsubscribe();
  });
  test("accepts only settled, non-expiring archived snapshots", () => {
    const archived = snapshot({ state: "completed", exitCode: 0, pid: null, resources: "released", archived: true });
    expect(parseLocalExecutionSnapshot(JSON.stringify(archived))).toEqual(archived);
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, archived: false }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, expiresAt: 123 }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, state: "running" }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, resources: "release_failed" }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, output: { ...archived.output, hasMore: true } }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, output: { ...archived.output, produced: archived.output.produced + 1 } }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...archived, state: "unknown", resources: "release_failed" }))).not.toBeNull();
  });

  test("accepts historical ToolMessage pages without treating them as archive overlays", () => {
    const data = "saved π output\n";
    const cursor = 12;
    const nextCursor = cursor + new TextEncoder().encode(data).byteLength;
    const historical = snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released", historical: true,
      output: { data, cursor, nextCursor, availableFrom: 0, produced: nextCursor + 9, gap: false, hasMore: true } });
    expect(parseLocalExecutionSnapshot(JSON.stringify(historical))).toEqual(historical);
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...historical, historical: false }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...historical, state: "running", resources: "owned" }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...historical, resources: "release_failed" }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...historical, expiresAt: 1 }))).toBeNull();
    expect(parseLocalExecutionSnapshot(JSON.stringify({ ...historical, archived: true }))).toBeNull();
  });

  test("a historical ToolMessage receipt cannot publish into live observation state", async () => {
    const f = fixture();
    const watcher = f.watch();
    const historical = snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released", historical: true });
    watcher.publish(historical);
    expect(f.values.some((value) => value.snapshot?.historical === true)).toBe(false);
    expect(f.api.read).not.toHaveBeenCalled();
    watcher.unsubscribe();
    await flush();
  });

  test("authenticated archived output upgrades a partial final seed without changing its exit truth", () => {
    const f = fixture();
    const fullOutput = "0123456789".repeat(4);
    const partialData = fullOutput.slice(0, 5);
    const partial = snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released",
      output: { data: partialData, cursor: 0, nextCursor: 5, availableFrom: 0, produced: 40, gap: false, hasMore: true } });
    const watcher = f.watch();
    watcher.publish(partial);
    const fullBytes = new TextEncoder().encode(fullOutput).byteLength;
    const archived = snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released", archived: true,
      output: { data: fullOutput, cursor: 0, nextCursor: fullBytes, availableFrom: 0, produced: fullBytes, gap: false, hasMore: false } });
    publishLocalExecutionHistoryOverlay(f.api, { generation: archived.generation, executionId: archived.executionId, snapshot: archived });
    expect(f.values.at(-1)).toEqual({ snapshot: archived, unconfirmed: false, replaceOutput: true });
    expect(f.api.read).not.toHaveBeenCalled();
    const shorter = { ...archived, output: { data: "tiny", cursor: 0, nextCursor: 4, availableFrom: 0, produced: 4, gap: false, hasMore: false } };
    publishLocalExecutionHistoryOverlay(f.api, { generation: archived.generation, executionId: archived.executionId, snapshot: shorter });
    expect(f.values.at(-1)?.snapshot).toEqual(archived);
    const conflicting = { ...archived, exitCode: 0 };
    publishLocalExecutionHistoryOverlay(f.api, { generation: archived.generation, executionId: archived.executionId, snapshot: conflicting });
    expect(f.values.at(-1)?.snapshot).toEqual(archived);
    watcher.publish(snapshot({ state: "completed", exitCode: 0, pid: null, resources: "released" }));
    expect(f.values.at(-1)).toEqual({ snapshot: archived, unconfirmed: true, replaceOutput: false });
    watcher.unsubscribe();
    clearLocalExecutionHistoryOverlays(f.api);
  });

  test("archives wait for their exact reference and are cleared on owner-session invalidation", () => {
    const f = fixture();
    const archived = snapshot({ state: "unknown", pid: null, resources: "release_failed", archived: true });
    publishLocalExecutionHistoryOverlay(f.api, { generation: archived.generation, executionId: archived.executionId, snapshot: archived });
    const watcher = f.watch();
    expect(f.values.at(-1)?.snapshot).toEqual(archived);
    expect(f.api.read).not.toHaveBeenCalled();
    f.change(null);
    expect(f.values.at(-1)).toEqual({ snapshot: null, unconfirmed: true, replaceOutput: true });
    clearLocalExecutionHistoryOverlays(f.api);
    watcher.unsubscribe();
  });

  test("archive overlays survive unrelated output changes in a newer host generation", () => {
    const f = fixture();
    const archived = snapshot({ state: "completed", exitCode: 0, pid: null, resources: "released", archived: true });
    publishLocalExecutionHistoryOverlay(f.api, { generation: archived.generation, executionId: archived.executionId, snapshot: archived });
    const watcher = f.watch();
    f.change("new-host-generation");
    expect(f.values.at(-1)?.snapshot).toEqual(archived);
    expect(f.api.read).not.toHaveBeenCalled();
    clearLocalExecutionHistoryOverlays(f.api);
    watcher.unsubscribe();
  });

  test("coalesces invalidations and follows a trailing settlement without polling or mutations", async () => {
    const f = fixture();
    const pending = deferred<LocalExecutionSnapshot>();
    f.api.read = mock(() => pending.promise);
    const first = f.watch();
    const second = f.watch();
    first.publish(snapshot());
    await flush();
    expect(f.api.read).toHaveBeenCalledTimes(1);
    f.change(); f.change(); f.change();
    const completed = snapshot({ state: "completed", exitCode: 0, resources: "released" });
    f.api.read = mock(async () => completed);
    pending.resolve(snapshot({ state: "cancelling" }));
    await flush();
    expect(f.api.read).toHaveBeenCalledTimes(1);
    expect(f.values.at(-1)?.snapshot).toEqual(completed);
    f.change(); await flush();
    expect(f.api.read).toHaveBeenCalledTimes(1);
    expect(f.api.cancel).not.toHaveBeenCalled();
    first.unsubscribe(); expect(f.unsubscribe).not.toHaveBeenCalled();
    second.unsubscribe(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("shares a follow-up receipt and cannot regress final truth with an older card", () => {
    const f = fixture();
    const first = f.watch(); first.publish(snapshot());
    const second = f.watch();
    const completed = snapshot({ state: "completed", exitCode: 7, resources: "released" });
    second.publish(completed);
    first.publish(snapshot()); first.publish(snapshot({ state: "unknown" }));
    expect(f.values.at(-1)?.snapshot).toEqual(completed);
    first.unsubscribe(); second.unsubscribe();
  });

  test("generation retirement ignores late reads and cannot route another generation", async () => {
    const f = fixture();
    const pending = deferred<LocalExecutionSnapshot>();
    f.api.read = mock(() => pending.promise);
    const watcher = f.watch(); watcher.publish(snapshot());
    await flush();
    f.change("new-generation");
    pending.resolve(snapshot({ state: "completed", exitCode: 0, resources: "released" }));
    await flush();
    expect(f.values.at(-1)?.unconfirmed).toBe(true);
    expect(f.values.at(-1)?.snapshot?.state).toBe("running");
    f.change("generation-fixture"); await flush();
    expect(f.api.read).toHaveBeenCalledTimes(1);
    watcher.unsubscribe();
  });

  test("reports read failure honestly and retries only on an explicit refresh or new invalidation", async () => {
    const f = fixture();
    f.api.read = mock(async () => { throw new Error("Unavailable"); });
    const watcher = f.watch(); watcher.publish(snapshot());
    await flush(); await flush();
    expect(f.values.at(-1)?.unconfirmed).toBe(true);
    expect(f.api.read).toHaveBeenCalledTimes(1);
    const duplicate = f.watch();
    duplicate.publish(snapshot());
    expect(f.values.at(-1)?.unconfirmed).toBe(true);
    f.api.read = mock(async () => snapshot());
    f.change(); await flush();
    expect(f.values.at(-1)?.unconfirmed).toBe(false);
    expect(f.values.at(-1)?.snapshot?.state).toBe("running");
    watcher.unsubscribe(); duplicate.unsubscribe();
  });

  test("native invalidations fetch the bounded host window and retain its provenance for new cards", async () => {
    const f = fixture();
    const watcher = f.watch(); watcher.publish(snapshot());
    await flush();
    const window = snapshot({ output: { data: "tail", cursor: 100, nextCursor: 104,
      availableFrom: 100, produced: 104, gap: true, hasMore: false } });
    f.set(window); f.change(); await flush();
    expect(f.api.read).toHaveBeenLastCalledWith({ generation: window.generation, executionId: window.executionId, cursor: 0, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(f.values.at(-1)).toEqual({ snapshot: window, unconfirmed: false, replaceOutput: true });
    const duplicate = f.watch(); duplicate.publish(snapshot());
    expect(f.values.at(-1)).toEqual({ snapshot: window, unconfirmed: false, replaceOutput: true });
    watcher.unsubscribe(); duplicate.unsubscribe();
  });

  test("last unsubscribe drops pending delivery and releases the native listener", async () => {
    const f = fixture();
    const pending = deferred<LocalExecutionSnapshot>();
    f.api.read = mock(() => pending.promise);
    const watcher = f.watch(); watcher.publish(snapshot());
    await flush();
    watcher.unsubscribe();
    const count = f.values.length;
    pending.resolve(snapshot({ state: "completed", exitCode: 0, resources: "released" }));
    await flush();
    expect(f.values.length).toBe(count);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

test("native read can recover a settled archive but ordinary published results cannot", async () => {
  const f = fixture();
  const archived = snapshot({ archived: true, state: "completed", exitCode: 0, resources: "released" });
  const watcher = f.watch();
  watcher.publish(archived);
  expect(f.values.at(-1)?.snapshot).toBeNull();
  f.set(archived);
  await flush();
  expect(f.values.at(-1)).toMatchObject({ snapshot: archived, unconfirmed: false, replaceOutput: true });
  clearLocalExecutionHistoryOverlays(f.api);
  expect(f.values.at(-1)?.snapshot).toBeNull();
  watcher.unsubscribe();
});
test("native archived read cannot replace another execution or contradict a known terminal outcome", async () => {
  const f = fixture();
  f.set(snapshot({ archived: true, state: "completed", exitCode: 0, resources: "released", generation: "foreign" }));
  const watcher = f.watch();
  await flush();
  expect(f.values.at(-1)?.snapshot).toBeNull();
  expect(f.values.at(-1)?.unconfirmed).toBe(true);
  const completed = snapshot({ state: "completed", exitCode: 0, resources: "released" });
  watcher.publish(completed);
  watcher.publish({ ...completed, archived: true, exitCode: 7 }, true);
  expect(f.values.at(-1)?.snapshot?.exitCode).toBe(0);
  expect(f.values.at(-1)?.snapshot?.archived).not.toBe(true);
  watcher.unsubscribe();
});
