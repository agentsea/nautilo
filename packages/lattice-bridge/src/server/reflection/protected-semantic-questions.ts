import {
  DurableSleepOrganizationUnavailableError,
  type DurableSleepApplyResult, type DurableSleepClaim, type DurableSleepOrganizationAttempt,
  type DurableSleepOrganizerView, type DurableSleepOrganizerViewResult, type DurableSleepSemanticPort,
} from "@nautilo/reflection/durable";
import type {ReflectionSemanticOutputV2} from "@nautilo/lattice-crypto/background";
import type {ReflectionSemanticOperationPort} from "./semantic-operation.ts";
import type {PreparedReflectionSemanticQuestion} from "./prepared-semantic-question.ts";

type Application = Parameters<DurableSleepSemanticPort["applyProposal"]>[0];

export interface ProtectedReflectionSemanticQuestionValue {
  readonly view: DurableSleepOrganizerView;
  /** Existing publisher returns its real result after the supplied gate completion attaches it. */
  applyProposal(application: Application, completeOutput: (output: ReflectionSemanticOutputV2 | null) =>
    ReturnType<ReflectionSemanticOperationPort["runSemantic"]>): Promise<DurableSleepApplyResult>;
}

type Prepared = PreparedReflectionSemanticQuestion<ProtectedReflectionSemanticQuestionValue>;
type Preparation = Prepared | Exclude<DurableSleepOrganizerViewResult, {status: "ready"}>;

export interface ProtectedReflectionSemanticQuestionsPorts extends Pick<DurableSleepSemanticPort,
  "ensureAuthority" | "ensureSearchProjection" | "resolveParentConflict" | "resolveDependencyLoss"
  | "invokeOrganizer" | "invokeOrganizerBatch" | "modelLaneReadiness"> {
  /** Checks the exact family-owned live work lease; throws when it is no longer current. */
  assertClaimCurrent(claim: DurableSleepClaim, signal?: AbortSignal): Promise<void>;
  prepareQuestion(claim: DurableSleepClaim, signal?: AbortSignal): Promise<Preparation>;
}

/** Claim-local glue only. The executor owns scheduling; Lattice owns each parked grant. */
export function createProtectedReflectionSemanticQuestions(ports: ProtectedReflectionSemanticQuestionsPorts): DurableSleepSemanticPort {
  type Entry = {
    readonly signal: AbortSignal;
    active: boolean;
    applying: boolean;
    preparation?: Promise<Preparation>;
    question?: Prepared;
    assertCurrent(): Promise<void>;
    close(): Promise<void>;
  };
  const entries = new WeakMap<DurableSleepClaim, Entry>();
  const unavailable = () => new DurableSleepOrganizationUnavailableError();
  const entryFor = (claim: DurableSleepClaim, signal?: AbortSignal): Entry => {
    signal?.throwIfAborted();
    const entry = entries.get(claim);
    if (entry === undefined || !entry.active) throw unavailable();
    entry.signal.throwIfAborted(); return entry;
  };
  const assertQuestion = async (claim: DurableSleepClaim, signal?: AbortSignal) => {
    const entry = entryFor(claim, signal);
    await entry.assertCurrent();
    signal?.throwIfAborted();
    if (entry.question === undefined || entry.applying) throw unavailable();
    return entry;
  };
  const semantic: DurableSleepSemanticPort = {
    ensureAuthority: (claim, signal) => ports.ensureAuthority(claim, signal),
    ensureSearchProjection: (claim, signal) => ports.ensureSearchProjection(claim, signal),
    resolveParentConflict: input => ports.resolveParentConflict(input),
    resolveDependencyLoss: input => ports.resolveDependencyLoss(input),
    async openOrganizationAttempt(claim, signal): Promise<DurableSleepOrganizationAttempt> {
      if (claim.stage !== "organization" || entries.has(claim)) throw unavailable();
      const controller = new AbortController();
      const attemptSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
      let closing: Promise<void> | undefined, published = false;
      const active = () => {
        attemptSignal.throwIfAborted();
        if (!entry.active || entries.get(claim) !== entry) throw unavailable();
      };
      const close = (): Promise<void> => {
        if (closing !== undefined) return closing;
        entry.active = false;
        if (entries.get(claim) === entry) entries.delete(claim);
        attemptSignal.removeEventListener("abort", aborted);
        controller.abort(unavailable());
        closing = Promise.resolve().then(async () => {
          try {
            const prepared = await entry.preparation?.catch(() => undefined);
            if (prepared?.status === "ready") await prepared.close();
          } finally {delete entry.preparation; delete entry.question;}
        });
        // Cancellation may trigger cleanup before the executor reaches finally.
        void closing.catch(() => {}); return closing;
      };
      const aborted = () => {void close().catch(() => {});};
      const entry: Entry = {signal: attemptSignal, active: true, applying: false, close,
        async assertCurrent() {
          try {
            active(); await ports.assertClaimCurrent(claim, attemptSignal); active();
            await entry.question?.assertCurrent(); active();
          } catch (error) {
            await close().catch(() => {});
            if (signal?.aborted) throw error;
            throw unavailable();
          }
        },
      };
      entries.set(claim, entry); attemptSignal.addEventListener("abort", aborted, {once: true});
      await entry.assertCurrent();
      return Object.freeze({assertCurrent: () => entry.assertCurrent(),
        async publish<Value>(publish: () => Promise<Value>) {
          await entry.assertCurrent();
          if (published) throw unavailable();
          published = true;
          // The canonical publisher owns the outcome after entry, even if it consumes the claim.
          return publish();
        },
        close: () => close(),
      });
    },
    async loadOrganizerView(claim, signal) {
      const entry = entryFor(claim, signal);
      try {
        await entry.assertCurrent();
        entry.preparation ??= Promise.resolve().then(() => ports.prepareQuestion(claim, entry.signal));
        const prepared = await entry.preparation;
        if (prepared.status === "ready") entry.question = prepared;
        await entry.assertCurrent();
        signal?.throwIfAborted();
        return prepared.status === "ready" ? {status: "ready", view: prepared.value.view} : prepared;
      } catch (error) {await entry.close().catch(() => {}); throw error;}
    },
    async invokeOrganizer(claim, prompt, signal) {
      await assertQuestion(claim, signal);
      return ports.invokeOrganizer(claim, prompt, signal);
    },
    async applyProposal(application) {
      const entry = entryFor(application.claim, application.signal);
      if (entry.applying) throw unavailable();
      entry.applying = true;
      let accepting = true, invoked = false;
      let completion: Awaited<ReturnType<ReflectionSemanticOperationPort["runSemantic"]>> | undefined;
      let failure: Error | undefined;
      try {
        await entry.assertCurrent();
        const question = entry.question;
        if (question === undefined) throw unavailable();
        const result = await question.value.applyProposal({...application, signal: entry.signal}, output => {
          const complete = (async () => {
            if (!accepting || invoked) {
              failure = new Error("Reflection semantic completion is one-use within its application"); throw failure;
            }
            invoked = true;
            try {
              await entry.assertCurrent();
              const completed = await question.complete(output);
              completion = completed; return completed;
            } catch (error) {
              failure = error instanceof Error ? error : new Error("Reflection semantic completion failed"); throw error;
            } finally {output?.plaintext.fill(0);}
          })();
          void complete.catch(() => {}); return complete;
        });
        accepting = false;
        if (failure !== undefined) throw failure;
        if (result.status !== "applied") return result;
        if (completion === undefined) throw new Error("Reflection application returned before its gate attachment completed");
        if (completion.status !== "executed") return {status: "unavailable", failureCode: "publication_unavailable", failureDetail: "publication_incomplete"};
        return result;
      } finally {accepting = false; await entry.close().catch(() => {});}
    },
  };
  if (ports.modelLaneReadiness !== undefined) semantic.modelLaneReadiness = signal => ports.modelLaneReadiness!(signal);
  if (ports.invokeOrganizerBatch !== undefined) semantic.invokeOrganizerBatch = async (claims, prompt, signal) => {
    if (claims.length === 0 || new Set(claims).size !== claims.length) throw unavailable();
    for (const claim of claims) await assertQuestion(claim, signal);
    // Each grant was checked separately. Do not abort siblings or invalidate their
    // answers because another question expires after this shared disclosure.
    return ports.invokeOrganizerBatch!(claims, prompt, signal);
  };
  return Object.freeze(semantic);
}
