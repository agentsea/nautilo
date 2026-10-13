import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { LocalExecutionHost, type LocalExecutionStart } from "../../electron/local-execution-host";
import { spawnLocalExecutionProcess, type LocalExecutionProcess, type LocalProcessExit, type PreparedLocalExecution } from "../../electron/local-execution-process";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(outputBytes = 1024) {
  let clock = 1000;
  let spawns = 0;
  let releases = 0;
  let kills = 0;
  let writes = 0;
  let output!: (stream: "stdout" | "stderr", bytes: Buffer) => void;
  const exit = deferred<LocalProcessExit>();
  const process: LocalExecutionProcess = {
    pid: 42, exited: exit.promise,
    write() { writes += 1; },
    terminate() { kills += 1; },
  };
  const prepared: PreparedLocalExecution = {
    program: "/bin/sh", args: ["-c", "printf hello"], cwd: "/tmp", env: {},
    dispose() { releases += 1; },
  };
  const host = new LocalExecutionHost({
    retention: { maxOutputBytes: outputBytes, maxTotalOutputBytes: outputBytes * 2,
      maxExecutions: 4, maxActiveExecutions: 3, completedTtlMs: 100, maxInputRequestsPerExecution: 4 },
    now: () => clock,
    spawn(_prepared, _tty, onOutput) { spawns += 1; output = onOutput; return process; },
  });
  const request: LocalExecutionStart = {
    executionId: "execution-a", requestIdentity: "request-a", requestFingerprint: "command-a",
    ownerKey: "owner-a", hostGeneration: host.hostGeneration, tty: false,
    prepare: async () => prepared,
  };
  const read = { executionId: request.executionId, ownerKey: request.ownerKey, cursor: 0, maxBytes: 1024 };
  return {
    host, request, read, prepared, process, exit,
    output: (text: string) => output("stdout", Buffer.from(text)),
    counts: () => ({ spawns, releases, kills, writes }),
    clock: (value: number) => { clock = value; },
  };
}

async function launched(f: ReturnType<typeof fixture>, override: Partial<LocalExecutionStart> = {}) {
  f.host.start({ ...f.request, ...override });
  await Promise.resolve();
}

async function finish(f: ReturnType<typeof fixture>, exitCode = 0) {
  f.exit.resolve({ exitCode, signal: null });
  return f.host.read({ ...f.read, cursor: f.host.list(f.request.ownerKey)[0]!.output.produced, yieldMs: 100 });
}

describe("managed local execution receipts", () => {
  test("search returns a bounded page at a match with the original process receipt", async () => {
    const f = fixture();
    await launched(f);
    f.output("prefix α😀β suffix\n");
    const result = f.host.search({ ...f.read, literal: "😀β", maxBytes: 4 });
    expect(result.search.matchedAt).toBe(Buffer.byteLength("prefix α"));
    expect(result.snapshot.output.data).toBe("😀");
    expect(result.snapshot.output.hasMore).toBe(true);
    expect(result.snapshot.state).toBe("running");
    expect(result.search.complete).toBe(false);
    expect(f.counts()).toEqual({ spawns: 1, releases: 0, kills: 0, writes: 0 });
    await finish(f, 7);
    const final = f.host.search({ ...f.read, literal: "absent" });
    expect(final.search.complete).toBe(true);
    expect(final.snapshot.output.data).toBe("");
    expect(final.snapshot.exitCode).toBe(7);
  });

  test("search continuation sees append matches and reports later eviction gaps", async () => {
    const f = fixture(12);
    await launched(f);
    f.output("α😀");
    const before = f.host.search({ ...f.read, literal: "😀β" });
    expect(before.search.complete).toBe(false);
    f.output("β\n");
    const after = f.host.search({ ...f.read, literal: "😀β", cursor: before.search.nextSearchCursor });
    expect(after.search.matchedAt).toBe(2);
    f.output("long replacement tail\n");
    const evicted = f.host.search({ ...f.read, literal: "😀β", cursor: after.search.nextSearchCursor });
    expect(evicted.search.gap).toBe(true);
    expect(evicted.search.matchedAt).toBeNull();
    expect(evicted.search.nextSearchCursor).toBeGreaterThanOrEqual(evicted.search.availableFrom);
    await finish(f);
  });

  test("search uses sanitized capture only and keeps owner, expiry and cursor admission", async () => {
    const f = fixture();
    await launched(f);
    f.output("ghp_abcdefghijk");
    f.output("lmnopqrstuvwxyz1234567890\n");
    await finish(f);
    const sanitized = await f.host.read(f.read);
    expect(f.host.search({ ...f.read, literal: "ghp_" }).search.matchedAt).toBeNull();
    const result = f.host.search({ ...f.read, literal: sanitized.output.data.trim() });
    expect(result.snapshot.output.data).toBe(sanitized.output.data);
    expect(() => f.host.search({ ...f.read, literal: "x", ownerKey: "foreign" })).toThrow("UNAVAILABLE");
    expect(() => f.host.search({ ...f.read, literal: "x", executionId: "foreign" })).toThrow("UNAVAILABLE");
    expect(() => f.host.search({ ...f.read, literal: "x", maxBytes: 3 })).toThrow("READ_INVALID");
    expect(() => f.host.search({ ...f.read, literal: "", cursor: -1 })).toThrow("READ_INVALID");
    f.clock(1101);
    expect(() => f.host.search({ ...f.read, literal: "x" })).toThrow("RECEIPT_EXPIRED");
    expect(f.counts()).toEqual({ spawns: 1, releases: 1, kills: 0, writes: 0 });
  });

  test("yield preserves the process, final diagnostics and real nonzero exit are repeatable", async () => {
    const f = fixture();
    await launched(f);
    expect((await f.host.read({ ...f.read, yieldMs: 1 })).state).toBe("running");
    expect(f.counts()).toEqual({ spawns: 1, releases: 0, kills: 0, writes: 0 });
    f.output("compiler failed\n");
    await finish(f, 7);
    const first = await f.host.read(f.read);
    const repeated = await f.host.read(f.read);
    expect(first).toEqual(repeated);
    expect(first.state).toBe("completed");
    expect(first.exitCode).toBe(7);
    expect(first.output.data).toBe("compiler failed\n");
    expect(f.counts().releases).toBe(1);
  });

  test("identity is reserved before async preparation and duplicate start never replays", async () => {
    const f = fixture();
    const pending = deferred<PreparedLocalExecution>();
    const request = { ...f.request, prepare: () => pending.promise };
    expect(f.host.start(request)).toBe(request.executionId);
    expect(f.host.start(request)).toBe(request.executionId);
    expect(f.counts().spawns).toBe(0);
    expect(() => f.host.start({ ...request, requestFingerprint: "other-command" })).toThrow("REQUEST_CONFLICT");
    pending.resolve(f.prepared);
    await Promise.resolve();
    expect(f.counts().spawns).toBe(1);
    await finish(f);
    expect(f.host.start(request)).toBe(request.executionId);
    expect(f.counts().spawns).toBe(1);
  });

  test("already-aborted start has no preparation or spawn effects", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    let preparations = 0;
    await launched(f, { signal: abort.signal, prepare: async () => { preparations += 1; return f.prepared; } });
    expect(preparations).toBe(0);
    expect(f.counts().spawns).toBe(0);
    expect((await f.host.read(f.read)).state).toBe("cancelled");
  });

  test("Stop during preparation disposes the late resource once without launching", async () => {
    const f = fixture();
    const pending = deferred<PreparedLocalExecution>();
    await launched(f, { prepare: () => pending.promise });
    expect((await f.host.cancel(f.read)).state).toBe("cancelling");
    pending.resolve(f.prepared);
    const final = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(final.state).toBe("cancelled");
    expect(final.resources).toBe("released");
    f.host.dispose();
    expect(f.counts()).toEqual({ spawns: 0, releases: 1, kills: 0, writes: 0 });
  });

  test("abort during spawn fences a late successful process", async () => {
    const abort = new AbortController();
    const exit = deferred<LocalProcessExit>();
    let kills = 0;
    let releases = 0;
    const host = new LocalExecutionHost({
      retention: { maxOutputBytes: 1024, maxTotalOutputBytes: 1024, maxExecutions: 1, maxActiveExecutions: 1,
        completedTtlMs: 100, maxInputRequestsPerExecution: 1 },
      spawn() { abort.abort(); return { pid: 42, exited: exit.promise, write() {}, terminate() { kills += 1; } }; },
    });
    host.start({ executionId: "race", ownerKey: "owner", requestIdentity: "request", requestFingerprint: "fingerprint",
      hostGeneration: host.hostGeneration, tty: false, signal: abort.signal,
      prepare: async () => ({ program: "/bin/sh", args: [], cwd: "/tmp", env: {}, dispose() { releases += 1; } }),
    });
    await Promise.resolve();
    expect(kills).toBe(1);
    exit.resolve({ exitCode: null, signal: "SIGKILL" });
    const receipt = await host.read({ executionId: "race", ownerKey: "owner", cursor: 0, maxBytes: 1024, yieldMs: 100 });
    expect(receipt.state).toBe("cancelled");
    expect(releases).toBe(1);
  });

  test("cancellation waits for process exit and tail drain before releasing resources", async () => {
    const f = fixture();
    await launched(f);
    expect((await f.host.cancel(f.read)).state).toBe("cancelling");
    expect(f.counts().releases).toBe(0);
    f.output("last diagnostic\n");
    f.exit.resolve({ exitCode: null, signal: "SIGKILL" });
    await f.host.read({ ...f.read, cursor: Buffer.byteLength("last diagnostic\n"), yieldMs: 100 });
    const result = await f.host.read(f.read);
    expect(result.state).toBe("cancelled");
    expect(result.output.data).toBe("last diagnostic\n");
    expect(f.counts().releases).toBe(1);
  });

  test("response budget does not consume retained output; overflow reports its exact gap", async () => {
    const f = fixture(12);
    await launched(f);
    f.output("abcdefghijklmnop\n");
    await finish(f);
    const one = await f.host.read({ ...f.read, maxBytes: 4 });
    expect(one.output).toEqual({ data: "fghi", cursor: 5, nextCursor: 9, availableFrom: 5,
      produced: 17, gap: true, hasMore: true });
    expect((await f.host.read({ ...f.read, maxBytes: 4 })).output).toEqual(one.output);
    expect((await f.host.read({ ...f.read, cursor: one.output.nextCursor })).output.data).toBe("jklmnop\n");
  });

  test("UTF-8 pages never split a character", async () => {
    const f = fixture();
    await launched(f);
    f.output("é😀fin\n");
    await finish(f);
    const first = await f.host.read({ ...f.read, maxBytes: 4 });
    expect(first.output.data).toBe("é");
    const next = await f.host.read({ ...f.read, cursor: first.output.nextCursor, maxBytes: 4 });
    expect(next.output.data).toBe("😀");
  });

  test("streaming secrets split across chunks are sanitized before retained reads", async () => {
    const f = fixture();
    await launched(f);
    f.output("ghp_abcdefghijk");
    f.output("lmnopqrstuvwxyz1234567890\n");
    await finish(f);
    const receipt = await f.host.read(f.read);
    expect(receipt.output.data).not.toContain("ghp_");
    expect(receipt.output.data).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("expired receipt never replays within its generation and stale generations cannot start", async () => {
    const f = fixture();
    await launched(f);
    await finish(f);
    f.clock(1101);
    await rejects(f.host.read(f.read), /RECEIPT_EXPIRED/);
    expect(() => f.host.start(f.request)).toThrow("RECEIPT_EXPIRED");
    f.clock(1501);
    expect(() => f.host.start(f.request)).toThrow("RECEIPT_EXPIRED");
    expect(() => f.host.start({ ...f.request, hostGeneration: "old-generation" })).toThrow("GENERATION_STALE");
    expect(f.counts().spawns).toBe(1);
  });

  test("foreign owner cannot read, write, or cancel; local fence stops only matching work", async () => {
    const f = fixture();
    await launched(f, { tty: true });
    await rejects(f.host.cancel({ ...f.read, ownerKey: "foreign" }), /UNAVAILABLE/);
    await rejects(f.host.read({ ...f.read, ownerKey: "foreign" }), /UNAVAILABLE/);
    f.host.fenceOwner("foreign");
    expect(f.counts().kills).toBe(0);
    f.host.fenceOwner(f.request.ownerKey);
    await rejects(f.host.write({ ...f.read, inputId: "i", chars: "touch x\n" }), /INPUT_FENCED/);
    expect(f.counts().kills).toBe(1);
    await finish(f);
  });

  test("input acknowledgement survives a lost reply and delivery errors cannot be replayed", async () => {
    const f = fixture();
    await launched(f, { tty: true });
    const input = { ...f.read, inputId: "input-a", chars: "hello\n" };
    await f.host.write(input);
    await f.host.write(input);
    expect(f.counts().writes).toBe(1);
    await rejects(f.host.write({ ...input, chars: "different\n" }), /INPUT_CONFLICT/);
    let attempts = 0;
    f.process.write = () => { attempts += 1; throw new Error("ambiguous"); };
    await rejects(f.host.write({ ...input, inputId: "input-b" }), /INPUT_OUTCOME_UNKNOWN/);
    await rejects(f.host.write({ ...input, inputId: "input-b" }), /INPUT_OUTCOME_UNKNOWN/);
    expect(attempts).toBe(1);
    await finish(f);
  });

  test("failed preparation remains a retained receipt and is never retried", async () => {
    const f = fixture();
    const request = { ...f.request, prepare: async () => { throw new Error("private error"); } };
    f.host.start(request);
    const failed = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(failed.state).toBe("failed");
    expect(failed.failureCode).toBe("LOCAL_EXECUTION_START_FAILED");
    expect(f.host.start(request)).toBe(request.executionId);
    expect(f.counts().spawns).toBe(0);
  });

  test("failed preparation preserves stable Current Folder error codes", async () => {
    const f = fixture();
    f.host.start({ ...f.request, prepare: async () => { throw new Error("WORKSTATION_CWD_INVALID"); } });
    const failed = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(failed.state).toBe("failed");
    expect(failed.failureCode).toBe("WORKSTATION_CWD_INVALID");
    expect(f.counts().spawns).toBe(0);
  });

  test("Stop arriving before Start reserves cancellation and fences delayed effects", async () => {
    const f = fixture();
    const stopped = await f.host.cancelOrReserve({ ...f.read, hostGeneration: f.host.hostGeneration });
    expect(stopped.state).toBe("cancelled");
    expect(() => f.host.start({ ...f.request, ownerKey: "foreign" })).toThrow("REQUEST_CONFLICT");
    expect(f.host.start(f.request)).toBe(f.request.executionId);
    expect(f.counts().spawns).toBe(0);
    expect((await f.host.read(f.read)).state).toBe("cancelled");
    expect(() => f.host.start({ ...f.request, requestFingerprint: "different" })).toThrow("REQUEST_CONFLICT");
  });

  test("Stop aborts pending preparation and records cancellation instead of a failed start", async () => {
    const f = fixture();
    let observedAbort = false;
    await launched(f, { prepare: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }, { once: true });
    }) });
    await f.host.cancel(f.read);
    const receipt = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(observedAbort).toBe(true);
    expect(receipt.state).toBe("cancelled");
    expect(receipt.failureCode).toBeNull();
    expect(f.counts().spawns).toBe(0);
  });

  test("retirement fences immediately and waits for late preparation and resource disposal", async () => {
    const f = fixture();
    const preparation = deferred<PreparedLocalExecution>();
    const cleanup = deferred<void>();
    await launched(f, { prepare: () => preparation.promise });
    let drained = false;
    const drain = f.host.finishDisposal().then(() => { drained = true; });
    expect(() => f.host.start({ ...f.request, executionId: "new", requestIdentity: "new" })).toThrow("OWNER_FENCED");
    preparation.resolve({ ...f.prepared, dispose: () => cleanup.promise });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(f.counts().spawns).toBe(0);
    cleanup.resolve();
    await drain;
    expect(drained).toBe(true);
    expect((await f.host.read(f.read)).state).toBe("cancelled");
  });

  test("capacity preserves expired identities and reports refusal instead of replay", async () => {
    const f = fixture();
    for (let index = 0; index < 4; index += 1) {
      f.host.start({ ...f.request, executionId: `execution-${index}`, requestIdentity: `request-${index}`,
        prepare: async () => { throw new Error("refused"); } });
      await Promise.resolve();
      await Promise.resolve();
    }
    f.clock(1200);
    expect(() => f.host.start(f.request)).toThrow("CAPACITY_REACHED");
    expect(() => f.host.start({ ...f.request, executionId: "execution-0", requestIdentity: "request-0" })).toThrow("RECEIPT_EXPIRED");
  });

  test("aggregate output pressure reports a gap without evicting another live execution", async () => {
    const f = fixture(8);
    await launched(f);
    f.output("abcdefgh\n");
    f.host.start({ ...f.request, executionId: "execution-b", requestIdentity: "request-b" });
    await Promise.resolve();
    f.output("ijklmnop\n");
    f.host.start({ ...f.request, executionId: "execution-c", requestIdentity: "request-c" });
    await Promise.resolve();
    f.output("qrstuvwx\n");
    const first = await f.host.read(f.read);
    expect(first.output.data).toBe("bcdefgh\n");
    const third = await f.host.read({ ...f.read, executionId: "execution-c" });
    expect(third.state).toBe("running");
    expect(third.output.gap).toBe(true);
    expect(third.output.availableFrom).toBe(9);
    expect(third.output.data).toBe("");
    await finish(f);
    await f.host.finishDisposal();
  });

  test("invalid cursors cannot deliver input or cancellation before returning an error", async () => {
    const f = fixture();
    await launched(f, { tty: true });
    f.output("é");
    for (const cursor of [1, 3]) {
      await rejects(f.host.write({ ...f.read, cursor, inputId: "input", chars: "mutate\n" }), /CURSOR_INVALID/);
      await rejects(f.host.cancel({ ...f.read, cursor }), /CURSOR_INVALID/);
      await rejects(f.host.cancelOrReserve({ ...f.read, cursor, hostGeneration: f.host.hostGeneration }), /CURSOR_INVALID/);
    }
    expect(f.counts().writes).toBe(0);
    expect(f.counts().kills).toBe(0);
    await rejects(f.host.cancelOrReserve({ ...f.read, executionId: "new", cursor: 1,
      hostGeneration: f.host.hostGeneration }), /CURSOR_INVALID/);
    expect(f.host.list(f.request.ownerKey)).toHaveLength(1);
    await f.host.write({ ...f.read, inputId: "input", chars: "mutate\n" });
    expect(f.counts().writes).toBe(1);
    await finish(f);
  });

  test("an invalid cursor inside a UTF-8 character is rejected", async () => {
    const f = fixture();
    await launched(f);
    f.output("é\n");
    await finish(f);
    await rejects(f.host.read({ ...f.read, cursor: 1 }), /CURSOR_INVALID/);
  });

  test("final success waits for resource release and Stop never signals an already-settled adapter", async () => {
    const f = fixture();
    const disposal = deferred<void>();
    await launched(f, { tty: true, prepare: async () => ({ ...f.prepared, dispose: () => disposal.promise }) });
    f.exit.resolve({ exitCode: 0, signal: null });
    await Promise.resolve();
    const pending = await f.host.read(f.read);
    expect(pending.state).toBe("running");
    expect(pending.resources).toBe("owned");
    expect(pending.exitCode).toBe(0);
    await rejects(f.host.write({ ...f.read, inputId: "after-exit", chars: "late\n" }), /INPUT_FENCED/);
    expect(f.counts().writes).toBe(0);
    await f.host.cancel(f.read);
    expect(f.counts().kills).toBe(0);
    disposal.reject(new Error("resource close failed"));
    const done = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(done.state).toBe("unknown");
    expect(done.failureCode).toBe("LOCAL_EXECUTION_RESOURCE_CLEANUP_FAILED");
    expect(done.resources).toBe("release_failed");
  });

  test("a real exit code never hides unconfirmed process-group cleanup", async () => {
    const f = fixture();
    await launched(f);
    f.exit.resolve({ exitCode: 0, signal: null, failureCode: "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED" });
    const receipt = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(receipt.state).toBe("unknown");
    expect(receipt.exitCode).toBe(0);
    expect(receipt.failureCode).toBe("LOCAL_EXECUTION_GROUP_CLEANUP_FAILED");
    expect(receipt.resources).toBe("released");
    expect(receipt.terminationScope).toBe("owned_process_group");
  });

  test("retirement disposal signals once and still waits for final drain", async () => {
    const f = fixture();
    await launched(f);
    f.host.dispose();
    f.host.dispose();
    let drained = false;
    const retirement = f.host.finishDisposal().then(() => { drained = true; });
    await Promise.resolve();
    expect(f.counts().kills).toBe(1);
    expect(drained).toBe(false);
    f.output("shutdown tail\n");
    f.exit.resolve({ exitCode: null, signal: "SIGKILL" });
    await retirement;
    const receipt = await f.host.read(f.read);
    expect(receipt.state).toBe("cancelled");
    expect(receipt.failureCode).toBeNull();
    expect(receipt.output.data).toBe("shutdown tail\n");
    expect(f.counts().releases).toBe(1);
  });

  test.each([false, true])("only clean adapter settlement resolves provisional termination uncertainty (tty=%s)", async (tty) => {
    const f = fixture();
    f.process.terminate = () => { throw new Error("fixture signal denied"); };
    const saved: string[] = [];
    f.host.subscribeSettled(async (snapshot) => { saved.push(snapshot.state); });
    await launched(f, { tty });
    const pending = await f.host.cancel(f.read);
    expect(pending.state).toBe("unknown");
    expect(pending.failureCode).toBe("LOCAL_EXECUTION_TERMINATION_UNCONFIRMED");
    expect(pending.resources).toBe("owned");
    expect(saved).toEqual([]);
    f.exit.resolve({ exitCode: null, signal: "SIGKILL" });
    const receipt = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(receipt.state).toBe("cancelled");
    expect(receipt.failureCode).toBeNull();
    expect(receipt.resources).toBe("released");
    expect(saved).toEqual(["cancelled"]);
  });

  for (const failureCode of ["LOCAL_EXECUTION_GROUP_CLEANUP_FAILED", "LOCAL_EXECUTION_OUTPUT_DRAIN_FAILED"]) {
    test.each([false, true])(`adapter ${failureCode} preserves uncertainty after a failed Stop (tty=%s)`, async (tty) => {
      const f = fixture();
      f.process.terminate = () => { throw new Error("fixture signal denied"); };
      await launched(f, { tty });
      await f.host.cancel(f.read);
      f.exit.resolve({ exitCode: null, signal: "SIGKILL", failureCode });
      const receipt = await f.host.read({ ...f.read, yieldMs: 100 });
      expect(receipt.state).toBe("unknown");
      expect(receipt.failureCode).toBe(failureCode);
      expect(receipt.resources).toBe("released");
    });
  }

  test.each([false, true])("resource failure remains unknown after a failed Stop and clean adapter settlement (tty=%s)", async (tty) => {
    const f = fixture();
    f.process.terminate = () => { throw new Error("fixture signal denied"); };
    await launched(f, { tty, prepare: async () => ({ ...f.prepared, dispose() { throw new Error("fixture cleanup failed"); } }) });
    await f.host.cancel(f.read);
    f.exit.resolve({ exitCode: null, signal: "SIGKILL" });
    const receipt = await f.host.read({ ...f.read, yieldMs: 100 });
    expect(receipt.state).toBe("unknown");
    expect(receipt.failureCode).toBe("LOCAL_EXECUTION_RESOURCE_CLEANUP_FAILED");
    expect(receipt.resources).toBe("release_failed");
  });

  test("explicit Stop can retry a failed signal without claiming completion", async () => {
    const f = fixture();
    let attempts = 0;
    f.process.terminate = () => {
      if (++attempts === 1) throw new Error("fixture signal denied");
    };
    await launched(f);
    expect((await f.host.cancel(f.read)).state).toBe("unknown");
    const retried = await f.host.cancel(f.read);
    expect(attempts).toBe(2);
    expect(retried.state).toBe("cancelling");
    expect(retried.resources).toBe("owned");
    f.exit.resolve({ exitCode: null, signal: "SIGKILL" });
    expect((await f.host.read({ ...f.read, yieldMs: 100 })).state).toBe("cancelled");
    await f.host.cancel(f.read);
    expect(attempts).toBe(2);
  });

  test("cleanup rejection is explicit uncertainty", async () => {
    const f = fixture();
    await launched(f, { prepare: async () => ({ ...f.prepared, dispose() { throw new Error("cleanup failed"); } }) });
    const result = await finish(f);
    expect(result.state).toBe("unknown");
    expect(result.resources).toBe("release_failed");
  });

  test("unmounted execution saves final diagnostics and retirement waits for its write", async () => {
    const f = fixture();
    const saved = deferred<void>();
    const receipts: { state: string; output: string; exit: number | null }[] = [];
    f.host.subscribeSettled((snapshot, ownerKey) => {
      expect(ownerKey).toBe(f.request.ownerKey);
      expect(snapshot.resources).toBe("released");
      receipts.push({ state: snapshot.state, output: snapshot.output.data, exit: snapshot.exitCode });
      return saved.promise;
    });
    await launched(f);
    f.output("final diagnostic\n");
    await finish(f, 7);
    expect(receipts).toEqual([{ state: "completed", output: "final diagnostic\n", exit: 7 }]);
    let drained = false;
    const retirement = f.host.finishDisposal().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    saved.resolve();
    await retirement;
    expect(drained).toBe(true);
  });

  test("failed history write cannot rewrite the actual terminal receipt", async () => {
    const f = fixture();
    f.host.subscribeSettled(async () => { throw new Error("fixture storage unavailable"); });
    await launched(f);
    const receipt = await finish(f, 7);
    await f.host.finishDisposal();
    expect(receipt.state).toBe("completed");
    expect(receipt.exitCode).toBe(7);
    expect(receipt.failureCode).toBeNull();
  });
});

describe("owned pipe process adapter", () => {
  test("immediate real nonzero exit drains final stdout/stderr using an exact environment", async () => {
    const output: string[] = [];
    const process = spawnLocalExecutionProcess({
      program: "/bin/sh", args: ["-c", "printf 'out\\n'; printf 'err\\n' >&2; exit 7"],
      cwd: "/tmp", env: {}, dispose() {},
    }, false, (_stream, bytes) => output.push(bytes.toString()));
    expect(await process.exited).toEqual({ exitCode: 7, signal: null });
    expect(output.join("")).toContain("out\n");
    expect(output.join("")).toContain("err\n");
  });

  test("missing executable yields a failed-start receipt after stream close", async () => {
    const process = spawnLocalExecutionProcess({
      program: "/nonexistent-local-execution-command", args: [], cwd: "/tmp", env: {}, dispose() {},
    }, false, () => {});
    expect((await process.exited).failureCode).toBe("LOCAL_EXECUTION_SPAWN_FAILED");
  });

  test("cancellation reaches the detached pipe group and waits for close", async () => {
    const ready = deferred<void>();
    const process = spawnLocalExecutionProcess({
      program: "/bin/sh", args: ["-c", "printf 'ready\\n'; sleep 30 & wait"],
      cwd: "/tmp", env: {}, dispose() {},
    }, false, () => ready.resolve());
    await ready.promise;
    process.terminate();
    const result = await process.exited;
    expect(result.signal).toBe("SIGKILL");
    expect(result.failureCode).toBeUndefined();
  });

  test("locally prepared credentials reach the child without being printed", async () => {
    const output: string[] = [];
    const process = spawnLocalExecutionProcess({
      program: "/bin/sh", args: ["-c", 'test "$GH_TOKEN" = test-only'], cwd: "/tmp",
      env: { GH_TOKEN: "test-only" }, dispose() {},
    }, false, (_stream, bytes) => output.push(bytes.toString()));
    expect(await process.exited).toEqual({ exitCode: 0, signal: null });
    expect(output.join("")).toBe("");
  });
});


test("resource custody remains owner-scoped after output expiry", async () => {
  for (const releaseFails of [false, true]) {
    const f = fixture();
    if (releaseFails) f.prepared.dispose = () => { throw new Error("cleanup failed"); };
    await launched(f);
    expect(f.host.getCustodyState(f.request.executionId, f.request.ownerKey)?.resources).toBe("owned");
    expect(f.host.getCustodyState(f.request.executionId, "foreign")).toBeUndefined();
    await finish(f);
    f.clock(2000);
    expect(f.host.list(f.request.ownerKey)).toEqual([]);
    expect(f.host.getCustodyState(f.request.executionId, f.request.ownerKey)?.resources).toBe(releaseFails ? "release_failed" : "released");
    await rejects(f.host.read(f.read), /RECEIPT_EXPIRED/);
  }
});

test("released preparation cannot conceal uncertain process cleanup in custody projection", async () => {
  const f = fixture();
  await launched(f);
  f.exit.resolve({ exitCode: null, signal: "SIGKILL", failureCode: "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED" });
  await f.host.read({ ...f.read, yieldMs: 100 });
  f.clock(2000);
  expect(f.host.list(f.request.ownerKey)).toEqual([]);
  expect(f.host.getCustodyState(f.request.executionId, f.request.ownerKey)).toEqual({ resources: "released", state: "unknown" });
});
