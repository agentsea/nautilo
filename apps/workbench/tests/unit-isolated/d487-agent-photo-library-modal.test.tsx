import "../bun-dom-preload";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPhotoLibraryApiError } from "@nautilo/api-client/browser";

const scope = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  viewerUserId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  selectionRevision: "4",
  libraryRevision: "8",
};
const currentId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const entry = (id: string, isCurrent: boolean) => ({
  id,
  source: "upload" as const,
  origin: "workbench" as const,
  createdAt: "2026-08-04T10:00:00.000Z",
  deletedAt: null,
  purgeAfter: null,
  isCurrent,
  media: { thumbnailUrl: `/api/profile/agent-photo-library/entries/${id}/media?size=thumb` },
});
const apiStub = {
  getAgentPhotoLibraryCurrent: mock(async () => ({ current: { avatarRef: { kind: "uploaded" as const, blobId: "current" }, entryId: currentId, lastUndoableRevisionId: null, scope }, scope })),
  listAgentPhotoLibrary: mock(async () => ({ entries: [entry(currentId, true), entry(otherId, false)], nextCursor: null, scope })),
  listAgentPhotoLibraryPresets: mock(async () => ({ presets: [], scope })),
  getAgentPhotoLibraryMedia: mock(async () => ({ blob: new Blob(["image"], { type: "image/png" }), contentType: "image/png" as const })),
  selectAgentPhotoLibraryEntry: mock(async () => ({ operation: "select" as const, changed: true, currentAvatarRef: { kind: "uploaded" as const, blobId: "other" }, currentEntryId: otherId, revisionId: "66666666-6666-4666-8666-666666666666", scope: { ...scope, selectionRevision: "5", libraryRevision: "9" } })),
  undoAgentPhotoLibrarySelection: mock(async () => { throw new Error("not used"); }),
  uploadAgentPhotoLibraryEntry: mock(async () => { throw new Error("not used"); }),
  generateAgentPhotoLibraryEntries: mock(async () => { throw new Error("not used"); }),
  deleteAgentPhotoLibraryEntry: mock(async () => { throw new Error("not used"); }),
  restoreAgentPhotoLibraryEntry: mock(async () => { throw new Error("not used"); }),
};

let Modal: (typeof import("../../src/components/agent-photo-library/agent-photo-library-modal"))["AgentPhotoLibraryModal"];
let root: Root;
let host: HTMLDivElement;

beforeAll(async () => {
  mock.module("../../src/lib/api", () => ({ apiClient: apiStub }));
  ({ AgentPhotoLibraryModal: Modal } = await import("../../src/components/agent-photo-library/agent-photo-library-modal"));
});

beforeEach(() => {
  for (const value of Object.values(apiStub)) value.mockClear();
});

describe("AgentPhotoLibraryModal", () => {
  test("defaults generation to one photo and offers the full 1–4 batch range", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await waitFor(() => expect(host.textContent).toContain("Generate"));
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Generate")!);
    const radios = Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    expect(radios.map((button) => button.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Generate 1 photo");
    fireEvent.click(radios[3]!);
    await waitFor(() => expect(host.textContent).toContain("Generate 4 photos"));
    expect(radios[3]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => root.unmount());
    host.remove();
  });

  test("loads the shared library, protects current deletion, and explicitly selects another photo", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onChanged = mock(async () => {});
    const onClose = mock(() => {});
    await act(async () => root.render(<Modal open onClose={onClose} onChanged={onChanged} />));

    await waitFor(() => expect(host.querySelectorAll("button[data-photo-entry]").length).toBe(2));
    const candidates = host.querySelectorAll<HTMLButtonElement>("button[data-photo-entry]");
    fireEvent.click(candidates[1]!);
    expect(candidates[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[aria-label="Selected photo preview"]')).toBeNull();
    expect(apiStub.getAgentPhotoLibraryMedia.mock.calls.some((call) => call[0] === otherId && call[1] === "full")).toBe(false);
    const useButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Use this photo")!;
    fireEvent.click(useButton);
    await waitFor(() => expect(apiStub.selectAgentPhotoLibraryEntry).toHaveBeenCalledTimes(1));
    expect(apiStub.selectAgentPhotoLibraryEntry.mock.calls[0]?.[0]).toEqual({ target: { kind: "entry", entryId: otherId }, expectedSelectionRevision: "4" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Agent photo changed.");
    await act(async () => root.unmount());
    host.remove();
  });

  test("makes user deletion recoverable through Recently deleted", async () => {
    const deletedEntry = { ...entry(otherId, false), deletedAt: "2026-08-04T10:01:00.000Z", purgeAfter: "2026-09-03T10:01:00.000Z" };
    apiStub.listAgentPhotoLibrary.mockImplementation(async (input?: { projection?: string }) => ({
      entries: input?.projection === "deleted" ? [deletedEntry] : [entry(currentId, true), entry(otherId, false)],
      nextCursor: null,
      scope,
    }));
    apiStub.deleteAgentPhotoLibraryEntry.mockImplementation(async () => ({ operation: "delete" as const, changed: true as const, entryId: otherId, scope: { ...scope, libraryRevision: "9" } }));
    apiStub.restoreAgentPhotoLibraryEntry.mockImplementation(async () => ({ operation: "restore" as const, changed: true as const, entryId: otherId, scope: { ...scope, libraryRevision: "9" } }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await waitFor(() => expect(host.querySelectorAll("button[data-photo-entry]").length).toBe(2));
    fireEvent.click(host.querySelectorAll<HTMLButtonElement>("button[data-photo-entry]")[1]!);
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Delete")!);
    expect(apiStub.deleteAgentPhotoLibraryEntry).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Move this photo to Recently deleted?");
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Keep photo")!);
    expect(host.textContent).not.toContain("Move this photo to Recently deleted?");
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Delete")!);
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Delete photo")!);
    await waitFor(() => expect(apiStub.deleteAgentPhotoLibraryEntry).toHaveBeenCalledTimes(1));

    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Recently deleted")!);
    await waitFor(() => expect(host.textContent).toContain("Restore"));
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Restore")!);
    await waitFor(() => expect(apiStub.restoreAgentPhotoLibraryEntry).toHaveBeenCalledTimes(1));
    await act(async () => root.unmount());
    host.remove();
  });

  test("retries an offline selection with the exact same operation id", async () => {
    let attempt = 0;
    apiStub.selectAgentPhotoLibraryEntry.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new AgentPhotoLibraryApiError({
        status: 0, code: "offline", message: "Nautilo could not be reached", retryable: true,
      });
      return {
        operation: "select" as const, changed: true,
        currentAvatarRef: { kind: "uploaded" as const, blobId: "other" }, currentEntryId: otherId,
        revisionId: "66666666-6666-4666-8666-666666666666",
        scope: { ...scope, selectionRevision: "5", libraryRevision: "9" },
      };
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await waitFor(() => expect(host.querySelectorAll("button[data-photo-entry]").length).toBe(2));
    fireEvent.click(host.querySelectorAll<HTMLButtonElement>("button[data-photo-entry]")[1]!);
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Use this photo")!);
    await waitFor(() => expect(host.textContent).toContain("Retry photo change"));
    const firstOperation = apiStub.selectAgentPhotoLibraryEntry.mock.calls[0]?.[1].idempotencyKey;
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Retry photo change")!);
    await waitFor(() => expect(apiStub.selectAgentPhotoLibraryEntry).toHaveBeenCalledTimes(2));
    expect(apiStub.selectAgentPhotoLibraryEntry.mock.calls[1]?.[1].idempotencyKey).toBe(firstOperation);
    await act(async () => root.unmount());
    host.remove();
  });

  test("aborts media and revokes object URLs when the dialog unmounts", async () => {
    let mediaSignal: AbortSignal | undefined;
    apiStub.getAgentPhotoLibraryMedia.mockImplementation(async (_id, _size, options) => {
      mediaSignal = options?.signal;
      return { blob: new Blob(["image"], { type: "image/png" }), contentType: "image/png" as const };
    });
    const revoke = mock(() => {});
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = mock(() => "blob:d487-test");
    URL.revokeObjectURL = revoke;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalled();
    expect(mediaSignal?.aborted).toBe(true);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    host.remove();
  });

  test("discards a late Recent page after the user switches projections", async () => {
    let resolveRecent!: (value: { entries: ReturnType<typeof entry>[]; nextCursor: null; scope: typeof scope }) => void;
    apiStub.listAgentPhotoLibrary.mockImplementation(() => new Promise((resolve) => { resolveRecent = resolve; }));
    apiStub.listAgentPhotoLibraryPresets.mockImplementation(async () => ({
      presets: [{ id: "avatar-01", thumbnailUrl: "/api/onboarding/images/avatars/avatar-01.png" }],
      scope,
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await waitFor(() => expect(apiStub.listAgentPhotoLibrary).toHaveBeenCalled());
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Presets")!);
    await waitFor(() => expect(host.querySelector('button[aria-label="Preset avatar-01"]')).not.toBeNull());
    resolveRecent({ entries: [entry(otherId, false)], nextCursor: null, scope });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector(`button[data-photo-entry="${otherId}"]`)).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });

  test("reports a cross-client selection winner and keeps the deliberate choice", async () => {
    apiStub.listAgentPhotoLibrary.mockImplementation(async () => ({
      entries: [entry(currentId, true), entry(otherId, false)], nextCursor: null, scope,
    }));
    apiStub.selectAgentPhotoLibraryEntry.mockImplementation(async () => {
      throw new AgentPhotoLibraryApiError({
        status: 409,
        code: "selection_conflict",
        message: "A newer selection won",
        retryable: false,
        scope: { ...scope, selectionRevision: "5", libraryRevision: "9" },
        current: {
          avatarRef: { kind: "preset", id: "avatar-02" },
          entryId: null,
          lastUndoableRevisionId: null,
          scope: { ...scope, selectionRevision: "5", libraryRevision: "9" },
        },
      });
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await waitFor(() => expect(host.querySelectorAll("button[data-photo-entry]").length).toBe(2));
    fireEvent.click(host.querySelectorAll<HTMLButtonElement>("button[data-photo-entry]")[1]!);
    fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Use this photo")!);
    await waitFor(() => expect(host.textContent).toContain("changed on another device"));
    expect(host.querySelector<HTMLButtonElement>(`button[data-photo-entry="${otherId}"]`)?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => root.unmount());
    host.remove();
  });

  test("keeps generated photos visible while the Recent projection catches up", async () => {
    const generatedId = "77777777-7777-4777-8777-777777777777";
    apiStub.listAgentPhotoLibrary.mockImplementation(async () => ({
      entries: [], nextCursor: null, scope,
    }));
    apiStub.generateAgentPhotoLibraryEntries.mockImplementation(async () => ({
      operation: "create" as const,
      entryIds: [generatedId],
      entries: [{
        id: generatedId,
        source: "generation" as const,
        origin: "workbench" as const,
        createdAt: "2026-08-21T12:00:00.000Z",
        media: {
          thumbnailUrl: `/api/profile/agent-photo-library/entries/${generatedId}/media?size=thumb`,
          fullUrl: `/api/profile/agent-photo-library/entries/${generatedId}/media?size=full`,
        },
      }],
      scope: { ...scope, libraryRevision: "9" },
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const user = userEvent.setup({ document: host.ownerDocument });
    await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
    await user.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Generate")!);
    await user.type(host.querySelector<HTMLTextAreaElement>("#agent-photo-prompt")!, "A golden Agent");
    await user.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Generate 1 photo")!);
    await waitFor(() => expect(host.querySelector(`button[data-photo-entry="${generatedId}"]`)).not.toBeNull());
    expect(host.querySelector('button[aria-current="page"]')?.textContent).toBe("Recent");
    await act(async () => root.unmount());
    host.remove();
  });
});
