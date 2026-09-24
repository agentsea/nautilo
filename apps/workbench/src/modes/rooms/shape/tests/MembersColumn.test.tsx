/**
 * Compact members column SSR smoke.
 *
 * Renders to static markup (no effects), so the focus hook's network call
 * never fires; we assert the compact shell: avatars, +N overflow, expand.
 */
import { describe, test, expect, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomMemberDto } from "@nautilo/types";

mock.module("../../../../lib/api", () => ({
  apiClient: { getRoomFocus: async () => ({ foci: [] }) },
}));
mock.module("../../../../components/toast", () => ({
  useToast: () => ({ show: () => undefined, dismiss: () => undefined, _current: null }),
}));
mock.module("../use-room-presence", () => ({
  useRoomPresence: () => new Map([["u1", "online"]]),
}));
mock.module("../use-room-focus", () => ({
  useRoomFocus: () => ({
    isTarget: () => false,
    isHeld: () => false,
    isExpiringSoon: () => false,
    isBusy: () => false,
    remainingFraction: () => null,
    secondsLeft: () => null,
    reasonFor: () => null,
    toggle: () => undefined,
  }),
}));

const { MembersColumn } = await import("../MembersColumn");

const agent = (id: string, name: string): RoomMemberDto => ({
  actorId: id,
  kind: "agent",
  displayName: name,
  agentId: id,
  roomRole: "member",
});
const human = (id: string, name: string): RoomMemberDto => ({
  actorId: id,
  kind: "user",
  displayName: name,
  userId: id,
  roomRole: "member",
});

describe("MembersColumn", () => {
  test("renders an avatar per member (under the cap) + an expand control", () => {
    const members = [agent("a1", "Nova"), agent("a2", "Maya"), agent("a3", "Alex")];
    const html = renderToStaticMarkup(
      <MembersColumn roomId="r1" viewerActorId="u1" members={members} onExpand={() => undefined} />,
    );
    const rings = html.match(/data-testid="member-focus-ring"/g) ?? [];
    expect(rings).toHaveLength(3);
    expect(html).toContain('data-testid="members-column-expand"');
    expect(html).not.toContain('data-testid="members-column-overflow"');
  });

  test("collapses past the cap into a +N overflow", () => {
    const members = Array.from({ length: 8 }, (_, i) => agent(`a${i}`, `Bot${i}`));
    const html = renderToStaticMarkup(
      <MembersColumn roomId="r1" viewerActorId="u1" members={members} onExpand={() => undefined} />,
    );
    const rings = html.match(/data-testid="member-focus-ring"/g) ?? [];
    expect(rings).toHaveLength(6); // MAX_VISIBLE_COMPACT
    expect(html).toContain('data-testid="members-column-overflow"');
    expect(html).toContain("+2");
  });

  test("shows an accessible status on a Human avatar without changing Agent avatars", () => {
    const html = renderToStaticMarkup(
      <MembersColumn
        roomId="r1"
        viewerActorId="u1"
        members={[human("u1", "Avery"), agent("a1", "Nova")]}
        onExpand={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Avery: Online"');
    expect(html).toContain('data-status="online"');
    expect(html.match(/data-testid="human-presence"/g)).toHaveLength(1);
  });
});
