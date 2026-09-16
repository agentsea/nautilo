import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within, waitFor } from "@testing-library/react";
const share = mock(async (_id: string, _person: string, _opts: unknown) => ({ status: "shared" as const }));
mock.module("../../lib/api", () => ({ apiClient: { shareWorkspaceArtifact: share, searchDirectory: async () => [
  { kind: "user", id: "casey", displayName: "Casey", handle: "casey", actionable: true, actionReason: "available" },
] } }));
mock.module("../../hooks/use-auth", () => ({ useAuth: () => ({ viewer: { sessionUserId: "me" } }) }));
mock.module("../avatar/UserAvatar", () => ({ UserAvatar: () => null }));
mock.module("../composer/MentionAdapter", () => ({ MentionAgentAvatar: () => null }));
const { ShareWorkspaceDialog } = await import("./share-workspace-dialog");
const files = [{ id: "a", path: "report.pdf" }, { id: "b", path: "notes.md" }];
let screen: ReturnType<typeof within>;
beforeEach(() => { reapplyHappyDomGlobals(); screen = within(document.body); share.mockReset(); share.mockImplementation(async () => ({ status: "shared" })); });
afterEach(cleanup);
async function chooseCasey() {
  await waitFor(() => expect(screen.getByRole("option", { name: /Casey/ })).toBeTruthy());
  fireEvent.click(screen.getByRole("option", { name: /Casey/ }));
}
test("bulk scope is already selected; picker selects people only and cancellation does no work", async () => {
  const close = mock(() => {});
  render(<ShareWorkspaceDialog files={files} roomId="source" onClose={close} />);
  expect(screen.getByRole("heading", { name: "Add 2 files to workspace" })).toBeTruthy();
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  fireEvent.click(screen.getByText("2 selected files"));
  expect(screen.getByText("report.pdf")).toBeTruthy(); expect(screen.getByText("notes.md")).toBeTruthy();
  await chooseCasey(); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledTimes(1); expect(share).not.toHaveBeenCalled();
});
test("partial failure retains recipient and retries only the failed file", async () => {
  let attempt = 0;
  share.mockImplementation(async (id) => { if (id === "b" && attempt++ === 0) throw new Error("Offline"); return { status: "shared" }; });
  render(<ShareWorkspaceDialog files={files} roomId="source" onClose={() => {}} />);
  await chooseCasey(); fireEvent.click(screen.getByRole("button", { name: "Add to Casey’s workspace" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry failed deliveries" })).toBeTruthy());
  expect(share.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  expect(share.mock.calls[0]).toEqual(["a", "casey", { roomId: "source" }]);
  fireEvent.click(screen.getByRole("button", { name: "Retry failed deliveries" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 of 2 file deliveries complete"));
  expect(share.mock.calls.map((call) => call[0])).toEqual(["a", "b", "b"]);
  expect(screen.getByText(/No DM or message is sent/)).toBeTruthy();
});
test("single file uses the same picker and submits exactly that file", async () => {
  render(<ShareWorkspaceDialog files={[files[0]!]} roomId="source" onClose={() => {}} />);
  expect(screen.getByRole("heading", { name: "Add file to workspace" })).toBeTruthy();
  await chooseCasey(); fireEvent.click(screen.getByRole("button", { name: "Add to Casey’s workspace" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 of 1"));
  expect(share).toHaveBeenCalledTimes(1);
});
