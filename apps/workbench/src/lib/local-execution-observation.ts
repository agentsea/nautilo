import type { DesktopLocalExecutionAPI, LocalExecutionSnapshot } from "./desktop";

type ExecutionState = LocalExecutionSnapshot["state"];
function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parseSnapshot(value: string | undefined): Record<string, unknown> | null {
  try { return value ? objectValue(JSON.parse(value)) : null; } catch { return null; }
}
function executionState(value: unknown): value is ExecutionState {
  return value === "starting" || value === "running" || value === "cancelling" ||
    value === "completed" || value === "cancelled" || value === "failed" || value === "unknown";
}

function isCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSearch(value: unknown, snapshot: Record<string, unknown>, output: Record<string, unknown>): boolean {
  const search = objectValue(value);
  const keys = ["matchedAt", "nextSearchCursor", "complete", "gap", "availableFrom", "produced"];
  if (!search || Object.keys(search).length !== keys.length || Object.keys(search).some(key => !keys.includes(key)) ||
    !(search.matchedAt === null || isCursor(search.matchedAt)) || !isCursor(search.nextSearchCursor) ||
    !isCursor(search.availableFrom) || !isCursor(search.produced) ||
    typeof search.complete !== "boolean" || typeof search.gap !== "boolean" ||
    search.availableFrom !== output.availableFrom || search.produced !== output.produced ||
    search.nextSearchCursor < search.availableFrom || search.nextSearchCursor > search.produced) return false;
  if (search.matchedAt !== null) return search.complete === false &&
    search.matchedAt >= search.availableFrom && search.matchedAt < search.produced &&
    search.nextSearchCursor > search.matchedAt && output.cursor === search.matchedAt;
  if (output.cursor !== search.produced || output.nextCursor !== search.produced || output.data !== "") return false;
  return !search.complete || (search.nextSearchCursor === search.produced &&
    (snapshot.state === "completed" || snapshot.state === "cancelled" || snapshot.state === "failed" || snapshot.state === "unknown") &&
    (snapshot.resources === "released" || snapshot.resources === "release_failed"));
}

export function parseLocalExecutionSnapshot(
  resultText: string | undefined,
): LocalExecutionSnapshot | null {
  const value = parseSnapshot(resultText);
  if (!value) return null;
  const executionId = typeof value.executionId === "string" ? value.executionId : null;
  const sessionId = typeof value.session_id === "string" ? value.session_id : null;
  const generation = typeof value.generation === "string" ? value.generation : null;
  const output = objectValue(value.output);
  const archived = value.archived === true;
  const historical = value.historical === true;
  const archivedAvailableFrom = output && isCursor(output.availableFrom) ? output.availableFrom : null;
  if (!executionId || sessionId !== executionId || !generation || !executionState(value.state) || !output ||
      ("archived" in value && value.archived !== true) ||
      ("historical" in value && value.historical !== true) ||
      (archived && historical) ||
      (archived && (value.expiresAt !== null ||
        !["completed", "cancelled", "failed", "unknown"].includes(value.state as string) ||
        (value.resources !== "released" && value.resources !== "release_failed") ||
        (value.resources === "release_failed" && value.state !== "unknown") ||
        archivedAvailableFrom === null ||
        output.cursor !== output.availableFrom || output.nextCursor !== output.produced ||
        output.hasMore !== false || output.gap !== (archivedAvailableFrom > 0))) ||
      (historical && (value.expiresAt !== null ||
        !["completed", "cancelled", "failed", "unknown"].includes(value.state as string) ||
        (value.resources !== "released" && value.resources !== "release_failed") ||
        (value.resources === "release_failed" && value.state !== "unknown"))) ||
      typeof value.tty !== "boolean" ||
      !(value.pid === null || (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0)) ||
      !(value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) ||
      !(value.signal === null || typeof value.signal === "string") ||
      value.terminationScope !== "owned_process_group" ||
      typeof output.data !== "string" || !isCursor(output.cursor) ||
      !isCursor(output.nextCursor) || !isCursor(output.availableFrom) ||
      !isCursor(output.produced) || output.cursor > output.nextCursor ||
      output.nextCursor > output.produced || output.availableFrom > output.cursor ||
      new TextEncoder().encode(output.data).byteLength !== output.nextCursor - output.cursor ||
      typeof output.gap !== "boolean" || typeof output.hasMore !== "boolean" ||
      ("search" in value && !validSearch(value.search, value, output)) ||
      !(value.failureCode === null || typeof value.failureCode === "string") ||
      !(value.expiresAt === null || (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt))) ||
      typeof value.resources !== "string" || !["pending", "owned", "released", "release_failed"].includes(value.resources)) {
    return null;
  }
  return value as unknown as LocalExecutionSnapshot;
}

export function isSettledLocalExecution(snapshot: LocalExecutionSnapshot): boolean {
  return snapshot.archived === true || (snapshot.resources === "released" &&
    (snapshot.state === "completed" || snapshot.state === "cancelled" || snapshot.state === "failed"));
}
function rank(snapshot: LocalExecutionSnapshot): number {
  if (isSettledLocalExecution(snapshot)) return 4;
  if (snapshot.state === "starting") return 0;
  if (snapshot.state === "running") return 1;
  if (snapshot.state === "cancelling") return 2;
  return 3;
}
export interface LocalExecutionObservation {
  readonly snapshot: LocalExecutionSnapshot | null;
  readonly unconfirmed: boolean;
  readonly replaceOutput: boolean;
}
type Listener = (observation: LocalExecutionObservation) => void;
type Reference = { generation: string; executionId: string };
export interface LocalExecutionHistoryOverlay extends Reference {
  readonly snapshot: LocalExecutionSnapshot & { readonly archived: true };
}

function sameTerminalTruth(a: LocalExecutionSnapshot, b: LocalExecutionSnapshot): boolean {
  if (a.state !== b.state || a.exitCode !== b.exitCode || a.signal !== b.signal) return false;
  return a.state === "unknown" || a.failureCode === b.failureCode;
}
interface Entry {
  reference: Reference;
  listeners: Set<Listener>;
  observation: LocalExecutionObservation;
  revision: number;
  disposed: boolean;
  fenced: boolean;
  queued: boolean;
  reading: boolean;
  windowRequested: boolean;
  refresh: (retainedWindow?: boolean) => void;
}
interface Hub { entries: Map<string, Entry>; unsubscribe: () => void }
const hubs = new Map<DesktopLocalExecutionAPI | undefined, Hub>();
const historyOverlays = new Map<DesktopLocalExecutionAPI | undefined, Map<string, LocalExecutionSnapshot>>();

function referenceKey(reference: Reference): string {
  return `${reference.generation}\u0000${reference.executionId}`;
}

function clearArchivedEntries(hub: Hub | undefined): void {
  if (!hub) return;
  for (const entry of hub.entries.values()) {
    if (!entry.observation.snapshot?.archived) continue;
    entry.fenced = true;
    entry.queued = false;
    entry.revision += 1;
    entry.observation = { snapshot: null, unconfirmed: true, replaceOutput: true };
    for (const notify of entry.listeners) notify(entry.observation);
  }
}

/** Publish a receipt returned by authenticated native history observation. */
export function publishLocalExecutionHistoryOverlay(
  api: DesktopLocalExecutionAPI | undefined,
  overlay: LocalExecutionHistoryOverlay,
): void {
  const snapshot = parseLocalExecutionSnapshot(JSON.stringify(overlay.snapshot));
  if (!snapshot?.archived || snapshot.generation !== overlay.generation || snapshot.executionId !== overlay.executionId) return;
  const key = referenceKey(overlay);
  const entry = hubs.get(api)?.entries.get(key);
  const previous = entry?.observation.snapshot ?? historyOverlays.get(api)?.get(key);
  if (previous && isSettledLocalExecution(previous) && !sameTerminalTruth(previous, snapshot)) return;
  if (previous && snapshot.output.produced < previous.output.produced) return;
  const overlays = historyOverlays.get(api) ?? new Map<string, LocalExecutionSnapshot>();
  overlays.set(key, snapshot);
  historyOverlays.set(api, overlays);
  if (!entry) return;
  entry.fenced = false;
  entry.queued = false;
  entry.revision += 1;
  entry.observation = { snapshot, unconfirmed: false, replaceOutput: true };
  for (const notify of entry.listeners) notify(entry.observation);
}

/** Drop authenticated history overlays when the owning Room/admission scope ends. */
export function clearLocalExecutionHistoryOverlays(api: DesktopLocalExecutionAPI | undefined): void {
  historyOverlays.delete(api);
  clearArchivedEntries(hubs.get(api));
}

/** Renderer observations only: entries exist while at least one card is mounted. */
export function observeLocalExecution(api: DesktopLocalExecutionAPI | undefined, reference: Reference, listener: Listener) {
  reference = { generation: reference.generation, executionId: reference.executionId };
  let hub = hubs.get(api);
  if (!hub) {
    const entries = new Map<string, Entry>();
    const unsubscribe = api?.onChanged?.(({ generation }) => {
      const overlays = historyOverlays.get(api);
      if (generation === null) {
        overlays?.clear();
        clearArchivedEntries(hub);
      }
      for (const entry of entries.values()) {
        if (entry.fenced) continue;
        if (entry.observation.snapshot?.archived) continue;
        if (entry.observation.snapshot && isSettledLocalExecution(entry.observation.snapshot)) continue;
        if (generation !== entry.reference.generation) {
          entry.fenced = true;
          entry.queued = false;
          entry.revision += 1;
          entry.observation = { ...entry.observation, unconfirmed: true };
          for (const notify of entry.listeners) notify(entry.observation);
        } else entry.refresh(true);
      }
    }) ?? (() => {});
    hub = { entries, unsubscribe };
    hubs.set(api, hub);
  }
  const key = referenceKey(reference);
  let entry = hub.entries.get(key);
  const emit = (target: Entry) => { for (const notify of target.listeners) notify(target.observation); };
  const publish = (target: Entry, value: LocalExecutionSnapshot, observed = false, replaceOutput = false) => {
    if (target.disposed || target.fenced) return;
    const next = parseLocalExecutionSnapshot(JSON.stringify(value));
    if (!next || next.historical === true || next.generation !== reference.generation || next.executionId !== reference.executionId) return;
    if (next.archived === true) {
      // Only a native read response may introduce history here. Ordinary tool
      // results still cannot confer archived presentation authority.
      if (api && observed) publishLocalExecutionHistoryOverlay(api, { ...reference, snapshot: { ...next, archived: true } });
      return;
    }
    // Match pages are card-local observations. They cannot replace another
    // card's full retained window or move its ordinary output paging cursor.
    if (next.search) {
      const previous = target.observation.snapshot;
      if (!api && previous) {
        // Browser results have no native read port. Share only confirmed
        // lifecycle and retention coordinates, never bytes from the match
        // page. Missing tail bytes remain explicit even after completion.
        const availableFrom = Math.max(previous.output.availableFrom, next.output.availableFrom);
        const produced = Math.max(previous.output.produced, next.output.produced);
        const bytes = new TextEncoder().encode(previous.output.data);
        const evicted = Math.min(bytes.length, Math.max(0, availableFrom - previous.output.cursor));
        const cursor = Math.max(availableFrom, previous.output.cursor + evicted);
        const nextCursor = Math.max(cursor, previous.output.nextCursor);
        const lifecycle = { ...next, output: {
          data: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(evicted)),
          cursor, nextCursor, availableFrom, produced,
          gap: previous.output.gap || evicted > 0 || availableFrom > previous.output.nextCursor,
          hasMore: nextCursor < produced,
        } };
        delete lifecycle.search;
        publish(target, lifecycle, observed, target.observation.replaceOutput);
      } else target.refresh(true);
      return;
    }
    const previous = target.observation.snapshot;
    if (previous?.archived) {
      if (!isSettledLocalExecution(next) || sameTerminalTruth(previous, next)) return;
      target.revision += 1;
      target.observation = { snapshot: previous, unconfirmed: true, replaceOutput: false };
      emit(target);
      return;
    }
    if (previous && (isSettledLocalExecution(previous) || rank(next) < rank(previous))) return;
    if (previous && (next.output.produced < previous.output.produced || next.output.availableFrom < previous.output.availableFrom)) return;
    target.revision += 1;
    target.observation = { snapshot: next, replaceOutput,
      unconfirmed: target.observation.unconfirmed && !observed && !isSettledLocalExecution(next) };
    if (isSettledLocalExecution(next)) target.queued = false;
    emit(target);
  };
  if (!entry) {
    const archived = historyOverlays.get(api)?.get(key) ?? null;
    const created: Entry = { reference, listeners: new Set(), observation: { snapshot: archived, unconfirmed: false, replaceOutput: archived !== null },
      revision: 0, disposed: false, fenced: false, queued: false, reading: false, windowRequested: false, refresh: () => {} };
    created.refresh = (retainedWindow = false) => {
      if (!api || created.disposed || created.fenced || created.observation.snapshot?.archived ||
        (created.observation.snapshot && isSettledLocalExecution(created.observation.snapshot))) return;
      created.windowRequested ||= retainedWindow;
      if (created.queued) return;
      created.queued = true;
      if (created.reading) return;
      queueMicrotask(() => {
        if (!created.queued || created.disposed || created.fenced) return;
        created.queued = false;
        created.reading = true;
        const windowRequested = created.windowRequested;
        created.windowRequested = false;
        const revision = created.revision;
        const cursor = windowRequested ? 0 : created.observation.snapshot?.output.nextCursor ?? 0;
        void api.read({ ...reference, cursor, maxBytes: Number.MAX_SAFE_INTEGER }).then((next) => {
          if (created.disposed || created.fenced) return;
          const validated = parseLocalExecutionSnapshot(JSON.stringify(next));
          if (!validated || validated.search || validated.historical === true || validated.generation !== reference.generation || validated.executionId !== reference.executionId ||
            (!validated.output.gap && !(validated.output.cursor <= cursor && validated.output.nextCursor >= cursor))) {
            throw new Error("Execution observation did not match its reference");
          }
          // A newer receipt may have arrived through another card while reading.
          if (created.revision === revision || isSettledLocalExecution(validated)) publish(created, validated, true, windowRequested);
        }).catch(() => {
          if (created.disposed || created.fenced || created.revision !== revision) return;
          created.observation = { ...created.observation, unconfirmed: true };
          emit(created);
        }).finally(() => {
          created.reading = false;
          if (created.queued) {
            created.queued = false;
            const retainedWindow = created.windowRequested;
            created.windowRequested = false;
            created.refresh(retainedWindow);
          }
        });
      });
    };
    entry = created;
    hub.entries.set(key, entry);
  }
  const current = entry;
  const currentHub = hub;
  current.listeners.add(listener);
  listener(current.observation);
  current.refresh();
  return {
    publish: (snapshot: LocalExecutionSnapshot, observed = false) => publish(current, snapshot, observed),
    refresh: current.refresh,
    unsubscribe: () => {
      current.listeners.delete(listener);
      if (current.listeners.size !== 0) return;
      current.disposed = true;
      current.queued = false;
      currentHub.entries.delete(key);
      if (currentHub.entries.size === 0) { currentHub.unsubscribe(); hubs.delete(api); }
    },
  };
}
