import { describe, expect, test } from "bun:test";
import { resolveComposerMessageAttachmentRoomId } from "../../src/lib/composer-message-attachment-authority";

const authenticatedViewer = {
  sessionUserId: "user-guest",
  sessionActorId: "actor-guest",
  isVerified: false,
  role: "guest" as const,
  capabilities: [] as const,
};

const ownerViewer = {
  sessionUserId: "user-owner",
  sessionActorId: "actor-owner",
  isVerified: true,
  role: "owner" as const,
  capabilities: ["write_artifacts"] as const,
};

describe("composer message attachment authority", () => {
  test("uses the exact selected room for an authenticated capabilityless viewer", () => {
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: authenticatedViewer,
      activeResolution: { kind: "selected", roomId: "room-active" },
      directHumanInteractionBlocked: false,
    })).toBe("room-active");
  });

  test("preserves the authenticated owner attachment workflow", () => {
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: ownerViewer,
      activeResolution: { kind: "selected", roomId: "room-owner" },
      directHumanInteractionBlocked: false,
    })).toBe("room-owner");
  });

  test("rejects anonymous and partially resolved viewers", () => {
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: { sessionUserId: null, sessionActorId: null },
      activeResolution: { kind: "selected", roomId: "room-active" },
      directHumanInteractionBlocked: false,
    })).toBeNull();
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: { sessionUserId: "user-guest", sessionActorId: null },
      activeResolution: { kind: "selected", roomId: "room-active" },
      directHumanInteractionBlocked: false,
    })).toBeNull();
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: { sessionUserId: null, sessionActorId: "actor-guest" },
      activeResolution: { kind: "selected", roomId: "room-active" },
      directHumanInteractionBlocked: false,
    })).toBeNull();
  });

  test("rejects unresolved, absent, and blocked direct-human destinations", () => {
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: authenticatedViewer,
      activeResolution: { kind: "missing", roomId: "room-missing" },
      directHumanInteractionBlocked: false,
    })).toBeNull();
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: authenticatedViewer,
      activeResolution: { kind: "none" },
      directHumanInteractionBlocked: false,
    })).toBeNull();
    expect(resolveComposerMessageAttachmentRoomId({
      viewer: authenticatedViewer,
      activeResolution: { kind: "selected", roomId: "room-blocked" },
      directHumanInteractionBlocked: true,
    })).toBeNull();
  });

  test("tracks selected room transitions without retaining prior authority", () => {
    const resolve = (activeResolution: Parameters<
      typeof resolveComposerMessageAttachmentRoomId
    >[0]["activeResolution"]) => resolveComposerMessageAttachmentRoomId({
      viewer: authenticatedViewer,
      activeResolution,
      directHumanInteractionBlocked: false,
    });

    expect(resolve({ kind: "selected", roomId: "room-a" })).toBe("room-a");
    expect(resolve({ kind: "selected", roomId: "room-b" })).toBe("room-b");
    expect(resolve({ kind: "none" })).toBeNull();
  });
});
