import type {ReflectionSemanticOperationPort, ReflectionSemanticOperationRequest} from "./semantic-operation.ts";

type RunResult = Awaited<ReturnType<ReflectionSemanticOperationPort["runSemantic"]>>;
type Output = Awaited<ReturnType<ReflectionSemanticOperationRequest["execute"]>>;

export interface PreparedReflectionSemanticQuestion<Value> {
  readonly status: "ready";
  /** Borrowed for this attempt only. Consumers must release their own derived references on close. */
  readonly value: Value;
  assertCurrent(): Promise<void>;
  /** One-use transfer of output bytes; resolves only after the same gate's attachment settles. */
  complete(output: Output): Promise<RunResult>;
  /** Aborts unfinished execution and joins its gate. Never authorizes a no-change attachment. */
  close(): Promise<void>;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {resolve = yes; reject = no;});
  // The gate may fail before a consumer reaches the corresponding await.
  void promise.catch(() => {});
  return {promise, resolve, reject};
}

/**
 * Parks one existing semantic callback while its question joins a model batch.
 * The owning organization attempt must close this handle on every exit. There
 * is no additional grant, queue, deadline or registry: the gate owns opened
 * payload buffers and keys throughout preparation, waiting and publication.
 * This helper drops decoded values; callers must release copies they derive.
 */
export async function prepareReflectionSemanticQuestion<Value>(input: {
  readonly operation: ReflectionSemanticOperationPort;
  readonly request: Omit<ReflectionSemanticOperationRequest, "execute">;
  readonly prepare: (opened: Parameters<ReflectionSemanticOperationRequest["execute"]>[0],
    outputObjectId: string | undefined, signal: AbortSignal) => Promise<Value>;
}): Promise<PreparedReflectionSemanticQuestion<Value> | Readonly<{status: "waiting" | "reconciliation_required"}>> {
  const controller = new AbortController();
  const signal = input.request.signal === undefined ? controller.signal
    : AbortSignal.any([input.request.signal, controller.signal]);
  const ready = deferred<void>(), output = deferred<Output>();
  let state: "preparing" | "ready" | "completing" | "closed" = "preparing";
  let value: Value | undefined;
  let current: (() => Promise<void>) | undefined;
  let ownedOutput: Output | undefined;
  let closing: Promise<void> | undefined;
  const unavailable = () => new Error("Reflection semantic question is closed");
  const clear = () => {
    state = "closed"; value = undefined; current = undefined;
    ownedOutput?.plaintext.fill(0); ownedOutput = undefined;
  };
  const run = Promise.resolve().then(() => input.operation.runSemantic({...input.request, signal,
    execute: async (opened, outputObjectId, executionSignal, assertCurrent) => {
      const abort = () => {
        const reason: unknown = executionSignal.reason ?? unavailable();
        ready.reject(reason); output.reject(reason); clear();
      };
      executionSignal.addEventListener("abort", abort, {once: true});
      try {
        executionSignal.throwIfAborted();
        const prepared = await input.prepare(opened, outputObjectId, executionSignal);
        executionSignal.throwIfAborted();
        await assertCurrent();
        if (state !== "preparing") throw unavailable();
        value = prepared; current = assertCurrent; state = "ready"; ready.resolve();
        return await output.promise;
      } finally {executionSignal.removeEventListener("abort", abort);}
    },
  }));
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    controller.abort(unavailable()); output.reject(unavailable()); clear();
    closing = run.then(() => {}, () => {});
    return closing;
  };
  const assertReady = () => {signal.throwIfAborted(); if (state !== "ready") throw unavailable();};
  const question: PreparedReflectionSemanticQuestion<Value> = Object.freeze({
    status: "ready",
    get value() {assertReady(); return value as Value;},
    async assertCurrent() {
      try {assertReady(); await current!(); assertReady();}
      catch (error) {await close(); throw error;}
    },
    async complete(result: Output): Promise<RunResult> {
      assertReady();
      state = "completing"; ownedOutput = result;
      try {
        await current!(); signal.throwIfAborted();
        if (state !== "completing") throw unavailable();
        output.resolve(result);
        return await run;
      } catch (error) {await close(); throw error;}
      finally {clear();}
    },
    close,
  });
  try {
    return await Promise.race([
      ready.promise.then(() => question),
      run.then(result => {
        if (result.status === "executed") throw new Error("Reflection semantic gate skipped question execution");
        return result as Readonly<{status: "waiting" | "reconciliation_required"}>;
      }),
    ]);
  } catch (error) {await close(); throw error;}
}
