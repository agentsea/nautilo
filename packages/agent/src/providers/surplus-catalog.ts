const SURPLUS_MODELS_URL = "https://api.surplusintelligence.ai/v1/models";

// Surplus documents model discovery as cacheable for one minute. The remaining
// bounds keep provider failure finite and keep caller-derived alias state small.
const CATALOG_FRESH_MS = 60_000;
const CATALOG_MAX_STALE_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUESTED_IDS = 128;
const MAX_MODEL_ID_LENGTH = 512;
const DETAIL_CONCURRENCY = 4;

export interface SurplusModelMetadata {
  readonly id: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsStreaming: boolean;
  readonly supportedParameters: readonly string[];
}

interface CatalogSnapshot {
  readonly version: number;
  readonly fetchedAt: number;
  readonly models: ReadonlyMap<string, SurplusModelMetadata>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly missingAliases: ReadonlySet<string>;
}

interface ListCandidate {
  readonly version: number;
  readonly fetchedAt: number;
  readonly models: ReadonlyMap<string, SurplusModelMetadata>;
}

interface HydrationWait {
  readonly interrupted: Promise<"deadline" | "cancelled">;
  readonly reason: () => "deadline" | "cancelled" | null;
  readonly clear: () => void;
}

interface DetailJob {
  readonly version: number;
  readonly generation: number;
  readonly controller: AbortController;
  readonly consumers: Set<symbol>;
  promise: Promise<AliasResolution>;
  settled: boolean;
}

type AliasResolution =
  | { readonly kind: "found"; readonly canonicalId: string }
  | { readonly kind: "missing" }
  | { readonly kind: "transient" };

let configuredFetch: typeof fetch | undefined;
let configuredNow: (() => number) | undefined;
let enabled = true;
let generation = 0;
let nextSnapshotVersion = 1;
let snapshot: CatalogSnapshot | null = null;
let pendingCandidate: ListCandidate | null = null;
let listRetryAt = 0;
let refreshRequired = false;
let listInflight: { readonly generation: number; readonly promise: Promise<ListCandidate | null> } | null = null;
const detailInflight = new Map<string, DetailJob>();
const activeDetailJobs = new Set<DetailJob>();
const detailRetryAt = new Map<string, { readonly version: number; readonly retryAt: number }>();
const activeControllers = new Set<AbortController>();
let activeDetailRequests = 0;
const detailWaiters: Array<{
  readonly grant: () => void;
  readonly cancel: () => void;
}> = [];

function createHydrationWait(callerSignal?: AbortSignal): HydrationWait {
  let interruption: "deadline" | "cancelled" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (reason: "deadline" | "cancelled") => void;
  const interrupted = new Promise<"deadline" | "cancelled">((resolve) => {
    finish = (reason) => {
      if (interruption !== null) return;
      interruption = reason;
      resolve(reason);
    };
    timer = setTimeout(() => {
      finish("deadline");
    }, REQUEST_TIMEOUT_MS);
  });
  const cancel = () => finish("cancelled");
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  return {
    interrupted,
    reason: () => interruption,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      callerSignal?.removeEventListener("abort", cancel);
    },
  };
}

function now(): number {
  return (configuredNow ?? Date.now)();
}

function age(timestamp: number, at: number): number {
  return Math.max(0, at - timestamp);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function exactModelId(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_MODEL_ID_LENGTH
    && value.trim() === value
    ? value
    : null;
}

function parseMetadata(row: Record<string, unknown>): SurplusModelMetadata | null {
  const id = exactModelId(row["id"]);
  const architecture = isRecord(row["architecture"]) ? row["architecture"] : null;
  const inputModalities = architecture ? stringList(architecture["input_modalities"]) : null;
  const outputModalities = architecture ? stringList(architecture["output_modalities"]) : null;
  const topProvider = isRecord(row["top_provider"]) ? row["top_provider"] : null;
  const supportedParameters = stringList(row["supported_parameters"]);
  const supportedFeatures = stringList(row["supported_features"]);
  if (!id || !inputModalities?.includes("text") || !outputModalities?.includes("text")
    || !topProvider || !supportedParameters || !supportedFeatures) return null;

  const contexts = [
    positiveInteger(row["context_length"]),
    positiveInteger(topProvider["context_length"]),
  ].filter((value): value is number => value !== null);
  const advertisedOutput = positiveInteger(topProvider["max_completion_tokens"]);
  if (contexts.length === 0 || advertisedOutput === null) return null;
  const contextTokens = Math.min(...contexts);
  const maxOutputTokens = Math.min(advertisedOutput, contextTokens);
  const parameters = Object.freeze([...supportedParameters]);

  return Object.freeze({
    id,
    contextTokens,
    maxOutputTokens,
    supportsTools: parameters.includes("tools"),
    supportsVision: inputModalities.includes("image") || supportedFeatures.includes("vision"),
    // Feature labels describe the model; only these knobs can carry reasoning
    // intent. Surplus always strips include_reasoning on the chat wire.
    supportsReasoning: parameters.includes("reasoning") || parameters.includes("reasoning_effort"),
    supportsStreaming: supportedFeatures.includes("streaming"),
    supportedParameters: parameters,
  });
}

function parseList(payload: unknown, fetchedAt: number): ListCandidate {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    throw new Error("Surplus model catalog has an invalid list envelope");
  }
  const models = new Map<string, SurplusModelMetadata>();
  const duplicateIds = new Set<string>();
  for (const value of payload["data"]) {
    if (!isRecord(value)) continue;
    const metadata = parseMetadata(value);
    if (!metadata) continue;
    if (models.has(metadata.id)) {
      duplicateIds.add(metadata.id);
      models.delete(metadata.id);
      continue;
    }
    if (!duplicateIds.has(metadata.id)) models.set(metadata.id, metadata);
  }
  if (models.size === 0) throw new Error("Surplus model catalog has no valid chat models");
  return Object.freeze({
    version: nextSnapshotVersion++,
    fetchedAt,
    models,
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Surplus model response exceeded its byte limit");
  }
  if (!response.body) throw new Error("Surplus model response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error("Surplus model response is not bytes");
      received += chunk.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) throw new Error("Surplus model response exceeded its byte limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchJson(
  url: string,
  externalSignal?: AbortSignal,
): Promise<{ readonly status: number; readonly payload?: unknown }> {
  const controller = new AbortController();
  activeControllers.add(controller);
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Surplus model discovery timed out"));
    }, REQUEST_TIMEOUT_MS);
  });
  const work = async (): Promise<{ readonly status: number; readonly payload?: unknown }> => {
    const response = await (configuredFetch ?? globalThis.fetch)(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 404 };
    }
    if (response.status !== 200 || !response.ok || response.type === "opaqueredirect") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Surplus model discovery failed with status ${response.status}`);
    }
    return { status: response.status, payload: await readBoundedJson(response) };
  };
  const workPromise = work();
  workPromise.catch(() => undefined);
  try {
    return await Promise.race([workPromise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
    activeControllers.delete(controller);
  }
}

function usableSnapshot(at: number): CatalogSnapshot | null {
  return snapshot && age(snapshot.fetchedAt, at) <= CATALOG_MAX_STALE_MS ? snapshot : null;
}

async function fetchList(capturedGeneration: number): Promise<ListCandidate | null> {
  try {
    const result = await fetchJson(SURPLUS_MODELS_URL);
    if (result.status !== 200) throw new Error("Surplus model list was not found");
    const candidate = parseList(result.payload, now());
    if (generation !== capturedGeneration || !enabled) return null;
    pendingCandidate = candidate;
    refreshRequired = false;
    listRetryAt = 0;
    return candidate;
  } catch {
    if (generation === capturedGeneration) listRetryAt = now() + RETRY_BACKOFF_MS;
    return null;
  }
}

async function acquireDetailSlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (activeDetailRequests < DETAIL_CONCURRENCY) {
    activeDetailRequests += 1;
    return true;
  }
  // A release transfers its occupied slot directly to this waiter. Reserving
  // before wakeup prevents a newly arriving request from overtaking the queue.
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const remove = () => {
      const index = detailWaiters.indexOf(waiter);
      if (index >= 0) detailWaiters.splice(index, 1);
      signal.removeEventListener("abort", waiter.cancel);
    };
    const waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        remove();
        resolve(true);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        remove();
        resolve(false);
      },
    };
    detailWaiters.push(waiter);
    signal.addEventListener("abort", waiter.cancel, { once: true });
    if (signal.aborted) waiter.cancel();
  });
}

function releaseDetailSlot(): void {
  const waiter = detailWaiters.shift();
  if (waiter) waiter.grant();
  else activeDetailRequests -= 1;
}

async function resolveAliasUncached(
  requestedId: string,
  candidate: ListCandidate,
  capturedGeneration: number,
  jobSignal: AbortSignal,
): Promise<AliasResolution> {
  const acquired = await acquireDetailSlot(jobSignal);
  if (!acquired) return { kind: "transient" };
  try {
    if (jobSignal.aborted || generation !== capturedGeneration || !enabled) return { kind: "transient" };
    const result = await fetchJson(
      `${SURPLUS_MODELS_URL}/${encodeURIComponent(requestedId)}`,
      jobSignal,
    );
    if (result.status === 404) return { kind: "missing" };
    if (!isRecord(result.payload)) return { kind: "transient" };
    const canonicalId = exactModelId(result.payload["id"]);
    if (!canonicalId || !candidate.models.has(canonicalId)) return { kind: "missing" };
    return { kind: "found", canonicalId };
  } catch {
    return { kind: "transient" };
  } finally {
    releaseDetailSlot();
  }
}

function matchingDetailJob(
  requestedId: string,
  candidate: ListCandidate,
  capturedGeneration: number,
): DetailJob | null {
  const inflight = detailInflight.get(requestedId);
  if (inflight?.version === candidate.version && inflight.generation === capturedGeneration) {
    return inflight;
  }
  return null;
}

function attachDetailJob(
  requestedId: string,
  candidate: ListCandidate,
  capturedGeneration: number,
  consumer: symbol,
): DetailJob {
  const existing = matchingDetailJob(requestedId, candidate, capturedGeneration);
  if (existing) {
    existing.consumers.add(consumer);
    return existing;
  }
  const controller = new AbortController();
  const job: DetailJob = {
    version: candidate.version,
    generation: capturedGeneration,
    controller,
    consumers: new Set([consumer]),
    promise: Promise.resolve({ kind: "transient" }),
    settled: false,
  };
  detailInflight.set(requestedId, job);
  activeDetailJobs.add(job);
  const promise = resolveAliasUncached(requestedId, candidate, capturedGeneration, controller.signal);
  job.promise = promise;
  promise.finally(() => {
    job.settled = true;
    activeDetailJobs.delete(job);
    if (detailInflight.get(requestedId) === job) detailInflight.delete(requestedId);
  }).catch(() => undefined);
  return job;
}

function detachDetailJob(requestedId: string, job: DetailJob, consumer: symbol): boolean {
  job.consumers.delete(consumer);
  if (job.settled || job.consumers.size > 0) return false;
  job.controller.abort();
  if (detailInflight.get(requestedId) === job) detailInflight.delete(requestedId);
  return true;
}

async function candidateForHydration(force: boolean, capturedGeneration: number): Promise<ListCandidate | null> {
  const at = now();
  if (!force) {
    if (!refreshRequired && pendingCandidate && age(pendingCandidate.fetchedAt, at) < CATALOG_FRESH_MS) {
      return pendingCandidate;
    }
    if (!refreshRequired && snapshot && age(snapshot.fetchedAt, at) < CATALOG_FRESH_MS) {
      return { version: snapshot.version, fetchedAt: snapshot.fetchedAt, models: snapshot.models };
    }
    if (at < listRetryAt) {
      const stale = usableSnapshot(at);
      return stale ? { version: stale.version, fetchedAt: stale.fetchedAt, models: stale.models } : null;
    }
  }
  if (listInflight?.generation === capturedGeneration) {
    const shared = await listInflight.promise;
    if (shared) return shared;
    const stale = usableSnapshot(now());
    return stale ? { version: stale.version, fetchedAt: stale.fetchedAt, models: stale.models } : null;
  }
  const promise = fetchList(capturedGeneration);
  listInflight = { generation: capturedGeneration, promise };
  const candidate = await promise;
  if (listInflight?.promise === promise) listInflight = null;
  if (candidate) return candidate;
  const stale = usableSnapshot(now());
  return stale ? { version: stale.version, fetchedAt: stale.fetchedAt, models: stale.models } : null;
}

function requestedIdsOrThrow(requestedIds: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const id of requestedIds) {
    if (exactModelId(id) === null) throw new TypeError("Surplus model ids must be exact non-empty strings");
    unique.add(id);
  }
  if (unique.size > MAX_REQUESTED_IDS) {
    throw new RangeError(`Surplus model hydration accepts at most ${MAX_REQUESTED_IDS} unique ids`);
  }
  return [...unique];
}

function trimAliasCaches(
  aliases: Map<string, string>,
  missingAliases: Set<string>,
  requestedIds: readonly string[],
): void {
  const priority = new Set(requestedIds);
  const keys = [...aliases.keys(), ...missingAliases.keys()];
  let excess = keys.length - MAX_REQUESTED_IDS;
  if (excess <= 0) return;
  for (const id of keys) {
    if (excess <= 0) break;
    if (priority.has(id)) continue;
    aliases.delete(id);
    missingAliases.delete(id);
    detailRetryAt.delete(id);
    excess -= 1;
  }
  for (const id of keys) {
    if (excess <= 0) break;
    if (!aliases.has(id) && !missingAliases.has(id)) continue;
    aliases.delete(id);
    missingAliases.delete(id);
    detailRetryAt.delete(id);
    excess -= 1;
  }
}

function recordDetailRetry(requestedId: string, version: number): void {
  if (!detailRetryAt.has(requestedId) && detailRetryAt.size >= MAX_REQUESTED_IDS) {
    const oldest = detailRetryAt.keys().next().value;
    if (oldest !== undefined) detailRetryAt.delete(oldest);
  }
  detailRetryAt.set(requestedId, {
    version,
    retryAt: now() + RETRY_BACKOFF_MS,
  });
}

/**
 * Refresh the public Surplus chat-model snapshot and resolve only caller-owned
 * exact ids. Provider failures are availability misses: a valid bounded-age
 * snapshot remains readable, while an expired snapshot fails closed.
 */
export async function hydrateSurplusModelCatalog(
  requestedIds: readonly string[] = [],
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const exactIds = requestedIdsOrThrow(requestedIds);
  if (!enabled || options.signal?.aborted) return;
  const capturedGeneration = generation;
  const wait = createHydrationWait(options.signal);
  const consumer = Symbol("surplus-catalog-hydration");
  const attachedJobs = new Map<string, DetailJob>();
  let jobsDetached = false;
  try {
    const candidate = await Promise.race([
      candidateForHydration(options.force === true, capturedGeneration),
      wait.interrupted.then(() => null),
    ]);
    if (!candidate || generation !== capturedGeneration || !enabled) return;

    const current = snapshot?.version === candidate.version ? snapshot : null;
    const aliases = new Map(current?.aliases ?? []);
    const missingAliases = new Set(current?.missingAliases ?? []);
    const aliasIds = exactIds.filter((id) => !candidate.models.has(id));
    const settledIds = new Set<string>();
    const aliasWork = wait.reason() === null ? Promise.all(aliasIds.map(async (requestedId) => {
      if (aliases.has(requestedId) || missingAliases.has(requestedId)) {
        settledIds.add(requestedId);
        return;
      }
      const existing = matchingDetailJob(requestedId, candidate, capturedGeneration);
      const retry = detailRetryAt.get(requestedId);
      if (!existing && retry?.version === candidate.version && now() < retry.retryAt) {
        settledIds.add(requestedId);
        return;
      }
      const job = attachDetailJob(
        requestedId,
        candidate,
        capturedGeneration,
        consumer,
      );
      attachedJobs.set(requestedId, job);
      const resolution = await job.promise;
      if (wait.reason() !== null || generation !== capturedGeneration || !enabled) return;
      settledIds.add(requestedId);
      if (resolution.kind === "found") {
        aliases.set(requestedId, resolution.canonicalId);
        missingAliases.delete(requestedId);
        detailRetryAt.delete(requestedId);
      } else if (resolution.kind === "missing") {
        missingAliases.add(requestedId);
        aliases.delete(requestedId);
        detailRetryAt.delete(requestedId);
      } else {
        recordDetailRetry(requestedId, candidate.version);
      }
    })) : Promise.resolve([]);
    aliasWork.catch(() => undefined);
    await Promise.race([aliasWork, wait.interrupted]);
    const interruption = wait.reason();
    for (const [requestedId, job] of attachedJobs) {
      const orphaned = detachDetailJob(requestedId, job, consumer);
      if (orphaned && interruption === "deadline" && !settledIds.has(requestedId)) {
        recordDetailRetry(requestedId, candidate.version);
      }
    }
    jobsDetached = true;
    if (generation !== capturedGeneration || !enabled) return;
    // A slower hydration from this generation must not roll the catalog back
    // after a forced refresh has already published a newer list snapshot.
    if (snapshot && snapshot.version > candidate.version) return;

    // A concurrent hydration may have published other exact aliases for this
    // same list. Merge them without carrying aliases across list snapshots.
    if (snapshot?.version === candidate.version) {
      for (const [id, canonicalId] of snapshot.aliases) if (!missingAliases.has(id)) aliases.set(id, canonicalId);
      for (const id of snapshot.missingAliases) if (!aliases.has(id)) missingAliases.add(id);
    }
    trimAliasCaches(aliases, missingAliases, exactIds);
    snapshot = Object.freeze({
      version: candidate.version,
      fetchedAt: candidate.fetchedAt,
      models: candidate.models,
      aliases: new Map(aliases),
      missingAliases: new Set(missingAliases),
    });
    if (pendingCandidate?.version === candidate.version) pendingCandidate = null;
  } finally {
    if (!jobsDetached) {
      for (const [requestedId, job] of attachedJobs) detachDetailJob(requestedId, job, consumer);
    }
    wait.clear();
  }
}

/** Read one already-hydrated exact canonical id or confirmed exact alias. */
export function getSurplusModelMetadataSync(requestedId: string): SurplusModelMetadata | null {
  if (!enabled || exactModelId(requestedId) === null) return null;
  const current = usableSnapshot(now());
  if (!current) return null;
  const direct = current.models.get(requestedId);
  if (direct) return direct;
  const canonicalId = current.aliases.get(requestedId);
  return canonicalId ? current.models.get(canonicalId) ?? null : null;
}

/** Replace discovery dependencies and clear all state under a new generation. */
export function configureSurplusModelCatalog(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  enabled?: boolean;
}): void {
  clearState();
  configuredFetch = options.fetchImpl;
  configuredNow = options.now;
  enabled = options.enabled ?? true;
}

function clearState(): void {
  generation += 1;
  for (const controller of activeControllers) controller.abort();
  for (const job of activeDetailJobs) job.controller.abort();
  activeControllers.clear();
  snapshot = null;
  pendingCandidate = null;
  listRetryAt = 0;
  refreshRequired = false;
  listInflight = null;
  detailInflight.clear();
  detailRetryAt.clear();
  nextSnapshotVersion = 1;
}

/** Restore production defaults and fence any in-flight generation. */
export function resetSurplusModelCatalog(): void {
  clearState();
  configuredFetch = undefined;
  configuredNow = undefined;
  enabled = true;
}

/**
 * Fence current discovery work and require the next hydration to refresh.
 * The bounded-age last-known-good snapshot remains synchronously readable.
 */
export function invalidateSurplusModelCatalog(): void {
  generation += 1;
  for (const controller of activeControllers) controller.abort();
  for (const job of activeDetailJobs) job.controller.abort();
  activeControllers.clear();
  pendingCandidate = null;
  listRetryAt = 0;
  refreshRequired = true;
  listInflight = null;
  detailInflight.clear();
  detailRetryAt.clear();
}
