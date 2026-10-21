import {
  parseRelayLocalExecutionBinding,
  type RelayLocalExecutionBindingV4,
} from "@nautilo/relay";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export type ProtectedRepoDocsMode = "init" | "update" | "auto";
export type ProtectedRepoDocsPublish = "branch" | "push" | "pr";

/** Exact protected definition content opened inside the Task definition owner. */
export type ProtectedRepoDocsOpenedSelection = Readonly<{
  target: string;
  mode: ProtectedRepoDocsMode;
  publish: ProtectedRepoDocsPublish;
  instructions?: string;
}>;

export type ProtectedRepoDocsCommandKind = "prepare" | "commit" | "publish";

/**
 * Closed semantic request for the trusted server adapter. The adapter owns the
 * fixed Git argv; callers cannot turn this into a generic shell facility.
 */
export type ProtectedRepoDocsExecutionRequest = Readonly<{
  version: 1;
  kind: ProtectedRepoDocsCommandKind;
  operationId: string;
  taskRunId: string;
  relativeWorkspacePath: string;
  branch: string;
  target: string;
  mode: ProtectedRepoDocsMode;
  modelId: string;
  publish: ProtectedRepoDocsPublish;
  instructions?: string;
  sourceHead?: string;
  resolvedMode?: Exclude<ProtectedRepoDocsMode, "auto">;
  commitOid?: string;
}>;

/** Current relay binding pinned before a mutating command is checkpointed. */
export type ProtectedRepoDocsExecutionPlan = Readonly<{
  requestDigest: string;
  relayBinding: RelayLocalExecutionBindingV4;
}>;

export type ProtectedRepoDocsPrepareResult = Readonly<{
  kind: "prepared";
  relativeWorkspacePath: string;
  /** Absolute contained path verified by the captured-project relay adapter. */
  workDir: string;
  branch: string;
  sourceHead: string;
  resolvedMode: "init" | "update";
  brief: string;
}>;

export type ProtectedRepoDocsCommitResult = Readonly<{
  kind: "committed" | "no_changes";
  sourceHead: string;
  commitOid: string | null;
  changedFileCount: number;
}>;

export type ProtectedRepoDocsPublishResult = Readonly<{
  kind: "published";
  commitOid: string;
  remoteRefOid: string | null;
  instruction: string | null;
}>;

export type ProtectedRepoDocsExecutionResult =
  | ProtectedRepoDocsPrepareResult
  | ProtectedRepoDocsCommitResult
  | ProtectedRepoDocsPublishResult;

export type ProtectedRepoDocsInspection =
  | Readonly<{ status: "confirmed"; result: ProtectedRepoDocsExecutionResult }>
  | Readonly<{ status: "absent" | "ambiguous" }>;

/**
 * Process-local authority over the existing delegated relay. Planning pins the
 * exact relay generation/binding before checkpoint persistence. Execute and
 * inspect must reject a substituted request, digest, binding, or generation.
 */
export interface ProtectedRepoDocsExecutionPort {
  plan(request: ProtectedRepoDocsExecutionRequest): Promise<ProtectedRepoDocsExecutionPlan | null>;
  execute(input: Readonly<{
    request: ProtectedRepoDocsExecutionRequest;
    plan: ProtectedRepoDocsExecutionPlan;
    signal: AbortSignal;
  }>): Promise<ProtectedRepoDocsExecutionResult>;
  inspect(input: Readonly<{
    request: ProtectedRepoDocsExecutionRequest;
    plan: ProtectedRepoDocsExecutionPlan;
    signal: AbortSignal;
  }>): Promise<ProtectedRepoDocsInspection>;
}

export type ProtectedRepoDocsPendingReceiptV1 = Readonly<{
  version: 1;
  status: "pending";
  request: ProtectedRepoDocsExecutionRequest;
  plan: ProtectedRepoDocsExecutionPlan;
}>;

export type ProtectedRepoDocsConfirmedReceiptV1 = Readonly<{
  version: 1;
  status: "confirmed";
  request: ProtectedRepoDocsExecutionRequest;
  plan: ProtectedRepoDocsExecutionPlan;
  result: ProtectedRepoDocsExecutionResult;
}>;

export type ProtectedRepoDocsOperationReceiptV1 =
  | ProtectedRepoDocsPendingReceiptV1
  | ProtectedRepoDocsConfirmedReceiptV1;

export type ProtectedRepoDocsCheckpointV1 = Readonly<{
  version: 1;
  taskRunId: string;
  relativeWorkspacePath: string;
  branch: string;
  target: string;
  mode: ProtectedRepoDocsMode;
  modelId: string;
  publish: ProtectedRepoDocsPublish;
  instructions?: string;
  /** The trusted prepared brief/workspace was atomically installed in graph state. */
  preparedGraphInputApplied: boolean;
  receipts: readonly ProtectedRepoDocsOperationReceiptV1[];
}>;

export class ProtectedRepoDocsOutcomeUnknownError extends Error {
  constructor() {
    super("Protected repo docs effect outcome is unknown");
    this.name = "ProtectedRepoDocsOutcomeUnknownError";
  }
}

export interface ProtectedRepoDocsCheckpointStore {
  read(): Promise<ProtectedRepoDocsCheckpointV1 | null>;
  write(checkpoint: ProtectedRepoDocsCheckpointV1): Promise<void>;
}

function operationId(taskRunId: string, kind: ProtectedRepoDocsCommandKind): string {
  return `protected-repo-docs:${createHash("sha256")
    .update(`${taskRunId}\0${kind}`, "utf8").digest("hex")}`;
}

export function createProtectedRepoDocsCheckpoint(input: Readonly<{
  taskRunId: string;
  selection: ProtectedRepoDocsOpenedSelection;
  modelId: string;
}>): ProtectedRepoDocsCheckpointV1 {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.taskRunId)) {
    throw new TypeError("Protected repo docs TaskRun identity is invalid");
  }
  if (input.modelId.trim().length === 0) {
    throw new TypeError("Protected repo docs model identity is invalid");
  }
  return Object.freeze({
    version: 1,
    taskRunId: input.taskRunId,
    relativeWorkspacePath: `nautilo-repo-docs/task-run-${input.taskRunId}`,
    branch: `nautilo/repo-docs/${input.taskRunId}`,
    target: input.selection.target,
    mode: input.selection.mode,
    modelId: input.modelId,
    publish: input.selection.publish,
    ...(input.selection.instructions === undefined
      ? {} : { instructions: input.selection.instructions }),
    preparedGraphInputApplied: false,
    receipts: Object.freeze([]),
  });
}

export function createProtectedRepoDocsRequest(
  checkpoint: ProtectedRepoDocsCheckpointV1,
  kind: ProtectedRepoDocsCommandKind,
): ProtectedRepoDocsExecutionRequest {
  const prepare = checkpoint.receipts.find(receipt =>
    receipt.status === "confirmed" && receipt.request.kind === "prepare"
  );
  const committed = checkpoint.receipts.find(receipt =>
    receipt.status === "confirmed" && receipt.request.kind === "commit"
  );
  const sourceHead = prepare?.status === "confirmed"
    && prepare.result.kind === "prepared" ? prepare.result.sourceHead : undefined;
  const resolvedMode = prepare?.status === "confirmed"
    && prepare.result.kind === "prepared" ? prepare.result.resolvedMode : undefined;
  const commitOid = committed?.status === "confirmed"
    && (committed.result.kind === "committed" || committed.result.kind === "no_changes")
    ? committed.result.commitOid ?? undefined : undefined;
  if (kind !== "prepare" && sourceHead === undefined) {
    throw new TypeError("Protected repo docs preparation receipt is unavailable");
  }
  if (kind === "commit" && resolvedMode === undefined) {
    throw new TypeError("Protected repo docs prepared mode is unavailable");
  }
  if (kind === "publish" && commitOid === undefined) {
    throw new TypeError("Protected repo docs commit receipt is unavailable");
  }
  return Object.freeze({
    version: 1,
    kind,
    operationId: operationId(checkpoint.taskRunId, kind),
    taskRunId: checkpoint.taskRunId,
    relativeWorkspacePath: checkpoint.relativeWorkspacePath,
    branch: checkpoint.branch,
    target: checkpoint.target,
    mode: checkpoint.mode,
    modelId: checkpoint.modelId,
    publish: checkpoint.publish,
    ...(checkpoint.instructions === undefined ? {} : { instructions: checkpoint.instructions }),
    ...(kind === "prepare" || sourceHead === undefined ? {} : { sourceHead }),
    ...(kind !== "commit" || resolvedMode === undefined ? {} : { resolvedMode }),
    ...(kind !== "publish" || commitOid === undefined ? {} : { commitOid }),
  });
}

function sameRequest(
  left: ProtectedRepoDocsExecutionRequest,
  right: ProtectedRepoDocsExecutionRequest,
): boolean {
  return isDeepStrictEqual(left, right);
}

function expectedRequestDigest(request: ProtectedRepoDocsExecutionRequest): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function freezeDeep<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function exactPlan(
  request: ProtectedRepoDocsExecutionRequest,
  value: ProtectedRepoDocsExecutionPlan,
): ProtectedRepoDocsExecutionPlan | null {
  const binding = parseRelayLocalExecutionBinding(value.relayBinding);
  if (value.requestDigest !== expectedRequestDigest(request)
    || binding?.version !== 4
    || binding.operation !== "start"
    || binding.invocationId !== request.operationId
    || binding.authority.taskRunId !== request.taskRunId) return null;
  return freezeDeep(structuredClone({
    requestDigest: value.requestDigest,
    relayBinding: binding,
  }));
}

function confirmedKind(
  request: ProtectedRepoDocsExecutionRequest,
  result: ProtectedRepoDocsExecutionResult,
): boolean {
  const oid = (value: unknown): value is string =>
    typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
  if (request.kind === "prepare") {
    return result.kind === "prepared"
      && result.relativeWorkspacePath === request.relativeWorkspacePath
      && result.branch === request.branch
      && pathIsAbsolute(result.workDir)
      && oid(result.sourceHead)
      && (result.resolvedMode === "init" || result.resolvedMode === "update")
      && (request.mode === "auto" || result.resolvedMode === request.mode)
      && result.brief.trim().length > 0;
  }
  if (request.kind === "commit") {
    return (result.kind === "committed" || result.kind === "no_changes")
      && result.sourceHead === request.sourceHead
      && Number.isSafeInteger(result.changedFileCount)
      && result.changedFileCount >= 0
      && (result.kind === "committed" ? oid(result.commitOid) : result.commitOid === null);
  }
  return result.kind === "published"
    && result.commitOid === request.commitOid
    && oid(result.commitOid)
    && (result.remoteRefOid === null || oid(result.remoteRefOid))
    && (result.instruction === null || typeof result.instruction === "string")
    && (request.publish !== "pr"
      || (typeof result.instruction === "string" && result.instruction.trim().length > 0));
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

function replaceReceipt(
  checkpoint: ProtectedRepoDocsCheckpointV1,
  receipt: ProtectedRepoDocsOperationReceiptV1,
): ProtectedRepoDocsCheckpointV1 {
  const prior = checkpoint.receipts.filter(candidate =>
    candidate.request.operationId !== receipt.request.operationId
  );
  return Object.freeze({
    ...checkpoint,
    receipts: Object.freeze([...prior, receipt]),
  });
}

/**
 * Persist one immutable relay plan before dispatch. A restored pending effect
 * is inspected only; even a proven absence is not automatically replayed.
 */
export async function runProtectedRepoDocsOperation(input: Readonly<{
  checkpoint: ProtectedRepoDocsCheckpointV1;
  request: ProtectedRepoDocsExecutionRequest;
  port: ProtectedRepoDocsExecutionPort;
  store: ProtectedRepoDocsCheckpointStore;
  signal: AbortSignal;
}>): Promise<Readonly<{
  checkpoint: ProtectedRepoDocsCheckpointV1;
  result: ProtectedRepoDocsExecutionResult;
}>> {
  input.signal.throwIfAborted();
  const current = await input.store.read() ?? input.checkpoint;
  if (!sameRequest(
    input.request,
    createProtectedRepoDocsRequest(current, input.request.kind),
  )) {
    throw new TypeError("Protected repo docs request does not match its checkpoint");
  }
  const existing = current.receipts.find(candidate =>
    candidate.request.operationId === input.request.operationId
  );
  if (existing !== undefined) {
    if (!sameRequest(existing.request, input.request)) {
      throw new TypeError("Protected repo docs operation identity changed");
    }
    const retainedPlan = exactPlan(input.request, existing.plan);
    if (retainedPlan === null) {
      throw new TypeError("Protected repo docs retained relay authority is invalid");
    }
    if (existing.status === "confirmed") {
      if (!confirmedKind(input.request, existing.result)) {
        throw new TypeError("Protected repo docs receipt is invalid");
      }
      return Object.freeze({ checkpoint: current, result: existing.result });
    }
    const inspection = await input.port.inspect({
      request: input.request,
      plan: retainedPlan,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    if (inspection.status !== "confirmed") {
      throw new ProtectedRepoDocsOutcomeUnknownError();
    }
    const inspectedResult = freezeDeep(structuredClone(inspection.result));
    if (!confirmedKind(input.request, inspectedResult)) {
      throw new ProtectedRepoDocsOutcomeUnknownError();
    }
    const confirmed = Object.freeze({
      version: 1 as const,
      status: "confirmed" as const,
      request: input.request,
      plan: retainedPlan,
      result: inspectedResult,
    });
    const next = replaceReceipt(current, confirmed);
    await input.store.write(next);
    return Object.freeze({ checkpoint: next, result: inspectedResult });
  }

  const planned = await input.port.plan(input.request);
  input.signal.throwIfAborted();
  const plan = planned === null ? null : exactPlan(input.request, planned);
  if (plan === null) {
    throw new TypeError("Protected repo docs relay authority is unavailable");
  }
  const planSnapshot = structuredClone(plan);
  const pending = Object.freeze({
    version: 1 as const,
    status: "pending" as const,
    request: input.request,
    plan,
  });
  const withPending = replaceReceipt(current, pending);
  await input.store.write(withPending);
  input.signal.throwIfAborted();
  const executed = await input.port.execute({
    request: input.request,
    plan,
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  if (!isDeepStrictEqual(plan, planSnapshot)) {
    throw new TypeError("Protected repo docs relay binding changed during execution");
  }
  const result = freezeDeep(structuredClone(executed));
  if (!confirmedKind(input.request, result)) {
    throw new TypeError("Protected repo docs result is invalid");
  }
  const confirmed = Object.freeze({
    version: 1 as const,
    status: "confirmed" as const,
    request: input.request,
    plan,
    result,
  });
  const next = replaceReceipt(withPending, confirmed);
  await input.store.write(next);
  return Object.freeze({ checkpoint: next, result });
}
