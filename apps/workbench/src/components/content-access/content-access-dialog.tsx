import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { useConversationEncryptionPolicyMode } from "../../adapters/runtime-contexts";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import {
  SelectablePicker,
  memberKey,
  toSelectableCandidate,
  type SelectableCandidate,
} from "../../modes/rooms/new-conversation/SelectablePicker";
import {
  ContentAccessController,
  type ContentAccessBatchEntry,
  type ContentAccessChange,
  type ContentAccessSummary,
  type ContentAccessSubject,
} from "../../lib/content-access-controller";
import {
  createBrowserContentAccessPendingOperations,
} from "../../lib/content-access-pending-operations";

const NO_AGENTS: ReadonlySet<string> = new Set();

function subjectKey(subject: ContentAccessSubject): string {
  return `${subject.object.kind}:${subject.object.id}`;
}

function subjectLabel(subject: ContentAccessSubject): string {
  return subject.object.kind === "memory" ? "Memory" : subject.label;
}

function mergeEntries(
  current: readonly ContentAccessBatchEntry[],
  replacement: readonly ContentAccessBatchEntry[],
): ContentAccessBatchEntry[] {
  const bySubject = new Map(replacement.map((entry) => [subjectKey(entry.subject), entry]));
  return current.map((entry) => bySubject.get(subjectKey(entry.subject)) ?? entry);
}

function entryOutcome(entry: ContentAccessBatchEntry): string {
  if (entry.error) return entry.error;
  if (entry.phase === "partial" && entry.receipt) {
    return `partial — ${entry.receipt.attachedCount} attached, ${entry.receipt.detachedCount} detached, ${entry.receipt.skippedCount} skipped`;
  }
  if (entry.phase === "complete" && entry.receipt) {
    return entry.receipt.outcome === "already_applied" ? "already applied" : "applied";
  }
  return entry.phase.replaceAll("_", " ");
}

function unchangedAccessCopy(count: number): string {
  return count === 0
    ? "The prepared plan found no access paths it cannot change."
    : `${count} access path${count === 1 ? "" : "s"} cannot be changed and will remain.`;
}

export interface ContentAccessDialogProps {
  subjects: readonly ContentAccessSubject[];
  roomId: string;
  onClose: () => void;
  onChanged: () => void;
  onAccessLost?: (message: string) => void;
}

/** Plaintext-only Human access manager. Parent gates are repeated here so a stale caller cannot expose it. */
export function ContentAccessDialog(props: ContentAccessDialogProps) {
  const { subjects, roomId } = props;
  const mode = useConversationEncryptionPolicyMode();
  const auth = useAuth();
  const roomNav = useRoomNavigation();
  const serverOrigin = typeof window === "undefined" ? "" : window.location.origin;
  if (mode !== "plaintext_only" || subjects.length === 0
    || !auth.viewer.isVerified || auth.viewer.sessionUserId === null) return null;
  const subjectScopeKey = subjects.map(subjectKey).sort().join(",");
  return <ContentAccessDialogSession
    key={`${serverOrigin}:${auth.viewer.sessionUserId}:${roomId}:${auth.viewerGeneration}:${mode}:${subjectScopeKey}`}
    {...props}
    auth={auth}
    roomNav={roomNav}
    serverOrigin={serverOrigin}
  />;
}

function ContentAccessDialogSession({ subjects, roomId, onClose, onChanged, onAccessLost, auth, roomNav, serverOrigin }:
  ContentAccessDialogProps & {
    auth: ReturnType<typeof useAuth>;
    roomNav: ReturnType<typeof useRoomNavigation>;
    serverOrigin: string;
  }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingState = useMemo(() => {
    try {
      return {
        store: createBrowserContentAccessPendingOperations({
          serverOrigin,
          userId: auth.viewer.sessionUserId!,
          roomId,
        }),
        error: null,
      };
    } catch (error) {
      return {
        store: null,
        error: error instanceof Error ? error.message : "Access recovery is unavailable.",
      };
    }
  }, [auth.viewer.sessionUserId, roomId, serverOrigin]);
  const controller = useMemo(
    () => new ContentAccessController(
      apiClient,
      roomId,
      undefined,
      undefined,
      pendingState.store ?? undefined,
    ),
    [pendingState.store, roomId],
  );
  const [summary, setSummary] = useState<ContentAccessSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [people, setPeople] = useState<ReadonlyMap<string, SelectableCandidate>>(new Map());
  const [targetRoomId, setTargetRoomId] = useState("");
  const restoredState = useMemo(() => {
    if (!pendingState.store) return { entries: [], error: pendingState.error };
    try {
      return { entries: controller.restore(subjects), error: null };
    } catch (error) {
      return {
        entries: [],
        error: error instanceof Error ? error.message : "Saved access recovery details could not be verified.",
      };
    }
  }, [controller, pendingState.error, pendingState.store, subjects]);
  const [entries, setEntries] = useState<ContentAccessBatchEntry[]>(restoredState.entries);
  const [change, setChange] = useState<ContentAccessChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(restoredState.error);
  const persistenceBlocked = restoredState.error !== null;
  const hasUncertainOperation = entries.some((entry) => entry.phase === "retryable");
  const single = subjects.length === 1 ? subjects[0] : undefined;
  const singleObjectKind = single?.object.kind;
  const singleObjectId = single?.object.id;

  const loadSingle = useCallback(() => {
    if (!singleObjectKind || !singleObjectId) return null;
    return controller.load({
      object: { kind: singleObjectKind, id: singleObjectId },
      // The summary request is identified by object identity; its display label
      // must not make an in-flight request stale when a parent rerenders.
      label: "",
    });
  }, [controller, singleObjectId, singleObjectKind]);

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    const request = loadSingle();
    if (!request) return;
    let current = true;
    setLoadError(null);
    void request.then((value) => { if (current) setSummary(value); })
      .catch((error: unknown) => { if (current) setLoadError(error instanceof Error ? error.message : "Could not load access"); });
    return () => { current = false; };
  }, [loadSingle]);

  const search = useCallback(async (q: string) =>
    (await apiClient.searchDirectory({ q, kind: "user" })).map(toSelectableCandidate), []);
  const selectedUserIds = new Set([...people.values()].map((person) => person.id));

  const hasExactAudience = (entry: ContentAccessBatchEntry): boolean => {
    if (!entry.preparation) return true;
    if (change?.kind === "grant_room" && !entry.preparation.preview.targetRoomLabel) return false;
    const approved = entry.preparation.preview.people;
    if (!approved) return false;
    const actorIds = [...new Set(approved.map((person) => person.actorId))].sort();
    return actorIds.length === approved.length
      && JSON.stringify(actorIds) === JSON.stringify([...entry.preparation.preview.humanActorIds].sort());
  };
  const audienceComplete = change?.kind !== "grant_people" && change?.kind !== "grant_room"
    ? true
    : entries.every(hasExactAudience);
  const removedPerson = change?.kind === "remove_person"
    ? summary?.people.find((person) => person.actorId === change.actorId)
    : undefined;
  const removedPersonLabel = removedPerson?.displayName || removedPerson?.userHandle || "Selected person";
  const retainedRoomSources = removedPerson?.sources.filter((source) => source.kind === "room") ?? [];
  const alreadyPrivate = summary !== null
    && summary.people.length === 1
    && summary.otherAccessCount === 0
    && !summary.rooms.some((room) => room.publicRoom)
    && !summary.people.some((person) => person.sources.some((source) =>
      source.kind === "room" && source.publicRoom));
  const earliestExpiry = entries.reduce<number | null>((earliest, entry) => {
    const expiresAt = entry.preparation?.expiresAt;
    return expiresAt === undefined ? earliest : earliest === null ? expiresAt : Math.min(earliest, expiresAt);
  }, null);

  async function prepare(nextChange: ContentAccessChange, retry = false) {
    if (busy || persistenceBlocked || (!retry && hasUncertainOperation)) return;
    setBusy(true);
    setResult(null);
    setChange(nextChange);
    const candidates = retry
      ? entries.filter((entry) => ["prepare_failed", "needs_prepare", "partial", "expired"].includes(entry.phase)).map((entry) => entry.subject)
      : subjects;
    try {
      const prepared = await controller.prepare(candidates, nextChange);
      setEntries((current) => retry ? mergeEntries(current, prepared) : prepared);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Could not prepare access");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (busy || !audienceComplete) return;
    setBusy(true);
    setResult(null);
    try {
      const committed = await controller.commit(entries);
      setEntries(committed);
      const terminal = committed.filter((entry) => entry.phase === "complete");
      const partial = committed.filter((entry) => entry.phase === "partial");
      if (terminal.length > 0 || partial.length > 0) onChanged();
      if (partial.length > 0) {
        const skipped = partial.reduce((sum, entry) => sum + (entry.receipt?.skippedCount ?? 0), 0);
        setResult(`${partial.length} item${partial.length === 1 ? "" : "s"} changed only partially; ${skipped} access change${skipped === 1 ? " was" : "s were"} skipped. ${single ? "Close and reopen Manage access to review the latest access." : "Reopen each item to review its current access."}`);
      } else if (committed.every((entry) => entry.phase === "complete")) {
        setResult("Access changes applied.");
      }
      if (single && (terminal.length > 0 || partial.length > 0)) {
        try {
          setSummary(await controller.load(single));
        } catch (error) {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            const message = "Access changed. This item is no longer available in the current Room.";
            onAccessLost?.(message);
            onClose();
          } else {
            setSummary(null);
            setLoadError(error instanceof Error ? error.message : "Could not refresh current access");
            setResult("Access changed, but current access could not be refreshed. Use Retry current access below before making another change.");
          }
        }
      }
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Could not apply access");
    } finally {
      setBusy(false);
    }
  }

  const retryable = entries.some((entry) => entry.phase === "retryable" || entry.phase === "prepared");
  const needsFresh = entries.some((entry) => ["prepare_failed", "needs_prepare", "partial", "expired"].includes(entry.phase));
  const canBack = entries.length > 0 && entries.every((entry) =>
    !entry.pendingOperation && !entry.receipt
    && ["prepared", "prepare_failed", "expired"].includes(entry.phase));

  function back(): void {
    if (!canBack || busy) return;
    setEntries([]);
    setChange(null);
    setResult(null);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background-panel p-5 shadow-xl">
        <h2 id={titleId} className="text-base font-semibold">Manage access</h2>
        <p className="text-xs text-foreground-muted">
          {subjects.length === 1 ? subjectLabel(subjects[0]) : `${subjects.length} selected files`}
        </p>

        {entries.length === 0 ? <>{single ? <section className="rounded border border-border p-3">
          <h3 className="text-sm font-semibold">Current access</h3>
          {loadError ? <p role="alert" className="mt-2 text-xs">{loadError} <button className="underline" onClick={() => {
            setLoadError(null);
            const request = loadSingle();
            if (!request) return;
            void request.then(setSummary).catch((error: unknown) =>
              setLoadError(error instanceof Error ? error.message : "Could not load access"));
          }}>Retry</button></p> : null}
          {!summary && !loadError ? <p role="status" className="mt-2 text-xs text-foreground-muted">Loading access…</p> : null}
          {summary ? <div className="mt-2 space-y-2 text-xs">
            <details open>
              <summary>{alreadyPrivate ? "Private — only you" : `${summary.people.length} ${summary.people.length === 1 ? "person" : "people"} with current access`}</summary>
              <ul className="mt-1 max-h-48 overflow-y-auto">{summary.people.map((person) => <li key={person.actorId} className="flex items-start justify-between gap-2 py-1">
                <span><strong>{person.displayName || person.userHandle || "Authorized person"}</strong>
                  <span className="block text-foreground-muted">{person.sources.map((source) => source.kind === "room"
                    ? `${source.label}${source.publicRoom ? " (open Room)" : ""}`
                    : `Independent access${source.boundaryCount > 1 ? ` (${source.boundaryCount} boundaries)` : ""}`).join(" · ")}</span></span>
                {person.canRemove ? <button className="underline" disabled={busy || persistenceBlocked || hasUncertainOperation}
                  onClick={() => void prepare({ kind: "remove_person", actorId: person.actorId })}>Remove</button> : null}
              </li>)}</ul>
            </details>
            <ul>{summary.rooms.map((room) => <li key={room.roomId} className="flex justify-between gap-2 py-1">
              <span>{room.label}{room.publicRoom ? " · Open Room" : ""}</span>
              {room.canDetach ? <button className="underline" disabled={busy || persistenceBlocked || hasUncertainOperation}
                onClick={() => void prepare({ kind: "detach_room", targetRoomId: room.roomId })}>Detach</button> : null}
            </li>)}</ul>
            {summary.otherAccessCount > 0 ? <p>{summary.otherAccessCount} other access path{summary.otherAccessCount === 1 ? " is" : "s are"} preserved but cannot be shown or changed here.</p> : null}
          </div> : null}
          {!alreadyPrivate ? <button className="mt-2 rounded border border-border px-2 py-1"
            disabled={!summary || busy || persistenceBlocked || hasUncertainOperation}
            onClick={() => void prepare({ kind: "make_private" })}>Make private</button> : null}
          {!summary ? <p className="mt-1 text-xs text-foreground-muted">
            {loadError
              ? "Reload current access before making this private."
              : "Current access must finish loading before this can be made private."}
          </p> : null}
        </section> : <details className="text-xs text-foreground-muted"><summary>{subjects.length} selected files</summary>
          <ul>{subjects.map((subject) => <li key={subjectKey(subject)}>{subjectLabel(subject)}</li>)}</ul>
        </details>}

          <details className="rounded border border-border p-3">
            <summary className="text-sm font-semibold">Add people</summary>
            <div className="mt-2">
            <SelectablePicker search={search} searchLabel="Search people by name or @handle"
              viewerUserId={auth.viewer.sessionUserId ?? undefined} selectedUserIds={selectedUserIds}
              selectedAgentIds={NO_AGENTS} selectedMeta={people}
              onToggle={(person) => setPeople((current) => { const next = new Map(current); const key = memberKey("user", person.id);
                if (next.has(key)) next.delete(key); else next.set(key, person); return next; })} />
            <button type="button" disabled={busy || persistenceBlocked || people.size === 0} className="mt-2 rounded bg-primary px-3 py-2 text-xs text-[var(--on-primary)] disabled:opacity-50"
              onClick={() => void prepare({ kind: "grant_people", selectedUserIds: [...people.values()].map((person) => person.id) })}>Preview people access</button>
            </div>
          </details>
          <details className="rounded border border-border p-3">
            <summary className="text-sm font-semibold">Add a Room</summary>
            <div className="mt-2">
            {roomNav.roomListError ? <p role="alert" className="mb-2 text-xs">{roomNav.roomListError} <button
              type="button" className="underline" onClick={() => void roomNav.refreshRooms()}>Retry Rooms</button></p> : null}
            <select aria-label="Room to grant access" value={targetRoomId} onChange={(event) => setTargetRoomId(event.target.value)}
              className="w-full rounded border border-border bg-background-element px-2 py-1 text-sm">
              <option value="">Choose a Room…</option>
              {roomNav.rooms.map((room) => <option key={room.id} value={room.id}>{room.label}{room.kind === "open" ? " (open)" : ""}</option>)}
            </select>
            <button type="button" disabled={busy || persistenceBlocked || !targetRoomId} className="mt-2 rounded bg-primary px-3 py-2 text-xs text-[var(--on-primary)] disabled:opacity-50"
              onClick={() => void prepare({ kind: "grant_room", targetRoomId })}>Preview Room access</button>
            </div>
          </details>
        </> : <section className="rounded border border-border p-3">
          <h3 className="text-sm font-semibold">Review before applying</h3>
          {entries.some((entry) => entry.pendingOperation && !entry.preparation) ? <p className="mt-2 text-xs">
            This access change was already submitted. Check the exact saved operation; Nautilo will not prepare or send a new change.
          </p> : (change?.kind === "grant_people" || change?.kind === "grant_room") ? <div className="mt-2 space-y-2 text-xs">
            {change.kind === "grant_room" ? <p>People in this Room now and people who join it in the future will receive access through the Room.</p>
              : <p>This creates a fixed independent audience from the current Room participants and the selected people. Future Room members will not automatically receive this access.</p>}
            {entries.filter((entry) => entry.preparation).map((entry) => <div key={subjectKey(entry.subject)}>
              {change.kind === "grant_room" ? <p>Target Room: {entry.preparation!.preview.targetRoomLabel ?? "Approved Room label unavailable"}{entry.preparation!.preview.publicRoom ? " · Open to the wider server audience" : ""}</p> : null}
              <p>People who will be able to use {subjectLabel(entry.subject)}:</p>
              {hasExactAudience(entry) ? <details>
                <summary>{entry.preparation!.preview.people!.length} {change.kind === "grant_room" ? "current people" : "people in this fixed audience"} — show names</summary>
                <ul className="mt-1 max-h-48 overflow-y-auto pl-4">{entry.preparation!.preview.people!.map((person) =>
                  <li key={person.actorId}>{person.displayName || person.userHandle || "Authorized person"}</li>)}</ul>
              </details>
                : <p role="alert">The server did not return the complete approved audience names. Prepare again before applying.</p>}
            </div>)}
          </div> : change?.kind === "remove_person" ? <div className="mt-2 space-y-2 text-xs">
            <p>Remove {removedPersonLabel}&apos;s independent access. This won&apos;t remove {removedPersonLabel} from any Room.</p>
            {retainedRoomSources.length > 0 ? <p>{removedPersonLabel} may still have access through: {retainedRoomSources.map((source) => source.label).join(", ")}.</p>
              : <p>{removedPersonLabel} may still have access through other paths.</p>}
            {entries.filter((entry) => entry.preparation).map((entry) => <p key={subjectKey(entry.subject)}>
              {subjectLabel(entry.subject)}: {unchangedAccessCopy(entry.preparation!.preview.skippedAttachmentCount)}
            </p>)}
          </div> : change?.kind === "detach_room" ? <div className="mt-2 space-y-2 text-xs">
            {entries.filter((entry) => entry.preparation).map((entry) => <div className="space-y-2" key={subjectKey(entry.subject)}>
              <p>Remove access through {entry.preparation!.preview.targetRoomLabel ?? "the selected Room"} from {subjectLabel(entry.subject)}. {entry.preparation!.preview.skippedAttachmentCount === 0
                ? "People in this Room will no longer get access from this Room attachment, including people who join later."
                : "Some access through this Room cannot be removed."} Access from other Rooms or independent sharing is unchanged.</p>
              {hasExactAudience(entry) ? <details>
                <summary>{entry.preparation!.preview.people!.length} current Room people — show names</summary>
                <ul className="mt-1 max-h-48 overflow-y-auto pl-4">{entry.preparation!.preview.people!.map((person) =>
                  <li key={person.actorId}>{person.displayName || person.userHandle || "Authorized person"}</li>)}</ul>
              </details> : null}
              <p>{unchangedAccessCopy(entry.preparation!.preview.skippedAttachmentCount)}</p>
            </div>)}
          </div> : change?.kind === "make_private" ? <div className="mt-2 space-y-2 text-xs">
            <p>Keep access for you and remove the other access paths you can manage. Some access may remain through paths you cannot change.</p>
            {entries.filter((entry) => entry.preparation).map((entry) => <p key={subjectKey(entry.subject)}>
              {subjectLabel(entry.subject)}: {unchangedAccessCopy(entry.preparation!.preview.skippedAttachmentCount)}
            </p>)}
          </div> : <p className="mt-1 text-xs">This change may preserve access paths you cannot modify. The result will report any skipped changes.</p>}
          {earliestExpiry !== null ? <p className="mt-2 text-xs text-foreground-muted">
            Preview valid until {new Date(earliestExpiry).toLocaleTimeString()}. Expired previews must be prepared again.
          </p> : null}
          <ul className="mt-2 text-xs">{entries.filter((entry) => entry.phase !== "prepared" || entry.error).map((entry) =>
            <li key={subjectKey(entry.subject)}>{subjectLabel(entry.subject)}: {entryOutcome(entry)}</li>)}</ul>
          {entries.some((entry) => entry.phase === "expired") ? <p role="alert" className="mt-2 text-xs">A preview expired. It was not applied.</p> : null}
        </section>}

        {result ? <p role="status" className="text-sm">{result}</p> : null}
        {hasUncertainOperation ? <p role="alert" className="text-sm">The previous change has an unknown outcome. Retry that exact operation before starting another access change.</p> : null}
        {entries.length > 0 && loadError ? <p role="alert" className="text-xs">Current access could not be refreshed: {loadError} <button className="underline" onClick={() => {
          setLoadError(null);
          const request = loadSingle();
          if (!request) return;
          void request.then(setSummary).catch((error: unknown) =>
            setLoadError(error instanceof Error ? error.message : "Could not load access"));
        }}>Retry current access</button></p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {entries.length === 0 ? <button type="button" disabled={busy} onClick={onClose}
            className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">Cancel</button> : <>
            {canBack ? <button type="button" disabled={busy} onClick={back}
              className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">Back</button> : null}
            {retryable ? <button type="button" disabled={busy || persistenceBlocked || !audienceComplete} onClick={() => void apply()}
              className="rounded bg-primary px-3 py-2 text-xs text-[var(--on-primary)] disabled:opacity-50">{busy ? "Applying…" : entries.some((entry) => entry.phase === "retryable") ? "Retry exact operation" : "Apply"}</button> : null}
            {needsFresh && change ? <button type="button" disabled={busy || persistenceBlocked} onClick={() => void prepare(change, true)}
              className="rounded bg-primary px-3 py-2 text-xs text-[var(--on-primary)] disabled:opacity-50">Prepare unresolved again</button> : null}
            {!canBack ? <button type="button" disabled={busy} onClick={onClose}
              className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">{result ? "Done" : "Close"}</button> : null}
          </>}
        </div>
      </div>
    </div>, document.body,
  );
}
