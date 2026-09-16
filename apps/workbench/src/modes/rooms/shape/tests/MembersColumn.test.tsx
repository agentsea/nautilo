/**
 * D278 P2 — MembersColumn (compact 48px column) SSR smoke.
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

const { MembersColumn } = await import("../MembersColumn");

const agent = (id: string, name: string): RoomMemberDto => ({
  actorId: id,
  kind: "agent",
  displayName: name,
  agentId: id,
  roomRole: "member",
});

describe("MembersColumn — D278 P2", () => {
  test("renders an avatar per member (under the cap) + an expand control", () => {
    const members = [agent("a1", "Nova"), agent("a2", "Maya"), agent("a3", "Alex")];
    const html = renderToStaticMarkup(
      <MembersColumn roomId="r1" members={members} onExpand={() => undefined} />,
    );
    const rings = html.match(/data-testid="member-focus-ring"/g) ?? [];
    expect(rings).toHaveLength(3);
    expect(html).toContain('data-testid="members-column-expand"');
    expect(html).not.toContain('data-testid="members-column-overflow"');
  });

  test("collapses past the cap into a +N overflow", () => {
    const members = Array.from({ length: 8 }, (_, i) => agent(`a${i}`, `Bot${i}`));
    const html = renderToStaticMarkup(
      <MembersColumn roomId="r1" members={members} onExpand={() => undefined} />,
    );
    const rings = html.match(/data-testid="member-focus-ring"/g) ?? [];
    expect(rings).toHaveLength(6); // MAX_VISIBLE_COMPACT
    expect(html).toContain('data-testid="members-column-overflow"');
    expect(html).toContain("+2");
  });
});
