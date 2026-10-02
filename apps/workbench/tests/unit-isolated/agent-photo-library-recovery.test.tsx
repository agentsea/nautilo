import "../bun-dom-preload";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentPhotoLibraryRequestOptions, AgentPhotoLibraryMutationOptions, NautiloApiClient } from "@nautilo/api-client/browser";
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
  getAgentPhotoLibraryCurrent: mock(async (_options?: AgentPhotoLibraryRequestOptions) => ({ current: { avatarRef: { kind: "uploaded" as const, blobId: "current" }, entryId: currentId, lastUndoableRevisionId: null, scope }, scope })),
  listAgentPhotoLibrary: mock(async () => ({ entries: [entry(currentId, true), entry(otherId, false)], nextCursor: null as string | null, scope })),
  listAgentPhotoLibraryPresets: mock(async (_options?: AgentPhotoLibraryRequestOptions) => ({ presets: [], scope })),
  getAgentPhotoLibraryMedia: mock(async (_id: string, _size: "thumb" | "full", _options?: AgentPhotoLibraryRequestOptions) => ({ blob: new Blob(["image"], { type: "image/png" }), contentType: "image/png" as const })),
  selectAgentPhotoLibraryEntry: mock(async (_input: Parameters<NautiloApiClient["selectAgentPhotoLibraryEntry"]>[0], _options: AgentPhotoLibraryMutationOptions) => ({ operation: "select" as const, changed: true, currentAvatarRef: { kind: "uploaded" as const, blobId: "other" }, currentEntryId: otherId, revisionId: "66666666-6666-4666-8666-666666666666", scope: { ...scope, selectionRevision: "5", libraryRevision: "9" } })),
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
  test("keeps replacement tabs and selection usable when the current photo is unindexed", async () => {
    apiStub.getAgentPhotoLibraryCurrent.mockRejectedValue(new AgentPhotoLibraryApiError({ status: 404, code: "photo_not_found", message: "The current custom Agent photo is unavailable", retryable: false }));
    apiStub.listAgentPhotoLibrary.mockResolvedValue({ entries: [entry(currentId, true), entry(otherId, false)], nextCursor: "page-two", scope });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const changed = mock(async () => {});
    try {
      await act(async () => root.render(<Modal open onClose={() => {}} onChanged={changed} />));
      await waitFor(() => expect(host.querySelectorAll("button[data-photo-entry]").length).toBe(2));
      expect(host.textContent).toContain("Your current photo is not in the library.");
      expect(host.querySelector('[role="alert"]')).toBeNull();
      fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Presets")!);
      await waitFor(() => expect(apiStub.listAgentPhotoLibraryPresets).toHaveBeenCalledTimes(1));
      expect(apiStub.listAgentPhotoLibraryPresets.mock.calls[0]?.[0].fence).toMatchObject(scope);
      fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Recent")!);
      await waitFor(() => expect(host.querySelectorAll("button[data-photo-entry]").length).toBe(2));
      const calls = apiStub.listAgentPhotoLibrary.mock.calls.length;
      fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Load more"));
      await waitFor(() => expect(apiStub.listAgentPhotoLibrary.mock.calls.length).toBe(calls + 1));
      expect(host.textContent).toContain("Your current photo is not in the library.");
      fireEvent.click(host.querySelectorAll<HTMLButtonElement>("button[data-photo-entry]")[1]);
      fireEvent.click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Use this photo"));
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(apiStub.selectAgentPhotoLibraryEntry.mock.calls[0]?.[0]).toEqual({ target: { kind: "entry", entryId: otherId }, expectedSelectionRevision: "4", replaceMissingCurrent: true });
    } finally {
      await act(async () => root.unmount());
      host.remove();
      apiStub.listAgentPhotoLibrary.mockResolvedValue({ entries: [entry(currentId, true), entry(otherId, false)], nextCursor: null, scope });
      apiStub.getAgentPhotoLibraryCurrent.mockImplementation(async () => ({ current: { avatarRef: { kind: "uploaded" as const, blobId: "current" }, entryId: currentId, lastUndoableRevisionId: null, scope }, scope }));
    }
  });

  test("does not use catalogue recovery after an authority failure", async () => {
    apiStub.getAgentPhotoLibraryCurrent.mockRejectedValue(new AgentPhotoLibraryApiError({ status: 401, code: "authentication_required", message: "Sign in to view your photo library", retryable: false }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    try {
      await act(async () => root.render(<Modal open onClose={() => {}} onChanged={() => {}} />));
      await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sign in"));
      expect(apiStub.listAgentPhotoLibrary).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      apiStub.getAgentPhotoLibraryCurrent.mockImplementation(async () => ({ current: { avatarRef: { kind: "uploaded" as const, blobId: "current" }, entryId: currentId, lastUndoableRevisionId: null, scope }, scope }));
    }
  });

});
