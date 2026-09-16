import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { MemoryDetailResponse } from "@nautilo/api-client/browser";

let generation = 1;
let memoryId = "memory-1";
let context: MemoryDetailResponse["accessContext"] = { roomId: "library-room", label: "Personal library" };
let holdDetail: Promise<void> | undefined;
let lastActiveRoom = "unrelated-group-room";
const viewer = { isVerified: true, staleWhoami: false, sessionUserId: "human-user", sessionActorId: "human-actor" };
const item = { id: "memory-1", type: "fact", content: "A private library Memory", importance: 0.5,
  tier: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  demotedAt: null, demotedFrom: null, namespaceIds: ["private-namespace"] };
const reads = {
  list: async () => ({ items: [item], nextCursor: null, memoryMode: "namespace" }),
  detail: async (id: string) => {
    const selected = context;
    await holdDetail;
    return { memory: { ...item, id }, memoryMode: "namespace", accessContext: selected,
      actions: { canManageAccess: true, canEditContent: true, canChangeTier: false, deletion: "permanent",
        retentionNotice: "Archive hides from the agent" } };
  },
  retryPendingMutations: async () => {},
  dispose: async () => {},
};
const noop = async () => {};
mock.module("../../src/hooks/use-auth", () => ({ useAuth: () => ({ viewer, viewerGeneration: generation }) }));
mock.module("../../src/hooks/use-can", () => ({ useCan: () => () => true }));
mock.module("react-router-dom", () => ({ useNavigate: () => () => {}, useParams: () => ({ id: memoryId }) }));
mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ activeRoomId: lastActiveRoom }),
}));
mock.module("../../src/adapters/runtime-contexts", () => ({ useConversationEncryptionPolicyMode: () => "plaintext_only" }));
mock.module("../../src/components/toast", () => ({ useToast: () => ({ show: () => {} }) }));
mock.module("../../src/lib/api", () => ({ apiClient: { listDirectoryHumans: async () => [] } }));
mock.module("../../src/lib/desktop", () => ({ isDesktop: false, desktopAPI: null }));
mock.module("../../src/lib/encryption-data-operation-policy", () => ({ createWorkbenchDataOperationOwner: () => ({}) }));
mock.module("../../src/lib/memory-read-operations", () => ({ createWorkbenchMemoryReadOperations: () => reads }));
mock.module("../../src/lib/memory-api", () => ({
  archiveMemory: noop, fetchMemories: noop, fetchMemory: noop, fetchPromptBriefReadOnly: noop,
  grantMemory: noop, hardDeleteMemory: noop, makeMemoryPrivate: noop, revokeMemory: noop,
  searchMemories: noop, updateMemory: noop, MemoryHardDeleteConflictError: class extends Error {},
}));
mock.module("../../src/components/content-access/content-access-dialog", () => ({
  ContentAccessDialog: ({ roomId }: { roomId: string }) => <div data-testid="access-dialog">{roomId}</div>,
}));
const { MemoryPage } = await import("../../src/pages/memory/memory-page");

beforeEach(() => {
  reapplyHappyDomGlobals();
  generation = 1;
  memoryId = "memory-1";
  context = { roomId: "library-room", label: "Personal library" };
  holdDetail = undefined;
  lastActiveRoom = "unrelated-group-room";
});
afterEach(cleanup);

test("shows and submits the authorized library context instead of the last active conversation", async () => {
  const view = render(<MemoryPage />);
  await waitFor(() => expect(view.getByText("Access context: Personal library")).toBeTruthy());
  fireEvent.click(view.getByText("Manage access…"));
  expect(view.getByTestId("access-dialog").textContent).toBe("library-room");
  lastActiveRoom = "another-unrelated-room";
  view.rerender(<MemoryPage />);
  expect(view.getByTestId("access-dialog").textContent).toBe("library-room");
});

test("missing server context does not manufacture a last-Room or private-Room fallback", async () => {
  context = undefined;
  const view = render(<MemoryPage />);
  await waitFor(() => expect(view.getByText("Reload this Memory to resolve its access context.")).toBeTruthy());
  expect(view.queryByText("Manage access…")).toBeNull();
});

test("a refreshed admission drops the old context until the new detail resolves", async () => {
  const view = render(<MemoryPage />);
  await waitFor(() => expect(view.getByText("Manage access…")).toBeTruthy());
  fireEvent.click(view.getByText("Manage access…"));
  let release!: () => void;
  holdDetail = new Promise<void>((resolve) => { release = resolve; });
  context = { roomId: "new-admitted-room", label: "New library context" };
  generation += 1;
  view.rerender(<MemoryPage />);
  expect(view.queryByTestId("access-dialog")).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect(view.getByText("Access context: New library context")).toBeTruthy());
  fireEvent.click(view.getByText("Manage access…"));
  expect(view.getByTestId("access-dialog").textContent).toBe("new-admitted-room");
});

test("late detail for a previous Memory cannot bind its Room to the next Memory", async () => {
  let release!: () => void;
  holdDetail = new Promise<void>((resolve) => { release = resolve; });
  const view = render(<MemoryPage />);
  await act(async () => { await Promise.resolve(); });
  memoryId = "memory-2";
  context = { roomId: "second-room", label: "Second Memory context" };
  holdDetail = undefined;
  view.rerender(<MemoryPage />);
  await waitFor(() => expect(view.getByText("Access context: Second Memory context")).toBeTruthy());
  await act(async () => { release(); });
  expect(view.queryByText("Access context: Personal library")).toBeNull();
  fireEvent.click(view.getByText("Manage access…"));
  expect(view.getByTestId("access-dialog").textContent).toBe("second-room");
});
