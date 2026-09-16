import { describe, expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";
import { resolveAgentAuthorLabel } from "../../src/modes/rooms/shape/agent-author-label";

const viewerUserId = "viewer-user";
const roomId = "room-123";
const fallbackAvatarSrc = "/fallback-avatar";

function agent(overrides: Partial<RoomMemberDto>): RoomMemberDto {
  return {
    actorId: "actor-default",
    kind: "agent",
    displayName: "Nova",
    agentId: "agent-default",
    roomRole: "member",
    ...overrides,
  };
}

describe("resolveAgentAuthorLabel (D300)", () => {
  test("uses the agent display name without owner cue for viewer-owned unique agents", () => {
    const result = resolveAgentAuthorLabel({
      authorAgentId: "agent-viewer",
      members: [
        agent({
          actorId: "actor-viewer",
          agentId: "agent-viewer",
          agentOwnerUserId: viewerUserId,
          agentOwnerDisplayName: "Viewer",
          agentOwnerHandle: "viewer",
          agentAvatar: { kind: "generated", blobId: "viewer-avatar" },
        }),
      ],
      viewerUserId,
      fallbackName: "Genie",
      fallbackAvatarSrc,
      roomId,
    });

    expect(result).toEqual({
      name: "Nova",
      ownerCue: null,
      actorId: "actor-viewer",
      avatarSrc:
        "/api/rooms/room-123/agents/agent-viewer/avatar?v=viewer-avatar",
    });
  });

  test("shows a subtle owner cue for non-viewer-owned agents", () => {
    const result = resolveAgentAuthorLabel({
      authorAgentId: "agent-guest",
      members: [
        agent({
          actorId: "actor-guest",
          agentId: "agent-guest",
          agentOwnerUserId: "guest-user",
          agentOwnerDisplayName: "Guest",
          agentOwnerHandle: "guest",
          agentAvatar: { kind: "uploaded", blobId: "guest-avatar" },
        }),
      ],
      viewerUserId,
      fallbackName: "Genie",
      fallbackAvatarSrc,
      roomId,
    });

    expect(result).toEqual({
      name: "Nova",
      ownerCue: "Guest's agent",
      actorId: "actor-guest",
      avatarSrc:
        "/api/rooms/room-123/agents/agent-guest/avatar?v=guest-avatar",
    });
  });

  test("disambiguates duplicate agent display names", () => {
    const result = resolveAgentAuthorLabel({
      authorAgentId: "agent-viewer",
      members: [
        agent({
          actorId: "actor-viewer",
          agentId: "agent-viewer",
          agentOwnerUserId: viewerUserId,
          agentOwnerHandle: "viewer",
          agentAvatar: { kind: "preset", id: "avatar-01" },
        }),
        agent({
          actorId: "actor-guest",
          agentId: "agent-guest",
          agentOwnerUserId: "guest-user",
          agentOwnerHandle: "guest",
        }),
      ],
      viewerUserId,
      fallbackName: "Genie",
      fallbackAvatarSrc,
      roomId,
    });

    expect(result).toEqual({
      name: "Nova",
      ownerCue: "@viewer",
      actorId: "actor-viewer",
      avatarSrc: "/api/rooms/room-123/agents/agent-viewer/avatar?v=avatar-01",
    });
  });

  test("falls back to the default avatar when no author agent matches", () => {
    const result = resolveAgentAuthorLabel({
      authorAgentId: "missing",
      members: [],
      viewerUserId,
      fallbackName: "Genie",
      fallbackAvatarSrc,
      roomId,
    });

    expect(result).toEqual({
      name: "Genie",
      ownerCue: null,
      actorId: null,
      avatarSrc: fallbackAvatarSrc,
    });
  });
});
