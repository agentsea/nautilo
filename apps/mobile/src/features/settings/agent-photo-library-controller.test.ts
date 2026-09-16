import { describe, expect, test } from "bun:test";
import { AgentPhotoLibraryApiError } from "@nautilo/api-client/browser";
import {
  AGENT_PHOTO_PRIMARY_SECTIONS,
  AGENT_PHOTO_SECONDARY_ACTIONS,
  agentPhotoLibraryCatalogueIsPresentable,
  agentPhotoMutationCompletionDisposition,
  agentPhotoLibraryLayout,
  agentPhotoMediaSource,
  AgentPhotoLibraryReadDeadlineError,
  applyAgentPhotoProjectionPage,
  cancelAgentPhotoSelection,
  confirmAgentPhotoDelete,
  createAgentPhotoIdentityKey,
  createAgentPhotoMutationCoordinator,
  finishAgentPhotoSelection,
  isRecoverableMissingCurrentAgentPhoto,
  MISSING_CURRENT_AGENT_PHOTO_WARNING,
  readAgentPhotoLibraryCatalogue,
  requestAgentPhotoDelete,
  readAgentPhotoLibraryWithDeadline,
  stageAgentPhotoSelection,
} from "./agent-photo-library-controller";
import type { AgentPhotoLibraryEntryDto } from "@nautilo/types";

const entry = (id: string): AgentPhotoLibraryEntryDto => ({
  id,
  source: "upload",
  origin: "mobile",
  createdAt: "2026-08-04T10:00:00.000Z",
  deletedAt: null,
  purgeAfter: null,
  isCurrent: false,
  media: {
    thumbnailUrl: `/api/profile/agent-photo-library/entries/${id}/media?size=thumb`,
    fullUrl: `/api/profile/agent-photo-library/entries/${id}/media?size=full`,
  },
});

describe("mobile Agent photo library interaction contract", () => {
  test("a missing legacy current photo does not make the catalogue unreadable", () => {
    expect(isRecoverableMissingCurrentAgentPhoto(new AgentPhotoLibraryApiError({
      status: 404,
      code: "photo_not_found",
      message: "The current custom Agent photo is unavailable",
      retryable: false,
    }))).toBe(true);
    expect(isRecoverableMissingCurrentAgentPhoto(new AgentPhotoLibraryApiError({
      status: 503,
      code: "photo_library_unavailable",
      message: "The photo library is temporarily unavailable",
      retryable: true,
    }))).toBe(false);
  });

  test("a missing current photo still loads every actionable catalogue surface", async () => {
    const calls: string[] = [];
    const scope = {
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      viewerUserId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      selectionRevision: "8",
      libraryRevision: "12",
    };
    const result = await readAgentPhotoLibraryCatalogue({
      readRecent: async () => {
        calls.push("recent");
        return { entries: ["recent-photo"], scope };
      },
      readCurrent: async (receivedScope) => {
        calls.push(`current:${receivedScope.libraryRevision}`);
        throw new AgentPhotoLibraryApiError({
          status: 404,
          code: "photo_not_found",
          message: "The current custom Agent photo is unavailable",
          retryable: false,
        });
      },
      readDeleted: async (receivedScope) => {
        calls.push(`deleted:${receivedScope.libraryRevision}`);
        return { entries: [] };
      },
      readPresets: async (receivedScope) => {
        calls.push(`presets:${receivedScope.libraryRevision}`);
        return { presets: ["default-one"] };
      },
      readToken: async () => {
        calls.push("token");
        return "access-token";
      },
    });

    expect(result).toEqual({
      current: null,
      currentWarning: MISSING_CURRENT_AGENT_PHOTO_WARNING,
      recent: { entries: ["recent-photo"], scope },
      deleted: { entries: [] },
      presets: { presets: ["default-one"] },
      token: "access-token",
    });
    expect(calls).toEqual([
      "recent",
      "current:12",
      "deleted:12",
      "presets:12",
      "token",
    ]);
  });

  test("never presents an unreadable library as an empty recent or presets catalogue", () => {
    expect(agentPhotoLibraryCatalogueIsPresentable({ snapshotReady: false, hasError: false })).toBe(false);
    expect(agentPhotoLibraryCatalogueIsPresentable({ snapshotReady: false, hasError: true })).toBe(false);
    expect(agentPhotoLibraryCatalogueIsPresentable({ snapshotReady: true, hasError: true })).toBe(false);
    expect(agentPhotoLibraryCatalogueIsPresentable({ snapshotReady: true, hasError: false })).toBe(true);
  });

  test("a confirmed mutation reconciles instead of replaying after its own websocket refresh", () => {
    expect(agentPhotoMutationCompletionDisposition({
      status: "applied",
      sameIdentity: true,
      sameGeneration: false,
    })).toBe("reconcile");
    expect(agentPhotoMutationCompletionDisposition({
      status: "applied",
      sameIdentity: true,
      sameGeneration: true,
    })).toBe("apply");
    expect(agentPhotoMutationCompletionDisposition({
      status: "retry",
      sameIdentity: true,
      sameGeneration: false,
    })).toBe("ignore");
    expect(agentPhotoMutationCompletionDisposition({
      status: "applied",
      sameIdentity: false,
      sameGeneration: true,
    })).toBe("ignore");
  });

  test("a stalled catalogue read reaches a finite deadline and ignores late completion", async () => {
    const controller = new AbortController();
    let deadline: (() => void) | null = null;
    let complete!: (value: string) => void;
    const lateRead = new Promise<string>((resolve) => { complete = resolve; });
    const read = readAgentPhotoLibraryWithDeadline({
      controller,
      read: async () => lateRead,
      deadlineMs: 25,
      scheduleDeadline: (callback) => {
        deadline = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearDeadline: () => undefined,
    });

    expect(deadline).not.toBeNull();
    deadline!();
    let deadlineError: unknown;
    try {
      await read;
    } catch (cause) {
      deadlineError = cause;
    }
    expect(deadlineError).toBeInstanceOf(AgentPhotoLibraryReadDeadlineError);
    expect(controller.signal.aborted).toBe(true);
    complete("too late");
    await Promise.resolve();
  });

  test("scope cleanup cancels a pending catalogue read without mislabelling a timeout", async () => {
    const controller = new AbortController();
    const read = readAgentPhotoLibraryWithDeadline({
      controller,
      read: async () => new Promise<string>(() => undefined),
      scheduleDeadline: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearDeadline: () => undefined,
    });

    controller.abort();
    let cancellationError: unknown;
    try {
      await read;
    } catch (cause) {
      cancellationError = cause;
    }
    expect(cancellationError).toMatchObject({ name: "AbortError" });
  });

  test("an already-cancelled scope never starts a catalogue read", async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;

    let cancellationError: unknown;
    try {
      await readAgentPhotoLibraryWithDeadline({
        controller,
        read: async () => {
          reads += 1;
          return "unreachable";
        },
      });
    } catch (cause) {
      cancellationError = cause;
    }
    expect(cancellationError).toMatchObject({ name: "AbortError" });
    expect(reads).toBe(0);
  });

  test("preview and cancel never imply a mutation", () => {
    const staged = stageAgentPhotoSelection(null, {
      target: { kind: "entry", entryId: "11111111-1111-4111-8111-111111111111" },
      imagePath: "/photo/full",
    });
    expect(staged?.target.kind).toBe("entry");
    expect(cancelAgentPhotoSelection()).toBeNull();
  });

  test("failed Use preserves the staged selection for retry", () => {
    const staged = stageAgentPhotoSelection(null, {
      target: { kind: "entry", entryId: "11111111-1111-4111-8111-111111111111" },
      imagePath: "/photo/full",
    });

    expect(finishAgentPhotoSelection(staged, false)).toBe(staged);
    expect(finishAgentPhotoSelection(staged, true)).toBeNull();
  });

  test("current entries cannot enter delete confirmation", () => {
    expect(requestAgentPhotoDelete({ id: "current", isCurrent: true })).toBeNull();
    expect(requestAgentPhotoDelete({ id: "older", isCurrent: false })).toBe("older");
  });

  test("delete requires confirmation for the exact entry", () => {
    expect(confirmAgentPhotoDelete("one", "two")).toBe(false);
    expect(confirmAgentPhotoDelete("one", "one")).toBe(true);
  });

  test("offline retry reuses the exact semantic operation id", async () => {
    let uuidCount = 0;
    const coordinator = createAgentPhotoMutationCoordinator(() => `operation-${++uuidCount}`);
    const attempted: string[] = [];
    const offline = Object.assign(new Error("offline"), { code: "offline", retryable: true });

    let attempt = 0;
    const originalAction = async (operationId: string) => {
      attempted.push(operationId);
      if (++attempt === 1) throw offline;
      return { prompt: "portrait", count: 4 } as const;
    };
    const first = await coordinator.run<{ prompt: "portrait"; count: 4 }>("generate:4:portrait", originalAction);
    const second = await coordinator.run<{ prompt: "portrait"; count: 4 }>("generate:4:portrait", async () => {
      throw new Error("retry replaced the immutable action");
    });

    expect(first).toMatchObject({ status: "retry", operationId: "operation-1" });
    expect(second).toMatchObject({ status: "applied", operationId: "operation-1" });
    if (second.status === "applied") expect(second.value).toEqual({ prompt: "portrait", count: 4 });
    expect(attempted).toEqual(["operation-1", "operation-1"]);
    expect(uuidCount).toBe(1);
  });

  test("an ambiguous retryable server response also retains its operation id", async () => {
    let uuidCount = 0;
    const coordinator = createAgentPhotoMutationCoordinator(() => `operation-${++uuidCount}`);
    const unavailable = Object.assign(new Error("invalid response"), {
      code: "photo_library_unavailable",
      retryable: true,
    });

    let attempt = 0;
    const action = async () => {
      if (++attempt === 1) throw unavailable;
      return "restored" as const;
    };
    expect(await coordinator.run("restore:one", action)).toMatchObject({
      status: "retry",
      operationId: "operation-1",
    });
    expect(await coordinator.run("restore:one", async () => { throw new Error("wrong action"); })).toMatchObject({ status: "applied", value: "restored" });
  });

  test("conflicts demand a canonical refresh and do not reuse the rejected operation", async () => {
    let uuidCount = 0;
    const coordinator = createAgentPhotoMutationCoordinator(() => `operation-${++uuidCount}`);
    const scope = {
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      viewerUserId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      selectionRevision: "8",
      libraryRevision: "12",
    };
    const current = { avatarRef: { kind: "preset" as const, id: "avatar-01" }, entryId: null, scope };
    const conflict = Object.assign(new Error("selection conflict"), {
      code: "selection_conflict" as const,
      retryable: false,
      scope,
      current,
    });

    expect(await coordinator.run("select:entry:one", async () => { throw conflict; })).toMatchObject({
      status: "refresh",
      operationId: "operation-1",
      scope,
      current,
    });
    expect(await coordinator.run("select:entry:one", async () => undefined)).toMatchObject({
      status: "applied",
      operationId: "operation-2",
    });
  });

  test("authentication failures are typed for app-level session recovery", async () => {
    const coordinator = createAgentPhotoMutationCoordinator(() => "operation-1");
    const result = await coordinator.run("delete:one", async () => {
      throw Object.assign(new Error("expired"), {
        code: "authentication_required" as const,
        retryable: false,
      });
    });
    expect(result).toMatchObject({
      status: "auth",
      operationId: "operation-1",
      message: "Your session has expired. Sign in again before changing Agent photos.",
    });
  });

  test("a deferred mutation excludes concurrent writes", async () => {
    const coordinator = createAgentPhotoMutationCoordinator(() => "operation-1");
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.run("upload", async () => deferred);

    expect(await coordinator.run("delete:two", async () => undefined)).toEqual({ status: "busy" });
    release();
    expect(await first).toMatchObject({ status: "applied" });
  });

  test("a rapid second tap cannot hide the first signal from scope-switch abort", async () => {
    const coordinator = createAgentPhotoMutationCoordinator(() => "operation-1");
    let firstSignal: AbortSignal | null = null;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.run("upload", async (_operationId, signal) => {
      firstSignal = signal;
      await deferred;
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    });

    expect(await coordinator.run("upload", async () => undefined)).toEqual({ status: "busy" });
    coordinator.abortAndReset();
    expect((firstSignal as AbortSignal | null)?.aborted).toBe(true);
    release();
    expect(await first).toMatchObject({ status: "failed" });
  });

  test("smallest viewport remains scrollable and keeps staged actions above the safe area", () => {
    const layout = agentPhotoLibraryLayout({
      selected: true,
      snapshotReady: true,
      busy: false,
      safeAreaBottom: 34,
      minimumBottomSpacing: 8,
    });
    expect(layout.scroll).toBe(true);
    expect(layout.stickyActions).toEqual({ visible: true, disabled: false, paddingBottom: 34 });
    expect(agentPhotoLibraryLayout({ selected: true, snapshotReady: false, busy: false, safeAreaBottom: 0, minimumBottomSpacing: 8 }).stickyActions.visible).toBe(false);
    expect(agentPhotoLibraryLayout({ selected: true, snapshotReady: true, busy: true, safeAreaBottom: 0, minimumBottomSpacing: 8 }).stickyActions).toEqual({ visible: true, disabled: true, paddingBottom: 8 });
  });

  test("locked navigation exposes four primary tabs and two secondary actions", () => {
    expect(AGENT_PHOTO_PRIMARY_SECTIONS).toEqual(["recent", "presets", "upload", "generate"]);
    expect(AGENT_PHOTO_SECONDARY_ACTIONS).toEqual(["manage", "deleted"]);
  });

  test("server and viewer identity gates both snapshots and bearer-token media", () => {
    const alpha = createAgentPhotoIdentityKey({ serverId: "alpha", viewerId: "one", viewerState: "verified" });
    const beta = createAgentPhotoIdentityKey({ serverId: "beta", viewerId: "two", viewerState: "verified" });
    const token = { identityKey: alpha, value: "alpha-secret" };
    expect(agentPhotoMediaSource({ serverUrl: "https://alpha.test/", path: "/thumb", identityKey: alpha, token })).toEqual({
      uri: "https://alpha.test/thumb",
      headers: { Authorization: "Bearer alpha-secret" },
    });
    expect(agentPhotoMediaSource({ serverUrl: "https://beta.test", path: "/thumb", identityKey: beta, token })).toEqual({ uri: "https://beta.test/thumb" });
  });

  test("recent and deleted pagination advance independently and deduplicate", () => {
    const recentOne = entry("11111111-1111-4111-8111-111111111111");
    const recentTwo = entry("22222222-2222-4222-8222-222222222222");
    const deletedOne = { ...entry("33333333-3333-4333-8333-333333333333"), deletedAt: "2026-08-04T11:00:00.000Z" };
    const initial = {
      recent: { entries: [recentOne], nextCursor: "recent-2" },
      deleted: { entries: [deletedOne], nextCursor: "deleted-2" },
    };
    const afterRecent = applyAgentPhotoProjectionPage(initial, "recent", { entries: [recentOne, recentTwo], nextCursor: "recent-3" });
    expect(afterRecent.recent).toEqual({ entries: [recentOne, recentTwo], nextCursor: "recent-3" });
    expect(afterRecent.deleted).toEqual(initial.deleted);
    const afterDeleted = applyAgentPhotoProjectionPage(afterRecent, "deleted", { entries: [], nextCursor: null });
    expect(afterDeleted.recent).toEqual(afterRecent.recent);
    expect(afterDeleted.deleted.nextCursor).toBeNull();
  });

  test("deleted entries use authenticated thumbnails with a non-image failure placeholder", async () => {
    const source = await Bun.file(new URL("../../app/(drawer)/(tabs)/settings/agent-photos.tsx", import.meta.url)).text();
    const deletedSection = source.slice(
      source.indexOf('{section === "deleted"'),
      source.indexOf("</Screen>"),
    );

    expect(deletedSection).toContain("styles.deletedPlaceholder");
    expect(deletedSection).toContain("failedDeletedMedia.has(entry.id)");
    expect(deletedSection).toContain("<Image source={source(entry.media.thumbnailUrl)}");
    expect(deletedSection).toContain("onError=");
  });

  test("screen wires canonical results, visible recovery, accessibility, and immutable drafts", async () => {
    const source = await Bun.file(new URL("../../app/(drawer)/(tabs)/settings/agent-photos.tsx", import.meta.url)).text();
    expect(source).toContain("useState<1 | 2 | 3 | 4>(1)");
    expect(source).not.toContain("useState<1 | 2 | 3 | 4>(4)");
    expect(source).toContain("setMutationLabel(input.label)");
    expect(source).toContain("setNotice(null)");
    expect(source).toContain('mutationLabel === "Generation"');
    expect(source).toContain('accessibilityLabel="Generating Agent photos"');
    expect(source).toContain("Creating your Agent photo…");
    expect(source).toContain("Your result will open in Recent.");
    expect(source).toContain('generating ? "Generating…" : `Generate ${count}`');
    expect(source).not.toContain('accessibilityLabel="Manage photos"');
    expect(source).not.toContain('section === "manage"');
    expect(source).toContain('accessibilityLabel="Selected photo actions"');
    expect(source).toContain('accessibilityLabel="Delete"');
    expect(source).toContain("Move this photo to Recently deleted?");
    expect(source).toContain('accessibilityLabel="Delete photo"');
    expect(source).toContain('accessibilityLabel="Keep photo"');
    expect(source).toContain("setSelected(null)");
    expect(source).toContain("setUploadDraft(prepared.file)");
    expect(source).toContain("Retry same upload");
    expect(source).toContain("const capturedPrompt = prompt.trim()");
    expect(source).toContain("const capturedCount = count");
    const generatePath = source.slice(source.indexOf("const generate ="), source.indexOf("const deleteEntry ="));
    expect(generatePath).not.toContain('setPrompt("")');
    expect(source).toContain("input.apply(result.value)");
    expect(source).toContain("accessibilityLiveRegion=\"assertive\"");
    expect(source).toContain("accessibilityRole=\"tab\"");
    expect(source).toContain("disabled={busy}");
    expect(source).toContain("void refreshViewer()");
    expect(source).toContain("setRetry({ label:");
    expect(source).toContain("identityRef.current !== capturedIdentityKey");
    expect(source).toContain("mutationBusy.current");
    expect(source).toContain("pageBusy.current");
    expect(source).toContain("pageController.current?.abort()");
    expect(source).toContain("signal: abort.signal");
    expect(source).toContain("pageController.current === abort");
    expect(source).toContain('cause.code === "authentication_required"');
    expect(source).toContain('cause.code === "stale_library_revision"');
    expect(source).toContain("refreshAfterError");
  });
});
