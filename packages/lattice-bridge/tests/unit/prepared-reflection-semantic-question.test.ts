import {describe, expect, test} from "bun:test";
import {prepareReflectionSemanticQuestion} from "../../src/server/reflection/prepared-semantic-question.ts";
import type {ReflectionSemanticOperationPort, ReflectionSemanticOperationRequest} from "../../src/server/reflection/semantic-operation.ts";

async function expectRejected(work: Promise<unknown>, reason?: string | Error) {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (typeof reason === "string") expect((error as Error).message).toContain(reason);
  else if (reason !== undefined) expect(error).toBe(reason);
}

function fixture(id: string, admission: "ready" | "waiting" | "reconciliation_required" = "ready") {
  const deadline = new AbortController();
  const bytes = new TextEncoder().encode(id);
  let available = true, disclosures = 0, attachments = 0, settled = false;
  const request: Omit<ReflectionSemanticOperationRequest, "execute"> = {
    workKind: "reflection.organization", coordinates: {recordRef: id, claimGeneration: 1,
      inputBindings: [{objectId: id, namespaceId: `namespace-${id}`, objectType: "nautilo.reflection.record.v1"}],
      outputNamespaceIds: [`namespace-${id}`]},
    validateInput: () => Promise.resolve(), validateOutput: () => Promise.resolve(),
    attach: () => Promise.resolve(),
  };
  const operation: ReflectionSemanticOperationPort = {
    async runSemantic(input) {
      if (admission !== "ready") return {status: admission};
      const signal = AbortSignal.any([deadline.signal, input.signal!]);
      let active = true;
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (!available || !active) return Promise.reject(new Error("grant unavailable"));
        return Promise.resolve();
      };
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); signal.addEventListener("abort", abort, {once: true});
        if (signal.aborted) abort();
      });
      try {
        await assertCurrent(); disclosures++;
        const output = await Promise.race([input.execute([{...request.coordinates.inputBindings[0]!, plaintext: bytes}],
          `output-${id}`, signal, assertCurrent), aborted]);
        await assertCurrent();
        expect(output === null || output.objectId === `output-${id}`).toBe(true);
        if (output !== null) expect(output.plaintext.some(byte => byte !== 0)).toBe(true);
        await input.attach({output, claimId: `claim-${id}`, signal, authorizeCommit: async () => {await assertCurrent(); return 1;},
          held: {executor: {query: () => Promise.resolve([])}, product: {query: () => Promise.resolve([])}, issuerSigningPublicKey: new Uint8Array(32)}});
        attachments++;
        return {status: "executed"};
      } finally {active = false; settled = true; bytes.fill(0); signal.removeEventListener("abort", abort);}
    },
  };
  const prepare = (opened: Parameters<ReflectionSemanticOperationRequest["execute"]>[0]) =>
    Promise.resolve({text: new TextDecoder().decode(opened[0]!.plaintext)});
  return {operation, request, prepare, bytes, deadline, revoke: () => {available = false;},
    stats: () => ({disclosures, attachments, settled})};
}

describe("prepared per-question Reflection semantic lifetimes", () => {
  test("unrelated grants stay simultaneously ready and publish independently", async () => {
    const a = fixture("question-a"), b = fixture("question-b");
    const [first, second] = await Promise.all([prepareReflectionSemanticQuestion(a), prepareReflectionSemanticQuestion(b)]);
    if (first.status !== "ready" || second.status !== "ready") throw new Error("not ready");
    expect(first.value.text).toBe("question-a"); expect(second.value.text).toBe("question-b");
    expect(a.stats().settled).toBe(false); expect(b.stats().settled).toBe(false);
    const output = new Uint8Array([1, 2, 3]);
    expect(await first.complete({objectId: "output-question-a", plaintext: output})).toEqual({status: "executed"});
    expect(output).toEqual(new Uint8Array(3)); expect(a.bytes.every(byte => byte === 0)).toBe(true);
    await second.assertCurrent(); expect(second.value.text).toBe("question-b");
    expect(b.stats().settled).toBe(false);
    expect(await second.complete(null)).toEqual({status: "executed"});
    expect(a.stats().attachments).toBe(1); expect(b.stats().attachments).toBe(1);
    await Promise.all([first.close(), second.close()]);
    expect(() => first.value).toThrow("closed");
  });

  test.each(["waiting", "reconciliation_required"] as const)("%s sibling does not block a ready grant", async status => {
    const a = fixture("question-a"), b = fixture("question-b", status);
    const [first, second] = await Promise.all([prepareReflectionSemanticQuestion(a), prepareReflectionSemanticQuestion(b)]);
    expect(second).toEqual({status}); expect(b.stats().disclosures).toBe(0);
    if (first.status !== "ready") throw new Error("not ready");
    expect(await first.complete(null)).toEqual({status: "executed"}); await first.close();
  });

  test.each(["revoke", "expire", "cancel"] as const)("%s closes only its question and rejects late publication", async change => {
    const a = fixture("question-a"), b = fixture("question-b");
    const [first, second] = await Promise.all([prepareReflectionSemanticQuestion(a), prepareReflectionSemanticQuestion(b)]);
    if (first.status !== "ready" || second.status !== "ready") throw new Error("not ready");
    if (change === "revoke") a.revoke();
    else if (change === "expire") a.deadline.abort(new Error("grant expired"));
    else await first.close();
    await expectRejected(first.assertCurrent());
    const output = new Uint8Array([3]);
    await expectRejected(first.complete({objectId: "output-question-a", plaintext: output}));
    await first.close(); expect(a.stats().attachments).toBe(0); expect(a.stats().settled).toBe(true);
    expect(a.bytes.every(byte => byte === 0)).toBe(true);
    expect(await second.complete(null)).toEqual({status: "executed"}); await second.close();
  });

  test("completion is one-use, and close never supplies implicit no-change output", async () => {
    const f = fixture("question-a"), ready = await prepareReflectionSemanticQuestion(f);
    if (ready.status !== "ready") throw new Error("not ready");
    const completed = ready.complete(null);
    await expectRejected(ready.complete(null), "closed");
    expect(await completed).toEqual({status: "executed"});
    await expectRejected(ready.assertCurrent(), "closed");
    await ready.close(); await ready.close();
    const g = fixture("question-b"), unused = await prepareReflectionSemanticQuestion(g);
    if (unused.status !== "ready") throw new Error("not ready");
    await unused.close(); expect(g.stats().attachments).toBe(0);
  });

  test("revocation at completion wipes the transferred output before attachment", async () => {
    const f = fixture("question-a"), ready = await prepareReflectionSemanticQuestion(f);
    if (ready.status !== "ready") throw new Error("not ready");
    f.revoke(); const output = new Uint8Array([4, 5]);
    await expectRejected(ready.complete({objectId: "output-question-a", plaintext: output}), "grant unavailable");
    expect(output).toEqual(new Uint8Array(2)); expect(f.bytes.every(byte => byte === 0)).toBe(true);
    expect(f.stats().attachments).toBe(0); await ready.close();
  });

  test("cancellation while preparing discards late decoded values and joins the gate", async () => {
    const f = fixture("question-a");
    let finish!: (value: {text: string}) => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => {entered = resolve;});
    const pending = prepareReflectionSemanticQuestion({...f, prepare: () => {
      entered(); return new Promise<{text: string}>(resolve => {finish = resolve;});
    }});
    await preparing; f.deadline.abort(new Error("grant expired"));
    await expectRejected(pending, "grant expired");
    finish({text: "must not become ready"}); await Promise.resolve();
    expect(f.stats()).toEqual({disclosures: 1, attachments: 0, settled: true});
    expect(f.bytes.every(byte => byte === 0)).toBe(true);
  });

  test("complete waits for the same attachment and preserves its failure", async () => {
    const f = fixture("question-a");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    const ready = await prepareReflectionSemanticQuestion({...f, request: {...f.request, attach: async request => {
      await request.authorizeCommit(); enter(); await held;
    }}});
    if (ready.status !== "ready") throw new Error("not ready");
    let finished = false;
    const completion = ready.complete(null).then(result => {finished = true; return result;});
    await entered; expect(finished).toBe(false); expect(f.stats().settled).toBe(false);
    release(); expect(await completion).toEqual({status: "executed"}); await ready.close();

    const g = fixture("question-b"), failure = new Error("product commit rejected");
    const rejected = await prepareReflectionSemanticQuestion({...g, request: {...g.request, attach: () => Promise.reject(failure)}});
    if (rejected.status !== "ready") throw new Error("not ready");
    const output = new Uint8Array([5]);
    await expectRejected(rejected.complete({objectId: "output-question-b", plaintext: output}), failure);
    expect(output[0]).toBe(0); expect(g.stats()).toEqual({disclosures: 1, attachments: 0, settled: true});
    expect(() => rejected.value).toThrow("closed"); await rejected.close();
  });
});
