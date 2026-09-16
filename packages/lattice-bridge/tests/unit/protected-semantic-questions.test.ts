import {describe, expect, test} from "bun:test";
import {runDurableHierarchySleep, type DurableSleepClaim, type DurableSleepOrganizerView, type DurableSleepWorkPort} from "@nautilo/reflection/durable";
import {createProtectedReflectionSemanticQuestions, type ProtectedReflectionSemanticQuestionValue} from "../../src/server/reflection/protected-semantic-questions.ts";
import {prepareReflectionSemanticQuestion, type PreparedReflectionSemanticQuestion} from "../../src/server/reflection/prepared-semantic-question.ts";
import type {ReflectionSemanticOperationPort} from "../../src/server/reflection/semantic-operation.ts";

const hierarchy = {maxModelCalls: 20, maxVisitedRecords: 100, maxCreatedRecords: 10, maxTraversalWork: 100, maxStatementCharacters: 800};
const applied = {status: "applied", operation: "no_change", replayed: false,
  usage: {modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0}} as const;
const claim = (id: string): DurableSleepClaim => ({logicalObjectRef: id, recordRef: id, generation: 1,
  stage: "organization", changeReason: "created", leaseToken: `lease-${id}`});
function view(id: string): DurableSleepOrganizerView {
  const snapshot = (ref: string) => ({recordRef: ref, observedContentFingerprint: `fingerprint-${ref}`, posture: "derived" as const,
    anchors: ["room:opaque"], statement: `Evidence ${ref}`, sourceRefs: [], childRecordRefs: [], structuralHeight: 0, lifecycle: "current" as const});
  return {changed: {handle: "C0", snapshot: snapshot(id), dependency: {kind: "record", recordRef: id}},
    candidates: [{handle: "M1", snapshot: snapshot(`neighbor-${id}`), dependency: {kind: "record", recordRef: `neighbor-${id}`}}],
    existingParents: [], maxSelectedChildren: 2};
}
async function rejected(work: Promise<unknown>, reason?: string) {
  const error: unknown = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (reason !== undefined) expect((error as Error).message).toContain(reason);
}

function fixture(options: {
  waiting?: string;
  noCandidates?: boolean;
  noChange?: boolean;
  beforePrepare?: () => Promise<void>;
  apply?: ProtectedReflectionSemanticQuestionValue["applyProposal"];
  afterModel?: (revoke: (id: string) => void) => void;
  attach?: (signal: AbortSignal) => Promise<void>;
  result?: "executed" | "reconciliation_required";
} = {}) {
  const revoked = new Set<string>(), events: string[] = [], prompts: string[] = [], batches: string[][] = [];
  const prepared: PreparedReflectionSemanticQuestion<ProtectedReflectionSemanticQuestionValue>[] = [];
  const rawBytes: Uint8Array[] = [];
  let preparations = 0;
  const check = (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (revoked.has(id)) throw new Error("grant revoked");
  };
  const operation: ReflectionSemanticOperationPort = {async runSemantic(request) {
    const id = request.coordinates.recordRef, signal = request.signal!;
    const bytes = new TextEncoder().encode(id); rawBytes.push(bytes);
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal.addEventListener("abort", abort, {once: true}); if (signal.aborted) abort();
    });
    try {
      check(id, signal);
      const output = await Promise.race([request.execute([{...request.coordinates.inputBindings[0]!, plaintext: bytes}],
        `output-${id}`, signal, () => {check(id, signal); return Promise.resolve();}), aborted]);
      check(id, signal);
      await Promise.race([request.attach({output, claimId: `crypto-${id}`, signal,
        authorizeCommit: () => {check(id, signal); return Promise.resolve(1);},
        held: {executor: {query: () => Promise.resolve([])}, product: {query: () => Promise.resolve([])}, issuerSigningPublicKey: new Uint8Array(32)}}), aborted]);
      return {status: options.result ?? "executed"};
    } finally {bytes.fill(0); signal.removeEventListener("abort", abort); events.push(`closed:${id}`);}
  }};
  const semantic = createProtectedReflectionSemanticQuestions({
    assertClaimCurrent: (current, signal) => {check(current.recordRef, signal); return Promise.resolve();},
    ensureAuthority: () => Promise.resolve({status: "ready"}), ensureSearchProjection: () => Promise.resolve({status: "ready"}),
    resolveParentConflict: () => Promise.resolve({status: "not_applicable"}), resolveDependencyLoss: () => Promise.resolve({status: "not_applicable"}),
    prepareQuestion: async (current, signal) => {
      preparations++; const id = current.recordRef;
      if (id === options.waiting) return {status: "waiting", retryAt: 12_000};
      if (options.noChange) return {status: "no_change", reason: "record_lifecycle_obsolete"};
      const result = await prepareReflectionSemanticQuestion({operation,
        request: {workKind: "reflection.organization", coordinates: {recordRef: id, claimGeneration: 1,
          inputBindings: [{objectId: id, namespaceId: `namespace-${id}`, objectType: "nautilo.reflection.record.v1"}], outputNamespaceIds: [`namespace-${id}`]},
          ...(signal === undefined ? {} : {signal}), validateInput: () => Promise.resolve(), validateOutput: () => Promise.resolve(),
          attach: async request => {await request.authorizeCommit(); await options.attach?.(request.signal); request.signal.throwIfAborted(); events.push(`attach:${id}`);}},
        prepare: async opened => {
          await options.beforePrepare?.();
          expect(new TextDecoder().decode(opened[0]!.plaintext)).toBe(id);
          return Promise.resolve({view: {...view(id), ...(options.noCandidates ? {candidates: []} : {})}, applyProposal: options.apply ?? (async (_application, complete) => {
            await complete(null); return applied;
          })});
        },
      });
      if (result.status !== "ready") throw new Error("unexpected fake grant result");
      prepared.push(result); return result;
    },
    invokeOrganizer: () => Promise.resolve(JSON.stringify({operation: "no_change"})),
    invokeOrganizerBatch: (claims, prompt) => {
      batches.push(claims.map(current => current.recordRef)); prompts.push(prompt);
      options.afterModel?.(id => revoked.add(id));
      return Promise.resolve(JSON.stringify({answers: claims.map((_, index) => ({question: `Q${index + 1}`, proposal: {operation: "no_change"}}))}));
    },
  });
  const work = (claims: DurableSleepClaim[]): DurableSleepWorkPort => ({
    claimNext: () => {const current = claims.shift(); return Promise.resolve(current === undefined ? {status: "empty"} : {status: "claimed", claim: current});},
    checkpoint: () => Promise.resolve({status: "accepted"}),
    pause: input => {events.push(`pause:${input.claim.recordRef}:${input.nextAttemptAt}`); return Promise.resolve({status: "accepted"});},
    complete: input => {events.push(`complete:${input.claim.recordRef}`); return Promise.resolve({status: "accepted"});},
    defer: input => {events.push(`defer:${input.claim.recordRef}:${input.failureCode}`); return Promise.resolve({status: "deferred"});},
    enqueue: () => Promise.resolve(),
  });
  return {semantic, events, prepared, prompts, batches, rawBytes, work, preparations: () => preparations};
}

describe("protected Reflection question lifecycle glue", () => {
  test("the pure executor batches two independent ready grants while a sibling waits", async () => {
    const f = fixture({waiting: "waiting"});
    const result = await runDurableHierarchySleep({semantic: f.semantic, work: f.work([claim("waiting"), claim("a"), claim("b")]), now: () => 1000, budget: {hierarchy, maxWorkItems: 3}});
    expect(f.batches).toEqual([["a", "b"]]); expect(f.prompts).toHaveLength(1);
    expect(result.completed).toBe(2); expect(result.paused).toBe(1);
    expect(f.events).toContain("pause:waiting:12000"); expect(f.events).toContain("attach:a"); expect(f.events).toContain("attach:b");
    for (const value of f.prepared) expect(() => value.value).toThrow();
    expect(f.rawBytes.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });

  test("revocation after the shared model call discards only that answer", async () => {
    const f = fixture({afterModel: revoke => revoke("a")});
    const result = await runDurableHierarchySleep({semantic: f.semantic, work: f.work([claim("a"), claim("b")]), budget: {hierarchy, maxWorkItems: 2}});
    expect(f.batches).toEqual([["a", "b"]]); expect(result.completed).toBe(1); expect(result.deferred).toBe(1);
    expect(f.events).not.toContain("attach:a"); expect(f.events).toContain("attach:b");
    expect(f.events).toContain("closed:a"); expect(f.events).toContain("closed:b");
  });

  test("one preparation is shared, and a closed claim cannot retrieve its old view", async () => {
    const f = fixture(), current = claim("a"), attempt = await f.semantic.openOrganizationAttempt!(current);
    const loaded = await Promise.all([f.semantic.loadOrganizerView(current), f.semantic.loadOrganizerView(current)]);
    expect(loaded[0]).toEqual(loaded[1]); expect(f.preparations()).toBe(1);
    await attempt.close("cancelled"); await attempt.close("cancelled");
    await rejected(f.semantic.loadOrganizerView(current)); await rejected(f.semantic.invokeOrganizer(current, "late"));
    await rejected(attempt.publish(() => Promise.resolve()));
    expect(f.events.filter(event => event === "closed:a")).toHaveLength(1);
  });

  test.each(["ready_without_candidates", "metadata_no_change"] as const)("%s shortcut completes work without implicit gate attachment", async mode => {
    const f = fixture({noCandidates: mode === "ready_without_candidates", noChange: mode === "metadata_no_change"});
    const result = await runDurableHierarchySleep({semantic: f.semantic, work: f.work([claim("a")]), budget: {hierarchy, maxWorkItems: 1}});
    expect(result.completed).toBe(1); expect(f.batches).toHaveLength(0); expect(f.events).not.toContain("attach:a");
    expect(f.events).toContain("complete:a");
    expect(f.prepared).toHaveLength(mode === "metadata_no_change" ? 0 : 1);
    if (mode === "ready_without_candidates") {
      expect(f.events).toContain("closed:a"); expect(() => f.prepared[0]!.value).toThrow();
      expect(f.rawBytes.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    }
  });

  test("cancellation during preparation joins the gate and discards a late prepared view", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;});
    const pending = new Promise<void>(resolve => {release = resolve;});
    const f = fixture({beforePrepare: () => {enter(); return pending;}}), current = claim("a");
    const controller = new AbortController(), attempt = await f.semantic.openOrganizationAttempt!(current, controller.signal);
    const load = f.semantic.loadOrganizerView(current, controller.signal);
    await entered; controller.abort(new Error("cancelled"));
    await rejected(load, "cancelled"); await attempt.close("cancelled");
    expect(f.events).toContain("closed:a"); expect(f.prepared).toHaveLength(0);
    expect(f.rawBytes.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    release(); await rejected(f.semantic.loadOrganizerView(current));
  });

  test.each(["missing", "unawaited", "duplicate", "reconciliation"] as const)("%s completion cannot report applied", async mode => {
    let release!: () => void, enter!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;});
    const pending = new Promise<void>(resolve => {release = resolve;});
    const f = fixture({
      ...(mode === "reconciliation" ? {result: "reconciliation_required" as const} : {}),
      ...(mode === "unawaited" ? {attach: () => {enter(); return pending;}} : {}),
      apply: async (_application, complete) => {
        if (mode === "unawaited") {void complete(null).catch(() => {}); await entered;}
        else if (mode !== "missing") {
          await complete(null);
          if (mode === "duplicate") await complete(null).catch(() => {});
        }
        return applied;
      },
    });
    const current = claim("a"), attempt = await f.semantic.openOrganizationAttempt!(current);
    await f.semantic.loadOrganizerView(current);
    const result = f.semantic.applyProposal({claim: current, proposal: {operation: "no_change"}, idempotencyKey: "a", budget: hierarchy});
    if (mode === "reconciliation") expect(await result).toMatchObject({status: "unavailable", failureDetail: "publication_incomplete"});
    else await rejected(result);
    release(); await attempt.close("failed");
    if (mode === "missing" || mode === "unawaited") expect(f.events).not.toContain("attach:a");
    expect(() => f.prepared[0]!.value).toThrow();
  });

  test("stale planning closes without a no-change marker or a second model run", async () => {
    const f = fixture({apply: () => Promise.resolve({status: "stale", failureDetail: "publication_plan_stale"})});
    const current = claim("a"), attempt = await f.semantic.openOrganizationAttempt!(current);
    await f.semantic.loadOrganizerView(current);
    expect(await f.semantic.applyProposal({claim: current, proposal: {operation: "no_change"}, idempotencyKey: "a", budget: hierarchy}))
      .toEqual({status: "stale", failureDetail: "publication_plan_stale"});
    expect(f.events).not.toContain("attach:a"); await attempt.close("unavailable");
  });
});
