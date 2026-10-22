import { createHash } from "node:crypto";
import {
  bindDelegatedLocalExecution,
  buildGitContext,
  createSystemPrompt,
  createUserPrompt,
  DEFAULT_WIKI_DIR,
  ProtectedRepoDocsOutcomeUnknownError,
  readLastUpdate,
  type DelegatedLocalExecutionPort,
  type NautiloState,
  type ProtectedRepoDocsExecutionPlan,
  type ProtectedRepoDocsExecutionPort,
  type ProtectedRepoDocsExecutionRequest,
  type ProtectedRepoDocsExecutionResult,
  type ProtectedRepoDocsOpenedSelection,
  type RepoGitSurface,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import {
  parseRelayLocalExecutionBinding,
  type RelayLocalExecutionBindingV4,
} from "@nautilo/relay";

type RepoDocsState = Pick<NautiloState,
  | "currentTaskId"
  | "currentTaskRunId"
  | "agentId"
  | "roomId"
  | "currentThreadId"
  | "langgraphThreadId"
  | "causalHumanUserId"
  | "trustedExecutionEntrypoint"
>;

export type ProtectedTaskRepoDocsLocalExecutionInput = Readonly<{
  delegated: DelegatedLocalExecutionPort;
  registry: ToolRelayRegistry;
  state: RepoDocsState;
  selection: ProtectedRepoDocsOpenedSelection;
  modelId: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}>;

type LocalExecutionView = Readonly<{
  executionId: string;
  generation: string;
  session_id: string;
  state: "starting" | "running" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";
  exitCode: number | null;
  output: Readonly<{
    data: string;
    cursor: number;
    nextCursor: number;
    availableFrom: number;
    produced: number;
    gap: boolean;
    hasMore: boolean;
  }>;
}>;

type PrepareWireReceipt = Readonly<{
  kind: "prepare";
  workDir: string;
  relativeWorkspacePath: string;
  branch: string;
  sourceHead: string;
  resolvedMode: "init" | "update";
  metadata: string;
  status: string;
  head: string;
  diff: string;
  logArgument: string;
  log: string;
}>;

type ResultWireReceipt =
  | PrepareWireReceipt
  | Readonly<{
    kind: "commit";
    resultKind: "committed" | "no_changes";
    sourceHead: string;
    commitOid: string | null;
    changedFileCount: number;
  }>
  | Readonly<{
    kind: "publish";
    commitOid: string;
    remoteRefOid: string | null;
    instruction: string | null;
  }>;

const RECEIPT_PREFIX = "NAUTILO_REPO_DOCS_V1";
const TASK_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REQUEST_DIGEST = /^[0-9a-f]{64}$/u;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === Object.keys(value).length;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function copyBinding(value: unknown): RelayLocalExecutionBindingV4 | null {
  const parsed = parseRelayLocalExecutionBinding(value);
  if (parsed?.version !== 4) return null;
  return freeze(structuredClone(parsed));
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameBinding(left: RelayLocalExecutionBindingV4, right: RelayLocalExecutionBindingV4): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requestDigest(request: ProtectedRepoDocsExecutionRequest): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function expectedOperationId(taskRunId: string, kind: ProtectedRepoDocsExecutionRequest["kind"]): string {
  return `protected-repo-docs:${createHash("sha256").update(`${taskRunId}\0${kind}`, "utf8").digest("hex")}`;
}

function validTarget(target: string): boolean {
  if (target.length === 0 || target.trim() !== target || /[\0\s]/u.test(target) || target.startsWith("-")) return false;
  if (/^(?:https?|ssh|git):\/\//u.test(target) || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/u.test(target)) return true;
  if (target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(target)) return false;
  return target.split(/[\\/]/u).every(part => part.length > 0 && part !== "..") && target !== ".git";
}

function validateRequest(input: ProtectedTaskRepoDocsLocalExecutionInput, request: ProtectedRepoDocsExecutionRequest): void {
  const relativeWorkspacePath = `nautilo-repo-docs/task-run-${request.taskRunId}`;
  const branch = `nautilo/repo-docs/${request.taskRunId}`;
  const keys = ["version", "kind", "operationId", "taskRunId", "relativeWorkspacePath", "branch", "target", "mode", "modelId", "publish",
    ...(request.instructions === undefined ? [] : ["instructions"]),
    ...(request.sourceHead === undefined ? [] : ["sourceHead"]),
    ...(request.resolvedMode === undefined ? [] : ["resolvedMode"]),
    ...(request.commitOid === undefined ? [] : ["commitOid"])];
  if (!record(request) || !exactKeys(request, keys) || request.version !== 1
    || !TASK_RUN_ID.test(request.taskRunId)
    || request.taskRunId !== input.state.currentTaskRunId
    || request.taskRunId !== input.delegated.taskRunId
    || input.state.currentTaskId !== input.delegated.taskId
    || input.state.trustedExecutionEntrypoint !== "background.task"
    || request.operationId !== expectedOperationId(request.taskRunId, request.kind)
    || request.relativeWorkspacePath !== relativeWorkspacePath
    || request.branch !== branch
    || request.target !== input.selection.target
    || request.mode !== input.selection.mode
    || request.modelId !== input.modelId
    || request.modelId.trim().length === 0
    || request.publish !== input.selection.publish
    || request.instructions !== input.selection.instructions
    || !validTarget(request.target)
    || (request.kind === "prepare" && (request.sourceHead !== undefined || request.resolvedMode !== undefined || request.commitOid !== undefined))
    || (request.kind === "commit" && (!request.sourceHead || !request.resolvedMode || request.commitOid !== undefined))
    || (request.kind === "publish" && (!request.sourceHead || request.resolvedMode !== undefined || !request.commitOid))
    || (request.resolvedMode !== undefined
      && request.mode !== "auto" && request.resolvedMode !== request.mode)
    || (request.sourceHead !== undefined && !GIT_OID.test(request.sourceHead))
    || (request.commitOid !== undefined && !GIT_OID.test(request.commitOid))) {
    throw new TypeError("Protected repo docs request is invalid");
  }
}

function validatePlan(request: ProtectedRepoDocsExecutionRequest, plan: ProtectedRepoDocsExecutionPlan): RelayLocalExecutionBindingV4 {
  const keys = ["requestDigest", "relayBinding"];
  const binding = record(plan) && exactKeys(plan, keys) ? copyBinding(plan.relayBinding) : null;
  if (!binding || plan.requestDigest !== requestDigest(request) || !REQUEST_DIGEST.test(plan.requestDigest)
    || binding.operation !== "start" || binding.invocationId !== request.operationId
    || binding.authority.taskRunId !== request.taskRunId) {
    throw new TypeError("Protected repo docs execution plan changed");
  }
  return binding;
}

function decodeBase64(value: string): string | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return decoded.toString("utf8");
}

function parseNatural(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseReceipt(output: string, digest: string): ResultWireReceipt | null {
  const lines = output.split("\n").filter(line => line.length > 0);
  if (lines.length !== 1) return null;
  const fields = lines[0]!.split("\t");
  if (fields[0] !== RECEIPT_PREFIX || fields[1] !== digest) return null;
  if (fields[2] === "prepare" && fields.length === 14) {
    const decoded = fields.slice(3).map(decodeBase64);
    const [workDir, relativeWorkspacePath, branch, sourceHead, resolvedMode, metadata, status, head, diff, logArgument, log] = decoded;
    if (decoded.some(value => value === null) || !workDir?.startsWith("/") || !sourceHead || !GIT_OID.test(sourceHead)
      || !head || head !== sourceHead || (resolvedMode !== "init" && resolvedMode !== "update")) return null;
    return Object.freeze({ kind: "prepare", workDir, relativeWorkspacePath: relativeWorkspacePath!, branch: branch!,
      sourceHead, resolvedMode, metadata: metadata!, status: status!, head, diff: diff!, logArgument: logArgument!, log: log! });
  }
  if (fields[2] === "commit" && fields.length === 7) {
    const resultKind = fields[3];
    const sourceHead = fields[4];
    const rawCommitOid = fields[5];
    const commitOid = rawCommitOid === "-" ? null : rawCommitOid;
    const changedFileCount = parseNatural(fields[6]!);
    if ((resultKind !== "committed" && resultKind !== "no_changes") || !sourceHead || !GIT_OID.test(sourceHead)
      || commitOid === undefined || (commitOid !== null && !GIT_OID.test(commitOid)) || changedFileCount === null
      || (resultKind === "committed") !== (commitOid !== null)) return null;
    return Object.freeze({ kind: "commit", resultKind, sourceHead, commitOid, changedFileCount });
  }
  if (fields[2] === "publish" && fields.length === 6) {
    const commitOid = fields[3];
    const rawRemoteRefOid = fields[4];
    const remoteRefOid = rawRemoteRefOid === "-" ? null : rawRemoteRefOid;
    const instruction = fields[5] === "-" ? null : decodeBase64(fields[5]!);
    if (!commitOid || !GIT_OID.test(commitOid) || remoteRefOid === undefined
      || (remoteRefOid !== null && !GIT_OID.test(remoteRefOid))
      || instruction === null && fields[5] !== "-") return null;
    return Object.freeze({ kind: "publish", commitOid, remoteRefOid, instruction });
  }
  return null;
}

function gitEnvironment(): string {
  return "export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false GIT_EDITOR=: GIT_SEQUENCE_EDITOR=:;";
}

/** Model file tools cannot access .git; each semantic effect also rejects local drift. */
function gitEffectGuard(): string {
  return `[ -d .git ] && [ ! -L .git ] && [ -f .git/config ] && [ ! -L .git/config ]
[ -d .git/hooks ] && [ ! -L .git/hooks ]
[ -z "$(find .git/hooks -mindepth 1 ! -name '*.sample' -print)" ]
[ -d .git/nautilo-repo-docs ] && [ ! -L .git/nautilo-repo-docs ]
[ -f .git/nautilo-repo-docs/source-config ] && [ ! -L .git/nautilo-repo-docs/source-config ]
[ -f .git/nautilo-repo-docs/source-origin ] && [ ! -L .git/nautilo-repo-docs/source-origin ]
[ "$(git hash-object .git/config)" = "$(cat .git/nautilo-repo-docs/source-config)" ]
[ "$(git remote get-url origin)" = "$(cat .git/nautilo-repo-docs/source-origin)" ]
[ "$(git remote get-url --push origin)" = "$(cat .git/nautilo-repo-docs/source-origin)" ]`;
}

function prepareScript(request: ProtectedRepoDocsExecutionRequest, digest: string): string {
  const q = shellQuote;
  return `set -eu
umask 077
${gitEnvironment()}
root=$(pwd -P)
rel=${q(request.relativeWorkspacePath)}
case "$rel" in nautilo-repo-docs/task-run-${request.taskRunId}) ;; *) exit 71 ;; esac
workspace="$root/$rel"
receipt="$workspace/.git/nautilo-repo-docs/${digest}.receipt"
if [ -f "$receipt" ]; then cat "$receipt"; exit 0; fi
[ ! -e "$workspace" ] || exit 72
mkdir -p "$root/nautilo-repo-docs"
git -c core.hooksPath=/dev/null -c commit.gpgSign=false clone --no-local --no-checkout -- ${q(request.target)} "$workspace" >/dev/null 2>&1
git -C "$workspace" checkout --force HEAD >/dev/null 2>&1
git -C "$workspace" switch -c ${q(request.branch)} >/dev/null 2>&1
[ -d "$workspace/.git" ] && [ ! -L "$workspace/.git" ]
[ -d "$workspace/.git/hooks" ] && [ ! -L "$workspace/.git/hooks" ]
[ -z "$(find "$workspace/.git/hooks" -mindepth 1 ! -name '*.sample' -print)" ]
mkdir -p "$workspace/.git/nautilo-repo-docs"
git -C "$workspace" hash-object "$workspace/.git/config" > "$workspace/.git/nautilo-repo-docs/source-config"
git -C "$workspace" remote get-url origin > "$workspace/.git/nautilo-repo-docs/source-origin"
source_head=$(git -C "$workspace" rev-parse HEAD 2>/dev/null)
[ -n "$source_head" ] || exit 73
work_dir=$(cd "$workspace" && pwd -P)
case "$work_dir" in "$root"/*) ;; *) exit 74 ;; esac
metadata=$(git -C "$workspace" show "HEAD:${DEFAULT_WIKI_DIR}/.openwiki-metadata.json" 2>/dev/null || true)
requested_mode=${q(request.mode)}
if [ "$requested_mode" = auto ]; then
  if git -C "$workspace" cat-file -e "HEAD:${DEFAULT_WIKI_DIR}" 2>/dev/null; then resolved_mode=update; else resolved_mode=init; fi
else resolved_mode=$requested_mode
fi
[ "$resolved_mode" != update ] || git -C "$workspace" cat-file -e "HEAD:${DEFAULT_WIKI_DIR}" 2>/dev/null
if [ -e "$workspace/${DEFAULT_WIKI_DIR}" ] || [ -L "$workspace/${DEFAULT_WIKI_DIR}" ]; then
  [ -d "$workspace/${DEFAULT_WIKI_DIR}" ] && [ ! -L "$workspace/${DEFAULT_WIKI_DIR}" ]
else
  mkdir "$workspace/${DEFAULT_WIKI_DIR}"
fi
[ ! -L "$workspace/${DEFAULT_WIKI_DIR}/.openwiki-metadata.json" ]
status=$(git -C "$workspace" status --short 2>/dev/null)
head=$(git -C "$workspace" rev-parse HEAD 2>/dev/null)
diff=$(git -C "$workspace" diff --name-status HEAD 2>/dev/null)
old_head=$(printf '%s\n' "$metadata" | sed -n 's/^[[:space:]]*"gitHead":[[:space:]]*"\\([0-9a-f][0-9a-f]*\\)"[,]*[[:space:]]*$/\\1/p' | head -n 1)
updated_at=$(printf '%s\n' "$metadata" | sed -n 's/^[[:space:]]*"updatedAt":[[:space:]]*"\\([0-9TZ:.-][0-9TZ:.-]*\\)"[,]*[[:space:]]*$/\\1/p' | head -n 1)
log_argument=max20
if [ "$resolved_mode" = update ] && printf '%s' "$old_head" | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'; then
  log_argument="head:$old_head"
  log=$(git -C "$workspace" log "$old_head..HEAD" --name-status --oneline 2>/dev/null || true)
elif [ "$resolved_mode" = update ] && [ -n "$updated_at" ]; then
  log_argument="since:$updated_at"
  log=$(git -C "$workspace" log --since "$updated_at" --name-status --oneline 2>/dev/null || true)
else
  log=$(git -C "$workspace" log --max-count=20 --name-status --oneline 2>/dev/null || true)
fi
enc() { printf '%s' "$1" | base64 | tr -d '\n'; }
tab=$(printf '\t')
line=${q(RECEIPT_PREFIX)}"$tab"${q(digest)}"$tab"prepare"$tab""$(enc "$work_dir")""$tab""$(enc "$rel")""$tab""$(enc ${q(request.branch)})""$tab""$(enc "$source_head")""$tab""$(enc "$resolved_mode")""$tab""$(enc "$metadata")""$tab""$(enc "$status")""$tab""$(enc "$head")""$tab""$(enc "$diff")""$tab""$(enc "$log_argument")""$tab""$(enc "$log")"
mkdir -p "$(dirname "$receipt")"
printf '%s\n' "$line" > "$receipt"
printf '%s\n' "$line"`;
}

function commitScript(request: ProtectedRepoDocsExecutionRequest, digest: string): string {
  const q = shellQuote;
  const updatedAtPlaceholder = "__NAUTILO_REPO_DOCS_UPDATED_AT__";
  const metadata = `${JSON.stringify({
    updatedAt: updatedAtPlaceholder,
    command: request.resolvedMode,
    gitHead: request.sourceHead,
    workhorseModel: request.modelId,
    finalizeModel: request.modelId,
  }, null, 2)}\n`;
  const updatedAtIndex = metadata.indexOf(updatedAtPlaceholder);
  if (updatedAtIndex < 0) {
    throw new TypeError("Protected repo docs metadata template is invalid");
  }
  const metadataBefore = metadata.slice(0, updatedAtIndex);
  const metadataAfter = metadata.slice(updatedAtIndex + updatedAtPlaceholder.length);
  return `set -eu
umask 077
${gitEnvironment()}
work_dir=$(pwd -P)
receipt="$work_dir/.git/nautilo-repo-docs/${digest}.receipt"
if [ -f "$receipt" ]; then cat "$receipt"; exit 0; fi
${gitEffectGuard()}
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = ${q(request.branch)} ]
[ "$(git rev-parse HEAD 2>/dev/null)" = ${q(request.sourceHead!)} ]
[ -d ${q(DEFAULT_WIKI_DIR)} ] && [ ! -L ${q(DEFAULT_WIKI_DIR)} ]
[ ! -L ${q(`${DEFAULT_WIKI_DIR}/.openwiki-metadata.json`)} ]
updated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
printf '%s%s%s' ${q(metadataBefore)} "$updated_at" ${q(metadataAfter)} > ${q(`${DEFAULT_WIKI_DIR}/.openwiki-metadata.json`)}
git add -- ${q(DEFAULT_WIKI_DIR)}
git diff --cached --quiet -- . ":(exclude)${DEFAULT_WIKI_DIR}" ":(exclude)${DEFAULT_WIKI_DIR}/**"
count=$(git diff --cached --name-only -- ${q(DEFAULT_WIKI_DIR)} | wc -l | tr -d ' ')
if git diff --cached --quiet -- ${q(DEFAULT_WIKI_DIR)}; then
  result_kind=no_changes
  commit_oid=-
else
  git -c user.name=Nautilo -c user.email=repo-docs@localhost commit -m 'Generate repository documentation' -- ${q(DEFAULT_WIKI_DIR)} >/dev/null 2>&1
  result_kind=committed
  commit_oid=$(git rev-parse HEAD 2>/dev/null)
fi
tab=$(printf '\t')
line=${q(RECEIPT_PREFIX)}"$tab"${q(digest)}"$tab"commit"$tab""$result_kind""$tab"${q(request.sourceHead!)}"$tab""$commit_oid""$tab""$count"
mkdir -p "$(dirname "$receipt")"
printf '%s\n' "$line" > "$receipt"
printf '%s\n' "$line"`;
}

function publishScript(request: ProtectedRepoDocsExecutionRequest, digest: string): string {
  const q = shellQuote;
  const instruction = request.publish === "pr" ? `Open a pull request from ${request.branch}.`
    : request.publish === "branch" ? `Repository documentation is ready on local branch ${request.branch}.` : null;
  return `set -eu
umask 077
${gitEnvironment()}
work_dir=$(pwd -P)
receipt="$work_dir/.git/nautilo-repo-docs/${digest}.receipt"
if [ -f "$receipt" ]; then cat "$receipt"; exit 0; fi
${gitEffectGuard()}
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = ${q(request.branch)} ]
[ "$(git rev-parse HEAD 2>/dev/null)" = ${q(request.commitOid!)} ]
remote_oid=-
if [ ${q(request.publish)} != branch ]; then
  git push --set-upstream origin "HEAD:refs/heads/${request.branch}" >/dev/null 2>&1
  remote_line=$(git ls-remote --heads origin ${q(`refs/heads/${request.branch}`)} 2>/dev/null)
  set -- $remote_line
  [ "$#" -eq 2 ] && [ "$1" = ${q(request.commitOid!)} ]
  remote_oid=$1
fi
${instruction === null ? "instruction=-" : `instruction=$(printf '%s' ${q(instruction)} | base64 | tr -d '\\n')`}
tab=$(printf '\t')
line=${q(RECEIPT_PREFIX)}"$tab"${q(digest)}"$tab"publish"$tab"${q(request.commitOid!)}"$tab""$remote_oid""$tab""$instruction"
mkdir -p "$(dirname "$receipt")"
printf '%s\n' "$line" > "$receipt"
printf '%s\n' "$line"`;
}

function scriptFor(request: ProtectedRepoDocsExecutionRequest, digest: string): string {
  return request.kind === "prepare" ? prepareScript(request, digest)
    : request.kind === "commit" ? commitScript(request, digest)
      : publishScript(request, digest);
}

function parseView(value: unknown, binding: RelayLocalExecutionBindingV4): LocalExecutionView | null {
  if (!record(value) || value["executionId"] !== binding.executionId || value["session_id"] !== binding.executionId
    || value["generation"] !== binding.generation || !["starting", "running", "cancelling", "completed", "cancelled", "failed", "unknown"].includes(String(value["state"]))
    || !(value["exitCode"] === null || Number.isSafeInteger(value["exitCode"])) || !record(value["output"])) return null;
  const output = value["output"];
  if (typeof output["data"] !== "string" || !["cursor", "nextCursor", "availableFrom", "produced"].every(key => Number.isSafeInteger(output[key]) && (output[key] as number) >= 0)
    || typeof output["gap"] !== "boolean" || typeof output["hasMore"] !== "boolean") return null;
  return value as unknown as LocalExecutionView;
}

async function dispatchAndCollect(input: ProtectedTaskRepoDocsLocalExecutionInput, request: ProtectedRepoDocsExecutionRequest,
  expected: RelayLocalExecutionBindingV4, execute: boolean): Promise<string | null> {
  let cursor = 0;
  let output = Buffer.alloc(0);
  let first = true;
  for (;;) {
    const operation = first && execute ? "start" : "read";
    const result = await input.delegated.withAdmission(operation, async source => {
      source.signal.throwIfAborted();
      input.signal.throwIfAborted();
      await input.assertCurrent();
      source.signal.throwIfAborted();
      const rebound = bindDelegatedLocalExecution({ registry: input.registry, source, state: input.state,
        invocationId: operation === "start" ? request.operationId : `${request.operationId}:read`, operation,
        previous: expected, ...(operation === "read" ? { executionId: expected.executionId } : {}) });
      const binding = copyBinding(rebound);
      if (!binding || !sameBinding(operation === "start" ? binding : { ...binding, operation: "start", invocationId: expected.invocationId }, expected)) {
        throw new TypeError("Protected repo docs relay binding changed");
      }
      const signal = AbortSignal.any([input.signal, source.signal]);
      signal.throwIfAborted();
      const dispatched = await input.registry.dispatch(expected.owner.relayId, {
        toolName: operation === "start" ? "exec_command" : "write_stdin",
        args: operation === "start"
          ? { cmd: scriptFor(request, requestDigest(request)), workdir: request.kind === "prepare" ? "." : request.relativeWorkspacePath, tty: false }
          : { session_id: expected.executionId, cursor, "yield_time_ms": 1_000 },
        impact: operation === "read" ? "read-only" : "high",
        approvalObtained: true,
        localExecutionBinding: binding,
        ...(operation === "start" ? { localExecutionActivationSignal: source.signal,
          ...(input.delegated.retain ? { retainLocalExecutionSource: () => input.delegated.retain!() } : {}) } : {}),
        signal,
      });
      await input.assertCurrent();
      signal.throwIfAborted();
      return dispatched;
    });
    if (result.status !== "ok") return null;
    const view = parseView(result.result, expected);
    if (!view || view.output.gap || view.output.cursor !== cursor
      || Buffer.byteLength(view.output.data, "utf8") !== view.output.nextCursor - view.output.cursor) return null;
    output = Buffer.concat([output, Buffer.from(view.output.data, "utf8")]);
    cursor = view.output.nextCursor;
    if (view.output.hasMore) { first = false; continue; }
    if (view.state === "completed") return view.exitCode === 0 ? output.toString("utf8") : null;
    if (["cancelled", "failed", "unknown"].includes(view.state)) return null;
    first = false;
  }
}

async function resultFromWire(request: ProtectedRepoDocsExecutionRequest, wire: ResultWireReceipt): Promise<ProtectedRepoDocsExecutionResult | null> {
  if (request.kind === "prepare" && wire.kind === "prepare") {
    if (wire.relativeWorkspacePath !== request.relativeWorkspacePath || wire.branch !== request.branch) return null;
    const gitResults = new Map<string, string>([
      [JSON.stringify(["status", "--short"]), wire.status],
      [JSON.stringify(["rev-parse", "HEAD"]), wire.head],
      [JSON.stringify(["diff", "--name-status", "HEAD"]), wire.diff],
      [wire.logArgument === "max20" ? JSON.stringify(["log", "--max-count=20", "--name-status", "--oneline"])
        : wire.logArgument.startsWith("head:") ? JSON.stringify(["log", `${wire.logArgument.slice(5)}..HEAD`, "--name-status", "--oneline"])
          : JSON.stringify(["log", "--since", wire.logArgument.slice(6), "--name-status", "--oneline"]), wire.log],
    ]);
    const surface: RepoGitSurface = {
      readFile: path => {
        if (path !== `${DEFAULT_WIKI_DIR}/.openwiki-metadata.json` || wire.metadata.length === 0) throw new Error("REPO_DOCS_METADATA_UNAVAILABLE");
        return Promise.resolve(wire.metadata);
      },
      writeFile: () => Promise.reject(new Error("REPO_DOCS_READ_ONLY_EVIDENCE")),
      git: args => Promise.resolve({ stdout: gitResults.get(JSON.stringify(args)) ?? "", stderr: "", exitCode: 0 }),
    };
    const lastUpdate = await readLastUpdate(surface);
    const gitContext = await buildGitContext(surface, wire.resolvedMode, lastUpdate);
    const brief = `${createSystemPrompt(wire.resolvedMode, DEFAULT_WIKI_DIR, "the delegated repository")}\n\n${createUserPrompt(
      wire.resolvedMode, gitContext, lastUpdate, DEFAULT_WIKI_DIR, request.instructions,
    )}`;
    return Object.freeze({ kind: "prepared", relativeWorkspacePath: wire.relativeWorkspacePath, workDir: wire.workDir,
      branch: wire.branch, sourceHead: wire.sourceHead, resolvedMode: wire.resolvedMode, brief });
  }
  if (request.kind === "commit" && wire.kind === "commit" && wire.sourceHead === request.sourceHead) {
    return Object.freeze({ kind: wire.resultKind, sourceHead: wire.sourceHead, commitOid: wire.commitOid,
      changedFileCount: wire.changedFileCount });
  }
  if (request.kind === "publish" && wire.kind === "publish" && wire.commitOid === request.commitOid) {
    return Object.freeze({ kind: "published", commitOid: wire.commitOid, remoteRefOid: wire.remoteRefOid,
      instruction: wire.instruction });
  }
  return null;
}

/** Genuine protected Task RepoDocs adapter over the already-admitted Desktop project relay. */
export function createProtectedTaskRepoDocsLocalExecutionPort(
  input: ProtectedTaskRepoDocsLocalExecutionInput,
): ProtectedRepoDocsExecutionPort {
  const owner = Object.freeze({
    ...input,
    state: freeze(structuredClone(input.state)),
    selection: freeze(structuredClone(input.selection)),
  });
  return Object.freeze({
    plan: async (request: Parameters<ProtectedRepoDocsExecutionPort["plan"]>[0]) => {
      validateRequest(owner, request);
      return await owner.delegated.withAdmission("start", async source => {
        source.signal.throwIfAborted(); owner.signal.throwIfAborted(); await owner.assertCurrent();
        const binding = copyBinding(bindDelegatedLocalExecution({ registry: owner.registry, source, state: owner.state,
          invocationId: request.operationId, operation: "start" }));
        if (!binding) return null;
        await owner.assertCurrent(); source.signal.throwIfAborted(); owner.signal.throwIfAborted();
        return Object.freeze({ requestDigest: requestDigest(request), relayBinding: binding });
      });
    },
    execute: async ({ request, plan, signal }: Parameters<ProtectedRepoDocsExecutionPort["execute"]>[0]) => {
      validateRequest(owner, request);
      if (signal.aborted) signal.throwIfAborted();
      const binding = validatePlan(request, plan);
      const output = await dispatchAndCollect({ ...owner, signal: AbortSignal.any([owner.signal, signal]) }, request, binding, true);
      if (output === null) throw new ProtectedRepoDocsOutcomeUnknownError();
      const wire = parseReceipt(output, plan.requestDigest);
      const result = wire && await resultFromWire(request, wire);
      if (!result) throw new ProtectedRepoDocsOutcomeUnknownError();
      return result;
    },
    inspect: async ({ request, plan, signal }: Parameters<ProtectedRepoDocsExecutionPort["inspect"]>[0]) => {
      try {
        validateRequest(owner, request);
        const binding = validatePlan(request, plan);
        const output = await dispatchAndCollect({ ...owner, signal: AbortSignal.any([owner.signal, signal]) }, request, binding, false);
        if (output === null) return Object.freeze({ status: "ambiguous" as const });
        const wire = parseReceipt(output, plan.requestDigest);
        const result = wire && await resultFromWire(request, wire);
        return result ? Object.freeze({ status: "confirmed" as const, result })
          : Object.freeze({ status: "ambiguous" as const });
      } catch {
        return Object.freeze({ status: "ambiguous" as const });
      }
    },
  });
}
