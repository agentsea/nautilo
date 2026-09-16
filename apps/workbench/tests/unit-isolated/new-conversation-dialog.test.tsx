import "../bun-dom-preload";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { CreateRoomMemberInput, CreateRoomRequest } from "@nautilo/types";

type Candidate = {
  kind: "user" | "agent";
  id: string;
  displayName: string;
  handle?: string;
};

const candidates: Candidate[] = [
  { kind: "user", id: "u-alice", displayName: "Alice", handle: "alice" },
  { kind: "user", id: "u-bob", displayName: "Bob", handle: "bob" },
  { kind: "agent", id: "a-genie", displayName: "Genie", handle: "genie" },
];

const createRoom = mock(async (_body: CreateRoomRequest) => roomDetail());
let canInvokeAgents = true;

function roomMember(member: CreateRoomMemberInput) {
  return member.kind === "user"
    ? { actorId: `actor-${member.id}`, kind: "user" as const, userId: member.id }
    : { actorId: `actor-${member.id}`, kind: "agent" as const, agentId: member.id };
}

function roomDetail(members: CreateRoomMemberInput[] = [
  { kind: "user", id: "u-me" },
]): { id: string; members: ReturnType<typeof roomMember>[] } {
  return { id: "room-1", members: members.map(roomMember) };
}

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "u-me", label: "Me" } }),
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) =>
    capability === "create_rooms" ||
    capability === "manage_rooms" ||
    (capability === "invoke_agents" && canInvokeAgents),
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    createRoom,
    searchDirectory: mock(async () => []),
  },
}));

mock.module("../../src/modes/rooms/new-conversation/SelectablePicker", () => ({
  memberKey: (kind: string, id: string) => `${kind}:${id}`,
  toSelectableCandidate: (candidate: Candidate) => candidate,
  SelectablePicker: ({ onToggle }: { onToggle: (candidate: Candidate) => void }): ReactElement => (
    <div>
      {candidates.map((candidate) => (
        <button key={`${candidate.kind}:${candidate.id}`} type="button" onClick={() => onToggle(candidate)}>
          Pick {candidate.displayName}
        </button>
      ))}
    </div>
  ),
}));

const { NewConversationDialog } = await import(
  "../../src/modes/rooms/new-conversation/NewConversationDialog"
);

const onClose = mock(() => {});
const onCreated = mock((_roomId: string) => {});

beforeEach(() => {
  reapplyHappyDomGlobals();
  createRoom.mockClear();
  canInvokeAgents = true;
  onClose.mockClear();
  onCreated.mockClear();
  createRoom.mockImplementation(async (body) =>
    roomDetail(
      body.members ?? [
        { kind: "user", id: "u-me" },
        ...(body.directHumanUserId
          ? [{ kind: "user" as const, id: body.directHumanUserId }]
          : []),
      ],
    ),
  );
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Text",
    "customElements",
    "MutationObserver",
    "getComputedStyle",
    "localStorage",
    "sessionStorage",
    "location",
    "__NAUTILO_HAPPY_DOM_WINDOW__",
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

function renderDialog() {
  return render(<NewConversationDialog onClose={onClose} onCreated={onCreated} />);
}

async function submit(view: ReturnType<typeof render>, name: string): Promise<void> {
  fireEvent.click(view.getByRole("button", { name }));
  await waitFor(() => expect(createRoom).toHaveBeenCalledTimes(1));
}

describe("NewConversationDialog roster creation", () => {
  test("creates a public Room with only its creator while private still requires a selection", async () => {
    const view = renderDialog();
    const privateCreate = view.getByRole("button", { name: "Pick someone" });
    expect((privateCreate as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByLabelText("Public — anyone on this server can find and join"));
    const publicCreate = view.getByRole("button", { name: "Create public room" });
    expect((publicCreate as HTMLButtonElement).disabled).toBe(false);
    await submit(view, "Create public room");

    expect(createRoom).toHaveBeenCalledWith({
      label: "Me",
      members: [{ kind: "user", id: "u-me" }],
      kind: "open",
    });
    expect(onCreated).toHaveBeenCalledWith("room-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("ignores Agent selection without invoke_agents and opens the Human DM path", async () => {
    canInvokeAgents = false;
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));
    fireEvent.click(view.getByRole("button", { name: "Pick Genie" }));

    await submit(view, "Open DM");

    expect(createRoom).toHaveBeenCalledWith({
      label: "Alice",
      directHumanUserId: "u-alice",
    });
  });

  test("sends one exact private roster for two humans and an agent, with the creator once", async () => {
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));
    fireEvent.click(view.getByRole("button", { name: "Pick Bob" }));
    fireEvent.click(view.getByRole("button", { name: "Pick Genie" }));

    await submit(view, "Create chat with 2 people + 1 agent");

    expect(createRoom).toHaveBeenCalledWith({
      label: "Alice, Bob, Me, Genie",
      members: [
        { kind: "user", id: "u-me" },
        { kind: "user", id: "u-alice" },
        { kind: "user", id: "u-bob" },
        { kind: "agent", id: "a-genie" },
      ],
    });
    expect(onCreated).toHaveBeenCalledWith("room-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("sends the same selected roster for public creation", async () => {
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));
    fireEvent.click(view.getByRole("button", { name: "Pick Genie" }));
    fireEvent.click(view.getByLabelText("Public — anyone on this server can find and join"));

    await submit(view, "Create chat with 1 person + 1 agent");

    expect(createRoom).toHaveBeenCalledWith({
      label: "Alice, Me, Genie",
      members: [
        { kind: "user", id: "u-me" },
        { kind: "user", id: "u-alice" },
        { kind: "agent", id: "a-genie" },
      ],
      kind: "open",
    });
  });

  test("accepts extra members returned by a public room after a concurrent join", async () => {
    createRoom.mockImplementation(async (body) =>
      roomDetail([...(body.members ?? []), { kind: "user", id: "u-bob" }]),
    );
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));
    fireEvent.click(
      view.getByLabelText("Public — anyone on this server can find and join"),
    );

    await submit(view, "Open DM");

    expect(onCreated).toHaveBeenCalledWith("room-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("includes a member selected immediately before Create in the submitted roster", async () => {
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));
    fireEvent.click(view.getByRole("button", { name: "Pick Bob" }));
    await submit(view, "Create group with 2 people");

    expect(createRoom.mock.calls[0]?.[0]?.members).toEqual([
      { kind: "user", id: "u-me" },
      { kind: "user", id: "u-alice" },
      { kind: "user", id: "u-bob" },
    ]);
  });

  test("suppresses a second Create click while the first request is in flight", async () => {
    let resolveCreate: ((detail: ReturnType<typeof roomDetail>) => void) | undefined;
    createRoom.mockImplementation(
      () =>
        new Promise<ReturnType<typeof roomDetail>>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));

    const createButton = view.getByRole("button", { name: "Open DM" });
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    await waitFor(() => expect(createRoom).toHaveBeenCalledTimes(1));

    resolveCreate?.(roomDetail([
      { kind: "user", id: "u-me" },
      { kind: "user", id: "u-alice" },
    ]));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("room-1"));
  });

  test("keeps the dialog open when the authoritative roster omits a requested member", async () => {
    createRoom.mockImplementation(async () => roomDetail([{ kind: "user", id: "u-me" }]));
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));

    await submit(view, "Open DM");

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("mismatched member roster");
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.getByRole("dialog")).toBeTruthy();
  });

  test("keeps the dialog open when the authoritative roster contains an extra member", async () => {
    createRoom.mockImplementation(async () =>
      roomDetail([
        { kind: "user", id: "u-me" },
        { kind: "user", id: "u-alice" },
        { kind: "user", id: "u-bob" },
      ]),
    );
    const view = renderDialog();
    fireEvent.click(view.getByRole("button", { name: "Pick Alice" }));

    await submit(view, "Open DM");

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("mismatched member roster");
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

});
