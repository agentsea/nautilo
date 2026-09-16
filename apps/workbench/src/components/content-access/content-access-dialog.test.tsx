import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ApiError } from "@nautilo/api-client/browser";
import type { ContentAccessSummary } from "../../lib/content-access-controller";

const sourceRoomId = "11111111-1111-4111-8111-111111111111";
const targetRoomId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const otherArtifactId = "77777777-7777-4777-8777-777777777777";
let mode: "plaintext_only" | "encrypted_only" = "plaintext_only";
const approvedPeople = [
  { actorId: "55555555-5555-4555-8555-555555555555", displayName: "Alice", userHandle: "alice" },
  { actorId: "66666666-6666-4666-8666-666666666666", displayName: "Bob", userHandle: "bob" },
];
let previewPeople = approvedPeople;
let previewActorIds = approvedPeople.map((person) => person.actorId);
let previewSkippedCount = 0;
const accessSummary: ContentAccessSummary = {
  object: { kind: "artifact" as const, id: artifactId },
  people: [{ actorId: "44444444-4444-4444-8444-444444444444", displayName: "Alice",
    userHandle: "alice", canRemove: true,
    sources: [{ kind: "immutable" as const, boundaryCount: 1 },
      { kind: "room" as const, roomId: targetRoomId, label: "Reviewers", publicRoom: false }] }],
  rooms: [{ roomId: targetRoomId, label: "Reviewers", publicRoom: false, canDetach: true }],
  otherAccessCount: 1,
};
let currentAccessSummary = accessSummary;
const getContentAccess = mock(async () => currentAccessSummary);
const prepareContentAccess = mock(async (input: { operationId: string; object: { kind: "artifact"; id: string }; change: unknown }) => ({
  outcome: "prepared" as const,
  command: input,
  previewToken: "preview-token",
  expiresAt: Date.now() + 600_000,
  preview: {
    humanActorIds: previewActorIds,
    people: previewPeople,
    targetRoomId,
    targetRoomLabel: "Reviewers",
    publicRoom: false,
    skippedAttachmentCount: previewSkippedCount,
  },
}));
const commitContentAccess = mock(async (command: { operationId: string }) => ({
  operationId: command.operationId,
  outcome: "applied" as const,
  stateChanged: true,
  originalStateChanged: true,
  replayed: false,
  attachedCount: 1,
  detachedCount: 0,
  skippedCount: 0,
}));
const searchDirectory = mock(async () => [{
  kind: "user" as const,
  id: "user-charlie",
  handle: "charlie",
  displayName: "Charlie",
  lastContactAt: null,
  actionable: true,
  actionReason: "available" as const,
}]);

mock.module("../../adapters/runtime-contexts", () => ({
  useConversationEncryptionPolicyMode: () => mode,
}));
mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewerGeneration: 1, viewer: { isVerified: true, sessionUserId: "user-owner" } }),
}));
mock.module("../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ rooms: [
    { id: sourceRoomId, label: "Current", kind: "group", roster: [
      { kind: "user", userId: "user-owner", actorId: "55555555-5555-4555-8555-555555555555", displayName: "Owner" },
    ] },
    { id: targetRoomId, label: "Reviewers", kind: "group", roster: [
      { kind: "user", userId: "user-alice", actorId: "55555555-5555-4555-8555-555555555555", displayName: "Alice" },
      { kind: "user", userId: "user-bob", actorId: "66666666-6666-4666-8666-666666666666", displayName: "Bob" },
    ] },
  ] }),
}));
mock.module("../../lib/api", () => ({ apiClient: {
  getContentAccess,
  prepareContentAccess,
  commitContentAccess,
  searchDirectory,
  getTokenProvider: () => null,
  getToken: () => null,
} }));

const { ContentAccessDialog } = await import("./content-access-dialog");
const subject = { object: { kind: "artifact" as const, id: artifactId }, label: "plan.md" };

describe("ContentAccessDialog", () => {
  beforeEach(() => {
    cleanup();
    reapplyHappyDomGlobals();
    localStorage.clear();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown,
          callback: (lock: object) => Promise<unknown>) => callback({}),
      },
    });
    mode = "plaintext_only";
    previewPeople = approvedPeople;
    previewActorIds = approvedPeople.map((person) => person.actorId);
    previewSkippedCount = 0;
    currentAccessSummary = accessSummary;
    getContentAccess.mockClear();
    prepareContentAccess.mockClear();
    commitContentAccess.mockClear();
  });

  test("does not render or load ordinary access in an encrypted mode", () => {
    mode = "encrypted_only";
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(getContentAccess).not.toHaveBeenCalled();
  });

  test("shows effective sources and keeps inaccessible access opaque", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText("Alice")).toBeTruthy();
    expect(within(dialog).getByText(/Independent access · Reviewers/)).toBeTruthy();
    expect(within(dialog).getByText(/1 other access path is preserved/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("hidden");
  });

  test("keeps one in-flight summary request across unrelated parent rerenders", async () => {
    let resolveSummary!: (summary: typeof accessSummary) => void;
    getContentAccess.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSummary = resolve;
    }));
    const view = render(<ContentAccessDialog subjects={[{ ...subject }]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    await waitFor(() => expect(getContentAccess).toHaveBeenCalledTimes(1));

    view.rerender(<ContentAccessDialog subjects={[{ ...subject }]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    view.rerender(<ContentAccessDialog subjects={[{ ...subject, label: "plan.md (updated label)" }]}
      roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    expect(getContentAccess).toHaveBeenCalledTimes(1);

    resolveSummary(accessSummary);
    expect(await within(document.body).findByText("Alice")).toBeTruthy();
    expect(getContentAccess).toHaveBeenCalledTimes(1);
  });

  test("clears current-access actions while a different object summary is pending", async () => {
    const view = render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText("Alice")).toBeTruthy();
    await within(dialog).findByRole("option", { name: /Charlie/ });
    expect(within(dialog).getByRole("button", { name: "Make private" }).hasAttribute("disabled")).toBe(false);

    getContentAccess.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(<ContentAccessDialog subjects={[{
      object: { kind: "artifact", id: otherArtifactId },
      label: "other.md",
    }]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);

    const nextDialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(within(nextDialog).queryByText("Alice")).toBeNull();
    expect(within(nextDialog).getByRole("button", { name: "Make private" }).hasAttribute("disabled")).toBe(true);
    expect(within(nextDialog).getByText(/must finish loading before this can be made private/)).toBeTruthy();
    expect(getContentAccess.mock.calls[1]?.[0]).toEqual({ kind: "artifact", id: otherArtifactId });
    await within(nextDialog).findByRole("option", { name: /Charlie/ });
  });

  test("keeps Make private visible but unavailable until current access can be loaded", async () => {
    let rejectSummary!: (error: Error) => void;
    getContentAccess.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSummary = reject;
    }));
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    const makePrivate = within(dialog).getByRole("button", { name: "Make private" });
    expect(makePrivate.hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText(/must finish loading before this can be made private/)).toBeTruthy();

    rejectSummary(new Error("Current access unavailable"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Current access unavailable");
    expect(within(dialog).getByRole("button", { name: "Make private" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText(/Reload current access before making this private/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getContentAccess).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Make private" })
      .hasAttribute("disabled")).toBe(false));
  });

  test("hides Make private only when the complete summary proves one current Human", async () => {
    currentAccessSummary = {
      ...accessSummary,
      people: [{ actorId: "44444444-4444-4444-8444-444444444444", displayName: "Owner",
        userHandle: "owner", canRemove: false,
        sources: [{ kind: "immutable", boundaryCount: 1 }] }],
      rooms: [],
      otherAccessCount: 0,
    };
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText("Private — only you")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Make private" })).toBeNull();
  });

  test("does not infer private access from an opaque or open-Room summary", async () => {
    currentAccessSummary = {
      ...accessSummary,
      people: [{ actorId: "44444444-4444-4444-8444-444444444444", displayName: "Owner",
        userHandle: "owner", canRemove: false,
        sources: [{ kind: "room", roomId: targetRoomId, label: "Public", publicRoom: true }] }],
      rooms: [{ roomId: targetRoomId, label: "Public", publicRoom: true, canDetach: true }],
      otherAccessCount: 1,
    };
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText(/1 other access path is preserved/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Make private" })).toBeTruthy();
  });

  test("never renders Memory content in the initial or review state", async () => {
    const secret = "private memory content that must stay out of access UI";
    const memorySubject = { object: { kind: "memory" as const, id: artifactId }, label: secret };
    render(<ContentAccessDialog subjects={[memorySubject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText("Memory")).toBeTruthy();
    expect(dialog.textContent).not.toContain(secret);
    fireEvent.click(within(dialog).getByRole("button", { name: "Make private" }));
    expect(await within(dialog).findByText("Review before applying")).toBeTruthy();
    expect(dialog.textContent).not.toContain(secret);
    expect(dialog.textContent).not.toContain("Memory: prepared");
  });

  test("review replaces current access and compact add controls, with safe Back before submission", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText("Current access")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Add a Room"));
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));

    expect(await within(dialog).findByText("Review before applying")).toBeTruthy();
    expect(within(dialog).queryByText("Current access")).toBeNull();
    expect(within(dialog).queryByText("Add people")).toBeNull();
    expect(within(dialog).queryByText("Add a Room")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(await within(dialog).findByText("Current access")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Apply" })).toBeNull();
    expect(commitContentAccess).not.toHaveBeenCalled();
  });

  test("allows Back after a preparation failure that was never submitted", async () => {
    prepareContentAccess.mockRejectedValueOnce(new Error("Preview unavailable"));
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.click(within(dialog).getByText("Add a Room"));
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
    expect(await within(dialog).findByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(await within(dialog).findByText("Current access")).toBeTruthy();
  });

  test("previews the complete named Room audience before applying", async () => {
    const onChanged = mock(() => {});
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={onChanged} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
    expect(await within(dialog).findByText("People who will be able to use plan.md:")).toBeTruthy();
    expect(within(dialog).getAllByText("Alice")).toHaveLength(1);
    expect(within(dialog).getByText("Bob")).toBeTruthy();
    expect(within(dialog).getByText(/people who join it in the future/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("55555555");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(commitContentAccess).toHaveBeenCalledTimes(1));
    expect(commitContentAccess.mock.calls[0]?.[1]).toBe("preview-token");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("cannot replace an uncertain operation with a new access change", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    await within(dialog).findByText("Alice");
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
    await within(dialog).findByRole("button", { name: "Apply" });
    commitContentAccess.mockRejectedValueOnce(new Error("Response lost"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await within(dialog).findByRole("button", { name: "Retry exact operation" });
    expect(within(dialog).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Detach" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Make private" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Back" })).toBeNull();
    expect(prepareContentAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry exact operation" }));
    await waitFor(() => expect(commitContentAccess).toHaveBeenCalledTimes(2));
    expect(commitContentAccess.mock.calls[1]?.[0]).toEqual(commitContentAccess.mock.calls[0]?.[0]);
    expect(commitContentAccess.mock.calls[1]?.[1]).toBe("preview-token");
  });

  test("restores after close and retries the exact submitted UUID, command, and token without preparing", async () => {
    const first = render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    let dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
    await within(dialog).findByRole("button", { name: "Apply" });
    commitContentAccess.mockRejectedValueOnce(new Error("Response lost"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await within(dialog).findByRole("button", { name: "Retry exact operation" });
    const originalCommand = commitContentAccess.mock.calls[0]?.[0];
    const originalToken = commitContentAccess.mock.calls[0]?.[1];
    expect([...Array(localStorage.length).keys()].map((index) => localStorage.getItem(localStorage.key(index)!)).join(""))
      .toContain(originalCommand.operationId);

    first.unmount();
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
      onClose={() => {}} onChanged={() => {}} />);
    dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText(/already submitted\. Check the exact saved operation/)).toBeTruthy();
    expect(prepareContentAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry exact operation" }));
    await waitFor(() => expect(commitContentAccess).toHaveBeenCalledTimes(2));
    expect(commitContentAccess.mock.calls[1]?.[0]).toEqual(originalCommand);
    expect(commitContentAccess.mock.calls[1]?.[1]).toBe(originalToken);
    expect(localStorage.length).toBe(0);
  });

  test("storage quota failure prevents the first mutation with actionable copy", async () => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    Object.defineProperty(localStorage, "setItem", {
      configurable: true,
      value: () => { throw new DOMException("quota", "QuotaExceededError"); },
    });
    try {
      render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId}
        onClose={() => {}} onChanged={() => {}} />);
      const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
      fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
      await within(dialog).findByRole("button", { name: "Apply" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
      expect(await within(dialog).findByText(/could not be saved for safe recovery/)).toBeTruthy();
      expect(commitContentAccess).not.toHaveBeenCalled();
      expect(within(dialog).queryByText(/unknown outcome/)).toBeNull();
    } finally {
      Object.defineProperty(localStorage, "setItem", {
        configurable: true,
        value: originalSetItem,
      });
    }
  });

  test("fails closed when labeled preview Actors do not exactly match the approved Actor set", async () => {
    previewPeople = [approvedPeople[0]!, {
      actorId: "77777777-7777-4777-8777-777777777777",
      displayName: "Stale roster person",
      userHandle: "stale",
    }];
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("complete approved audience names");
    expect(within(dialog).getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).not.toContain("77777777");
  });

  test("explains that a person grant is a fixed audience, not future Room membership", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Charlie/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview people access" }));
    expect(await within(dialog).findByText(/Future Room members will not automatically receive this access/)).toBeTruthy();
    expect(within(dialog).getByText("2 people in this fixed audience — show names")).toBeTruthy();
  });

  test("explains person removal without claiming complete revocation", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/Remove Alice's independent access/)).toBeTruthy();
    expect(within(dialog).getByText(/This won't remove Alice from any Room/)).toBeTruthy();
    expect(within(dialog).getByText(/Alice may still have access through: Reviewers/)).toBeTruthy();
    expect(within(dialog).getByText(/found no access paths it cannot change/)).toBeTruthy();
  });

  test("distinguishes detaching a Room from removing its current members", async () => {
    previewSkippedCount = 2;
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Detach" }));
    expect(await within(dialog).findByText(/Remove access through Reviewers from plan.md/)).toBeTruthy();
    expect(within(dialog).getByText(/Some access through this Room cannot be removed/)).toBeTruthy();
    expect(within(dialog).getByText(/Access from other Rooms or independent sharing is unchanged/)).toBeTruthy();
    expect(within(dialog).getByText(/2 access paths cannot be changed and will remain/)).toBeTruthy();
    expect(within(dialog).getByText(/2 current Room people — show names/)).toBeTruthy();
  });

  test("explains make-private preservation without promising exclusive access", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Make private" }));
    expect(await within(dialog).findByText(/Keep access for you and remove the other access paths you can manage/)).toBeTruthy();
    expect(within(dialog).getByText(/Some access may remain through paths you cannot change/)).toBeTruthy();
    expect(within(dialog).getByText(/found no access paths it cannot change/)).toBeTruthy();
  });

  test("keeps a 100-person Room audience complete behind a bounded disclosure", async () => {
    previewPeople = Array.from({ length: 100 }, (_, index) => ({
      actorId: `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      displayName: `Room person ${index + 1}`,
      userHandle: `person-${index + 1}`,
    }));
    previewActorIds = previewPeople.map((person) => person.actorId);
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));

    const disclosure = (await within(dialog).findByText("100 current people — show names")).closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(within(disclosure as HTMLElement).getByText("Room person 100")).toBeTruthy();
    fireEvent.click(within(disclosure as HTMLElement).getByText("100 current people — show names"));
    expect(disclosure?.hasAttribute("open")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
    expect((disclosure?.querySelector("ul")?.className ?? "")).toContain("max-h-48");
  });

  test("keeps 100 current-access people and their Remove controls in a bounded expanded list", async () => {
    currentAccessSummary = {
      ...accessSummary,
      people: Array.from({ length: 100 }, (_, index) => ({
        actorId: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        displayName: `Current person ${index + 1}`,
        userHandle: `current-${index + 1}`,
        canRemove: true,
        sources: [{ kind: "immutable" as const, boundaryCount: 1 }],
      })),
    };
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    const disclosure = (await within(dialog).findByText("100 people with current access")).closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(true);
    expect(within(disclosure as HTMLElement).getByText("Current person 100")).toBeTruthy();
    expect(within(disclosure as HTMLElement).getAllByRole("button", { name: "Remove" })).toHaveLength(100);
    expect((disclosure?.querySelector("ul")?.className ?? "")).toContain("max-h-48");
  });

  test("keeps transient post-commit summary failure open with an actionable Retry", async () => {
    render(<ContentAccessDialog subjects={[subject]} roomId={sourceRoomId} onClose={() => {}} onChanged={() => {}} />);
    const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
    await within(dialog).findByText("Current access");
    getContentAccess.mockRejectedValueOnce(new ApiError(503, "Temporary summary failure"));
    fireEvent.change(within(dialog).getByLabelText("Room to grant access"), { target: { value: targetRoomId } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview Room access" }));
    await within(dialog).findByRole("button", { name: "Apply" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(await within(dialog).findByText(/Use Retry current access below/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Retry current access" })).toBeTruthy();
    expect(within(document.body).getByRole("dialog", { name: "Manage access" })).toBeTruthy();
  });
});
