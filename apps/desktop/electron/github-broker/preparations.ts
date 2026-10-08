import { randomUUID } from "node:crypto";
import { githubFailure, sameGitHubOwner, parseGitHubPreparedOperation, type GitHubBrokerResult, type GitHubInvocationOwner,
  githubGitFailure, parseGitHubPreparedGitPush, parseGitHubGitOperation, digestGitHubGitPush,
  type GitHubGitOperation, type GitHubPreparedGitPush, type GitHubGitResult,
  type GitHubOperation, type GitHubPreparedOperation } from "../../../../packages/types/src/github-broker";

export type GitHubPreparationResult = { readonly ok: true; readonly prepared: GitHubPreparedOperation }
  | { readonly ok: false; readonly result: GitHubBrokerResult };
interface RecordEntry {
  readonly kind: "rest";
  readonly owner: GitHubInvocationOwner;
  readonly request: GitHubOperation;
  readonly toolCallId: string;
  readonly preparationId: string;
  readonly preparation: Promise<GitHubPreparationResult>;
  readonly finishPreparation: (result: GitHubPreparationResult) => void;
  prepared?: GitHubPreparedOperation;
  completion?: Promise<GitHubBrokerResult>;
  finish?: (result: GitHubBrokerResult) => void;
}

export type GitHubGitPreparationResult = { readonly ok: true; readonly prepared: GitHubPreparedGitPush }
  | { readonly ok: false; readonly result: GitHubGitResult };
interface GitRecordEntry {
  readonly kind: "git_push";
  readonly owner: GitHubInvocationOwner;
  readonly request: Extract<GitHubGitOperation, { operation: "push" }>;
  readonly toolCallId: string;
  readonly preparationId: string;
  readonly preparation: Promise<GitHubGitPreparationResult>;
  readonly finishPreparation: (result: GitHubGitPreparationResult) => void;
  prepared?: GitHubPreparedGitPush;
  completion?: Promise<GitHubGitResult>;
  finish?: (result: GitHubGitResult) => void;
}
/** Generation-local one-shot records, including unknown publishing outcomes.
 * Retiring a generation never reconstructs a missing approved preparation. */
export class GitHubPreparations {
  readonly generation: string;
  readonly #capacity: number;
  readonly #records = new Map<string, RecordEntry | GitRecordEntry>();
  readonly #identities = new Map<string, string>();
  #retired = false;
  constructor(input: { generation: string; capacity: number }) {
    if (!input.generation || !Number.isSafeInteger(input.capacity) || input.capacity < 1) throw new Error("Invalid GitHub preparation configuration");
    this.generation = input.generation; this.#capacity = input.capacity;
  }
  #identity(owner: GitHubInvocationOwner, toolCallId: string): string {
    return JSON.stringify([this.generation, owner.instanceId, owner.humanUserId, owner.agentId, owner.roomId,
      owner.conversationId, owner.runId, owner.relayId, owner.desktopSessionId, owner.pairingGeneration, toolCallId]);
  }
  async prepare(owner: GitHubInvocationOwner, toolCallId: string, request: GitHubOperation,
    create: (preparationId: string) => Promise<GitHubPreparationResult>): Promise<GitHubPreparationResult> {
    const failed = (code: "approval_stale" | "capacity_exhausted"): GitHubPreparationResult => ({ ok: false, result: githubFailure(request.operation, code) });
    if (this.#retired || !toolCallId) return failed("approval_stale");
    const key = this.#identity(owner, toolCallId);
    const previous = this.#identities.get(key);
    if (previous) {
      const record = this.#records.get(previous)!;
      return record.kind === "rest" && sameGitHubOwner(record.owner, owner) && JSON.stringify(record.request) === JSON.stringify(request)
        ? structuredClone(await record.preparation) : failed("approval_stale");
    }
    if (this.#records.size >= this.#capacity) return failed("capacity_exhausted");
    const preparationId = randomUUID();
    let resolve!: (value: GitHubPreparationResult) => void;
    const preparation = new Promise<GitHubPreparationResult>(done => { resolve = done; });
    let preparedFinished = false;
    const record: RecordEntry = { kind: "rest", owner: structuredClone(owner), request: structuredClone(request), toolCallId, preparationId, preparation,
      finishPreparation: result => {
        if (preparedFinished) return;
        preparedFinished = true;
        if (result.ok) record.prepared = structuredClone(result.prepared);
        resolve(structuredClone(result));
      } };
    this.#records.set(preparationId, record); this.#identities.set(key, preparationId);
    void Promise.resolve().then(() => create(preparationId)).then(result => {
      record.finishPreparation(this.#retired ? failed("approval_stale") : result);
    }).catch(() => record.finishPreparation({ ok: false, result: githubFailure(request.operation, "request_failed") }));
    return structuredClone(await preparation);
  }
  matches(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedOperation): boolean {
    const parsed = parseGitHubPreparedOperation(prepared);
    const record = this.#records.get(prepared.preparationId);
    return !this.#retired && prepared.generation === this.generation && record !== undefined && record.kind === "rest"
      && record.toolCallId === toolCallId && sameGitHubOwner(record.owner, owner)
      && record.prepared !== undefined && parsed !== null
      && JSON.stringify(parseGitHubPreparedOperation(record.prepared)) === JSON.stringify(parsed);
  }
  /** Content-free sent-effect truth survives generation retirement. This
   * neither releases a receipt nor authorizes another transport effect. */
  wasConsumed(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedOperation): boolean {
    const parsed = parseGitHubPreparedOperation(prepared);
    const record = this.#records.get(prepared.preparationId);
    return prepared.generation === this.generation && record !== undefined && record.kind === "rest" && record.completion !== undefined
      && record.toolCallId === toolCallId && sameGitHubOwner(record.owner, owner)
      && record.prepared !== undefined && parsed !== null
      && JSON.stringify(parseGitHubPreparedOperation(record.prepared)) === JSON.stringify(parsed);
  }
  /** A claimed effect keeps its result even if later external observations
   * drift. Redelivery must not misreport a previously sent POST as unsent. */
  completion(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedOperation): Promise<GitHubBrokerResult> | null {
    if (!this.matches(owner, toolCallId, prepared)) return null;
    const record = this.#records.get(prepared.preparationId);
    return record?.kind === "rest" ? record.completion?.then(value => structuredClone(value)) ?? null : null;
  }
  /** Must run synchronously immediately before POST. Completion is installed
   * before any transport effect, so concurrent/lost replies cannot publish twice. */
  consume(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedOperation):
    | { readonly kind: "claimed"; readonly finish: (result: GitHubBrokerResult) => void }
    | { readonly kind: "existing"; readonly result: Promise<GitHubBrokerResult> }
    | { readonly kind: "invalid" } {
    if (!this.matches(owner, toolCallId, prepared)) return { kind: "invalid" };
    const record = this.#records.get(prepared.preparationId)!;
    if (record.kind !== "rest") return { kind: "invalid" };
    if (record.completion) return { kind: "existing", result: record.completion.then(value => structuredClone(value)) };
    let resolve!: (result: GitHubBrokerResult) => void;
    record.completion = new Promise<GitHubBrokerResult>(done => { resolve = done; });
    let finished = false;
    record.finish = result => { if (!finished) { finished = true; resolve(structuredClone(result)); } };
    return { kind: "claimed", finish: record.finish };
  }
  /** Git push shares this exact owner/capacity/retirement ledger with REST
   * publishing, but its closed grammar never widens the REST dispatcher. */
  async prepareGitPush(owner: GitHubInvocationOwner, toolCallId: string,
    request: Extract<GitHubGitOperation, { operation: "push" }>,
    create: (preparationId: string) => Promise<GitHubGitPreparationResult>): Promise<GitHubGitPreparationResult> {
    const failed = (code: "approval_stale" | "capacity_exhausted"): GitHubGitPreparationResult => ({ ok: false, result: githubGitFailure("push", code) });
    const parsedRequest = parseGitHubGitOperation(request);
    if (this.#retired || !toolCallId || parsedRequest?.operation !== "push") return failed("approval_stale");
    request = parsedRequest;
    const key = this.#identity(owner, toolCallId);
    const previous = this.#identities.get(key);
    if (previous) {
      const record = this.#records.get(previous)!;
      return record.kind === "git_push" && sameGitHubOwner(record.owner, owner) && JSON.stringify(record.request) === JSON.stringify(request)
        ? structuredClone(await record.preparation) : failed("approval_stale");
    }
    if (this.#records.size >= this.#capacity) return failed("capacity_exhausted");
    const preparationId = randomUUID();
    let resolve!: (result: GitHubGitPreparationResult) => void;
    const preparation = new Promise<GitHubGitPreparationResult>(done => { resolve = done; });
    let settled = false;
    const record: GitRecordEntry = { kind: "git_push", owner: structuredClone(owner), request: structuredClone(request), toolCallId, preparationId, preparation,
      finishPreparation: result => {
        if (settled) return;
        settled = true;
        if (result.ok) record.prepared = structuredClone(result.prepared);
        resolve(structuredClone(result));
      } };
    this.#records.set(preparationId, record); this.#identities.set(key, preparationId);
    void Promise.resolve().then(() => create(preparationId)).then(async result => {
      if (!result.ok) { record.finishPreparation(this.#retired ? failed("approval_stale") : result); return; }
      const parsed = parseGitHubPreparedGitPush(result.prepared);
      if (parsed === null || parsed.preparationId !== preparationId || parsed.generation !== this.generation
        || parsed.toolCallId !== toolCallId || JSON.stringify(parsed.request) !== JSON.stringify(record.request)
        || parsed.digest !== await digestGitHubGitPush(record.owner, parsed)) return record.finishPreparation(failed("approval_stale"));
      record.finishPreparation(this.#retired ? failed("approval_stale") : { ok: true, prepared: parsed });
    }).catch(() => record.finishPreparation({ ok: false, result: githubGitFailure("push", "request_failed") }));
    return structuredClone(await preparation);
  }
  matchesGitPush(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedGitPush): boolean {
    const parsed = parseGitHubPreparedGitPush(prepared);
    const record = this.#records.get(prepared.preparationId);
    return !this.#retired && record?.kind === "git_push" && prepared.generation === this.generation
      && record.toolCallId === toolCallId && sameGitHubOwner(record.owner, owner)
      && record.prepared !== undefined && parsed !== null && JSON.stringify(record.prepared) === JSON.stringify(parsed);
  }
  wasGitPushConsumed(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedGitPush): boolean {
    const parsed = parseGitHubPreparedGitPush(prepared);
    const record = this.#records.get(prepared.preparationId);
    return record?.kind === "git_push" && record.completion !== undefined && prepared.generation === this.generation
      && record.toolCallId === toolCallId && sameGitHubOwner(record.owner, owner) && parsed !== null
      && record.prepared !== undefined && JSON.stringify(record.prepared) === JSON.stringify(parsed);
  }
  completionGitPush(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedGitPush): Promise<GitHubGitResult> | null {
    if (!this.matchesGitPush(owner, toolCallId, prepared)) return null;
    const record = this.#records.get(prepared.preparationId);
    return record?.kind === "git_push" ? record.completion?.then(value => structuredClone(value)) ?? null : null;
  }
  consumeGitPush(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedGitPush):
    | { readonly kind: "claimed"; readonly finish: (result: GitHubGitResult) => void }
    | { readonly kind: "existing"; readonly result: Promise<GitHubGitResult> }
    | { readonly kind: "invalid" } {
    if (!this.matchesGitPush(owner, toolCallId, prepared)) return { kind: "invalid" };
    const record = this.#records.get(prepared.preparationId)!;
    if (record.kind !== "git_push") return { kind: "invalid" };
    if (record.completion) return { kind: "existing", result: record.completion.then(value => structuredClone(value)) };
    let resolve!: (value: GitHubGitResult) => void;
    record.completion = new Promise<GitHubGitResult>(done => { resolve = done; });
    let finished = false;
    record.finish = result => { if (!finished) { finished = true; resolve(structuredClone(result)); } };
    return { kind: "claimed", finish: record.finish };
  }
  dispose(): void {
    if (this.#retired) return;
    this.#retired = true;
    for (const record of this.#records.values()) {
      if (record.kind === "git_push") {
        record.finishPreparation({ ok: false, result: githubGitFailure("push", "approval_stale") });
        record.finish?.(githubGitFailure("push", "outcome_unknown", true));
      } else {
        record.finishPreparation({ ok: false, result: githubFailure(record.request.operation, "approval_stale") });
        record.finish?.(githubFailure(record.request.operation, "outcome_unknown", true));
      }
    }
  }
}
