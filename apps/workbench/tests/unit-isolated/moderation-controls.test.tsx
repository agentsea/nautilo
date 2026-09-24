import "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import type { ModerationCommand, ModerationReceipt, ServerModerationPolicy } from "@nautilo/types";

const personId = "11111111-1111-4111-8111-111111111111";
const person = { userId: personId, displayName: "Fixture member", roomId: null, targetRevision: "opaque-revision", protectedTarget: false, allowedActions: ["ban", "kick", "lift"] };
let policy: ServerModerationPolicy;
const getPolicy = mock(async () => policy);
const updatePolicy = mock(async (input: ServerModerationPolicy) => ({ ...input, revision: input.revision + 1, auditRecorded: true }));
const apply = mock(async (input: ModerationCommand): Promise<ModerationReceipt> => ({ ...input, restrictionId: personId,
  createdAt: new Date().toISOString(), committed: true, replayed: false, auditRecorded: true, converged: false }));
const inspect = mock(async (_target: { userId: string } | { handle: string }) => ({ person, restrictions: [] }));
const decide = mock(async (_input: unknown) => ({ ok: true, auditRecorded: true }));
let requests: { items: { inviteId: string; userId: string; displayName: string; handle: string; message: string; state: string; revision: number }[]; next: { inviteId: string; userId: string } | null };
const reviews = mock(async (_after?: { inviteId: string; userId: string }, _search?: string) => requests);
const searchPeople = mock(async (_search: string, _after?: string) => ({ items: [{ userId: personId, displayName: "Fixture member", handle: "fixture_member" }], next: null as string | null }));
mock.module("../../src/lib/api", () => ({ apiClient: {
  getModerationPolicy: getPolicy, updateModerationPolicy: updatePolicy,
  getModerationPerson: inspect, applyModeration: apply,
  listEnrollmentReviews: reviews, searchModerationPeople: searchPeople, decideEnrollmentReview: decide,
} }));
mock.module("../../src/hooks/use-can", () => ({ useCan: () => () => true }));
const { ModerationSection } = await import("../../src/pages/admin/sections/moderation-section");
const { ModerationPersonControls } = await import("../../src/pages/admin/sections/moderation-person-controls");
beforeEach(() => {
  reapplyHappyDomGlobals(); policy = { enabled: true, joinsPaused: true, approvalRequired: true, revision: 7 };
  requests = { items: [], next: null }; getPolicy.mockClear(); updatePolicy.mockClear(); apply.mockClear(); decide.mockClear(); reviews.mockClear(); searchPeople.mockClear(); inspect.mockClear();
});
afterEach(cleanup);

test("resuming joins preserves required approval; disabling controls preserves the pause", async () => {
  const view = render(<MemoryRouter><ModerationSection /></MemoryRouter>);
  fireEvent.click(await view.findByText("Resume joins"));
  await waitFor(() => expect(updatePolicy).toHaveBeenCalledWith({ ...policy, joinsPaused: false }));
  await view.findByText("Pause all new joins");
  fireEvent.click(view.getByText("Pause all new joins"));
  await view.findByText("Resume joins");
  fireEvent.click(view.getByText("Disable moderation controls"));
  await waitFor(() => expect(updatePolicy.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, joinsPaused: true, approvalRequired: true }));
});

test("joining messages are rendered as text and decisions retain the exact review revision", async () => {
  const item = { inviteId: personId, userId: personId, displayName: "Applicant", handle: "applicant", message: "<script>approve me</script>", state: "pending", revision: 3 };
  requests = { items: [item], next: null };
  const view = render(<MemoryRouter><ModerationSection /></MemoryRouter>);
  fireEvent.click(await view.findByRole("tab", { name: "Joining requests" }));
  await view.findByText(item.message); expect(view.container.querySelector("script")).toBeNull();
  fireEvent.click(view.getByText("Approve"));
  await waitFor(() => expect(decide).toHaveBeenCalledWith({ inviteId: personId, userId: personId, revision: 3, decision: "approved" }));
});

test("a lost ban response retries the exact operation and never claims cleanup is complete", async () => {
  apply.mockImplementationOnce(async () => { throw new Error("Response lost"); });
  const view = render(<ModerationPersonControls userId={personId} enabled />);
  fireEvent.click(await view.findByText("Ban from Server"));
  const { default: userEvent } = await import("@testing-library/user-event");
  await userEvent.setup({ document }).type(view.getByLabelText("Reason"), "Repeated abuse");
  fireEvent.submit(view.getByLabelText("Reason").closest("form")!);
  await view.findByText("Retry same action");
  const original = apply.mock.calls[0]?.[0];
  fireEvent.submit(view.getByLabelText("Reason").closest("form")!);
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  expect(apply.mock.calls[1]?.[0]).toEqual(original);
  await view.findByText(/Connection and running-work cleanup is still pending/);
});


test("request pagination replaces rows and searching starts from the first page", async () => {
  const item = { inviteId: personId, userId: personId, displayName: "First applicant", handle: "first", message: "Robotics", state: "pending", revision: 1 };
  const cursor = { inviteId: personId, userId: personId };
  requests = { items: [item], next: cursor };
  const view = render(<MemoryRouter><ModerationSection /></MemoryRouter>);
  fireEvent.click(await view.findByRole("tab", { name: "Joining requests" }));
  await view.findByText("First applicant (@first)");
  requests = { items: [{ ...item, userId: "22222222-2222-4222-8222-222222222222", displayName: "Second applicant" }], next: null };
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await view.findByText("Second applicant (@first)");
  expect(view.queryByText("First applicant (@first)")).toBeNull();
  expect(reviews).toHaveBeenLastCalledWith(cursor, undefined);
  const { default: userEvent } = await import("@testing-library/user-event");
  await userEvent.setup({ document }).type(view.getByLabelText("Search joining requests"), "robotics");
  fireEvent.submit(view.getByLabelText("Search joining requests").closest("form")!);
  await waitFor(() => expect(reviews).toHaveBeenLastCalledWith(undefined, "robotics"));
  await view.findByText("Page 1 · 1 pending shown");
  expect(view.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
  expect(view.getByRole("region", { name: "Pending joining requests" }).className).toContain("overflow-y-auto");
});

test("partial name lookup selects an exact identity without applying moderation", async () => {
  const view = render(<ModerationPersonControls enabled />);
  const { default: userEvent } = await import("@testing-library/user-event");
  await userEvent.setup({ document }).type(view.getByLabelText("Search members"), "fixture");
  fireEvent.submit(view.getByLabelText("Search members").closest("form")!);
  fireEvent.click(await view.findByRole("button", { name: "Select Fixture member (@fixture_member)" }));
  await view.findByText("Ban from Server");
  expect(searchPeople).toHaveBeenCalledWith("fixture", undefined);
  expect(apply).not.toHaveBeenCalled();
});


test("bulk selection survives searches and a lost response retries only that member's original command", async () => {
  const { ModerationMembers } = await import("../../src/pages/admin/sections/moderation-members");
  const second = { userId: "22222222-2222-4222-8222-222222222222", displayName: "Second member", handle: "second" };
  const view = render(<ModerationMembers enabled canBan canKick />);
  const { default: userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Search members"), "fixture");
  fireEvent.submit(view.getByLabelText("Search members").closest("form")!);
  fireEvent.click(await view.findByRole("button", { name: "Select Fixture member (@fixture_member)" }));
  searchPeople.mockImplementationOnce(async () => ({ items: [second], next: null }));
  await user.clear(view.getByLabelText("Search members")); await user.type(view.getByLabelText("Search members"), "second");
  fireEvent.submit(view.getByLabelText("Search members").closest("form")!);
  fireEvent.click(await view.findByRole("button", { name: "Select Second member (@second)" }));
  expect(within(view.getByLabelText("Selected members")).getByText("Fixture member")).toBeTruthy();
  fireEvent.click(view.getByText("Ban selected (2)"));
  await user.type(view.getByLabelText("Reason (required)"), "Repeated abuse");
  const saved = apply.getMockImplementation()!;
  apply.mockImplementationOnce(async input => saved(input));
  apply.mockImplementationOnce(async () => { throw new Error("Lost response"); });
  fireEvent.submit(view.getByLabelText("Reason (required)").closest("form")!);
  await view.findByText("Result unconfirmed. Retry resolves the same operation safely.");
  expect(within(view.getByLabelText("Selected members")).queryByText("Fixture member")).toBeNull();
  expect(within(view.getByLabelText("Selected members")).getByText("Second member")).toBeTruthy();
  expect(searchPeople).toHaveBeenLastCalledWith("second", undefined, true);
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls[0][0].deleteCommunityMessages).toBe(true);
  const uncertain = apply.mock.calls[1][0];
  fireEvent.click(view.getByText("Retry unresolved members"));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
  expect(apply.mock.calls[2][0]).toEqual(uncertain);
  await waitFor(() => expect(view.getByText("Done").hasAttribute("disabled")).toBe(false));
  expect(view.queryByRole("button", { name: "Select Second member (@second)" })).toBeNull();
  expect(within(view.getByLabelText("Selected members")).queryByText("Second member")).toBeNull();
  expect(view.getByText("Second member (@second)")).toBeTruthy();
});

test("message dropdown resolves current target authority before showing actions", async () => {
  const { MessageModerationControl } = await import("../../src/components/message-actions/MessageModerationControl");
  const view = render(<MessageModerationControl userId={personId} displayName="Fixture member" />);
  fireEvent.click(view.getByRole("button", { name: "Moderation for Fixture member" }));
  await view.findByRole("menuitem", { name: "Ban from Server…" });
  expect(inspect).toHaveBeenCalledWith({ userId: personId });
  expect(apply).not.toHaveBeenCalled();
});

test("chat confirmation survives source deletion and closes after the confirmed ban", async () => {
  const { ToastProvider } = await import("../../src/components/toast");
  const { MessageModerationControl, MessageModerationProvider } = await import("../../src/components/message-actions/MessageModerationControl");
  const view = render(<ToastProvider><MessageModerationProvider><MessageModerationControl userId={personId} displayName="Fixture member" /></MessageModerationProvider></ToastProvider>);
  fireEvent.click(view.getByRole("button", { name: "Moderation for Fixture member" }));
  fireEvent.click(await view.findByRole("menuitem", { name: "Ban from Server…" }));
  await view.findByRole("dialog", { name: "Ban from Server" });
  await view.findByLabelText("Reason");
  view.rerender(<ToastProvider><MessageModerationProvider>{null}</MessageModerationProvider></ToastProvider>);
  expect(view.getByRole("dialog", { name: "Ban from Server" })).toBeTruthy();
  expect(view.getByLabelText("Reason")).toBeTruthy();
  const { default: userEvent } = await import("@testing-library/user-event");
  await userEvent.setup({ document }).type(view.getByLabelText("Reason"), "Fixture ban");
  fireEvent.submit(view.getByLabelText("Reason").closest("form")!);
  await waitFor(() => expect(view.queryByRole("dialog", { name: "Ban from Server" })).toBeNull());
  expect(apply).toHaveBeenCalledTimes(1);
});
