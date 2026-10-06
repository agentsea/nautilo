import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RoomMemberDto } from "@nautilo/types";

let setupState = "server-needs-keys";
let hasLlm = false;
let sessionUserId = "human-one";
let capabilities = new Set(["invoke_agents", "use_personal_provider_credentials"]);
let credentials: { requiresReplacement: boolean }[] = [{ requiresReplacement: false }];
let models: { availability: string }[] = [{ availability: "selectable" }];
let pendingCredentials: Promise<{ credentials: typeof credentials }> | null = null;

mock.module("../../../../components/conversation", () => ({
  Conversation: () => <div data-testid="conversation">Conversation</div>,
}));
mock.module("../../../../contexts/setup-status-context", () => ({
  useSetupStatus: () => ({ setupState, providers: { hasLlm } }),
}));
mock.module("../../../../hooks/use-can", () => ({
  useCan: () => (capability: string) => capabilities.has(capability),
}));
mock.module("../../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId } }),
}));
mock.module("../../../../lib/api", () => ({
  apiClient: {
    listProviderCredentials: async () => pendingCredentials ?? { credentials },
    getCallerModels: async () => models,
  },
}));
mock.module("../RoomAuthorScope", () => ({
  RoomAuthorScope: ({ children }: { children: ReactNode }) => children,
}));
mock.module("../RoomSilenceBanner", () => ({ RoomSilenceBanner: () => null }));

const { SlackShapeRoom } = await import("./SlackShapeRoom");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  setupState = "server-needs-keys";
  hasLlm = false;
  sessionUserId = "human-one";
  capabilities = new Set(["invoke_agents", "use_personal_provider_credentials"]);
  credentials = [{ requiresReplacement: false }];
  models = [{ availability: "selectable" }];
  pendingCredentials = null;
});

afterAll(cleanup);

const ownGenie = [{ kind: "agent", agentOwnerUserId: "human-one" }] as RoomMemberDto[];
const humanOnly = [{ kind: "user", userId: "human-one" }] as RoomMemberDto[];

test("personal-only member enters their Genie Room without a server chat key", async () => {
  const view = render(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  await waitFor(() => expect(view.getByTestId("conversation")).toBeTruthy());
  expect(view.queryByTestId("provider-setup-empty-state")).toBeNull();
});

test("missing personal key offers Settings rather than Server Admin", async () => {
  credentials = [];
  const view = render(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  await waitFor(() => expect(view.getByTestId("personal-provider-setup-empty-state")).toBeTruthy());
  expect(view.getByRole("link", { name: "Set up your key" }).getAttribute("href"))
    .toBe("/settings#personal-provider-keys");
  expect(view.queryByRole("link", { name: "API Keys" })).toBeNull();
});

test("ordinary server-funded member keeps the existing Room path", () => {
  setupState = "ready";
  hasLlm = true;
  capabilities = new Set(["invoke_agents", "use_server_provider_credentials"]);
  const view = render(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  expect(view.getByTestId("conversation")).toBeTruthy();
});

test("a dual-capability member repairs a stale personal key before chat", async () => {
  setupState = "ready";
  hasLlm = true;
  capabilities = new Set(["invoke_agents", "use_personal_provider_credentials", "use_server_provider_credentials"]);
  credentials = [{ requiresReplacement: true }];
  const view = render(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  await waitFor(() => expect(view.getByTestId("personal-provider-setup-empty-state")).toBeTruthy());
  expect(view.queryByTestId("conversation")).toBeNull();
  expect(view.getByRole("link", { name: "Set up your key" }).getAttribute("href"))
    .toBe("/settings#personal-provider-keys");
});

test("a Human-only Room remains usable without any model", () => {
  credentials = [];
  const view = render(<SlackShapeRoom roomId="room-one" members={humanOnly} />);
  expect(view.getByTestId("conversation")).toBeTruthy();
});

test("focus rechecks keep the mounted chat until a changed access result arrives", async () => {
  const view = render(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  await waitFor(() => expect(view.getByTestId("conversation")).toBeTruthy());
  const conversation = view.getByTestId("conversation");
  let finish!: (value: { credentials: typeof credentials }) => void;
  pendingCredentials = new Promise((resolve) => { finish = resolve; });

  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(view.getByTestId("conversation")).toBe(conversation);
  expect(view.queryByTestId("personal-provider-setup-empty-state")).toBeNull();

  await act(async () => { finish({ credentials: [{ requiresReplacement: true }] }); });
  await waitFor(() => expect(view.queryByTestId("conversation")).toBeNull());
  expect(view.getByRole("link", { name: "Set up your key" })).toBeTruthy();
});

test("a different Human cannot inherit the previous Human's ready state", async () => {
  const view = render(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  await waitFor(() => expect(view.getByTestId("conversation")).toBeTruthy());
  let finish!: (value: { credentials: typeof credentials }) => void;
  pendingCredentials = new Promise((resolve) => { finish = resolve; });
  sessionUserId = "human-two";
  view.rerender(<SlackShapeRoom roomId="room-one" members={ownGenie} />);
  expect(view.queryByTestId("conversation")).toBeNull();
  expect(view.getByText("Checking chat access")).toBeTruthy();
  await act(async () => { finish({ credentials: [] }); });
  await waitFor(() => expect(view.getByRole("link", { name: "Set up your key" })).toBeTruthy());
});
