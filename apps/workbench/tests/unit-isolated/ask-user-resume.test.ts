import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  setCurrentFolder,
  setWorkspacePath,
} from "../../src/adapters/file-context-ref";
import {
  clearAskUserResumeContext,
  readAskUserResumeContext,
  rememberAskUserResumeContext,
} from "../../src/components/composer/ask-user-resume-context";
import { clearAskUserPicker } from "../../src/components/composer/ask-user-state";

const sendRoomMessage = mock(async () => ({
  messageId: 99,
  jobId: "job-1",
  accepted: true as const,
  attachments: [],
  coalesced: false,
}));

mock.module("../../src/lib/api", () => ({
  apiClient: { sendRoomMessage },
}));

const { resumeAskUserPick } = await import("../../src/components/composer/ask-user-resume");

afterEach(() => {
  clearAskUserPicker();
  clearAskUserResumeContext();
  setCurrentFolder(null);
  setWorkspacePath(null);
  sendRoomMessage.mockClear();
});

describe("resumeAskUserPick — D279 Phase 4", () => {
  test("pick sends original content with uiSelectedBotActorId", async () => {
    const botActorId = "d900b3a1-423d-498f-87ae-292553a6744a";
    const roomId = "809996bd-5db4-44a1-875d-82eb9ff84c82";
    const content = "ok and the auth gateway?";

    const result = await resumeAskUserPick({ roomId, botActorId, content });

    expect(sendRoomMessage).toHaveBeenCalledTimes(1);
    expect(sendRoomMessage.mock.calls[0]?.[0]).toBe(roomId);
    expect(sendRoomMessage.mock.calls[0]?.[1]).toEqual({
      content,
      uiSelectedBotActorId: botActorId,
      voiceMode: false,
      autoApprove: false,
      currentFolder: null,
      currentFolderRelayId: null,
      workspacePath: null,
    });
    expect(result).toEqual({ uiSelectedBotActorId: botActorId, content });
  });

  test("D302 R13 — forwards humanTurnId as resumeTurnId (dedup the re-send)", async () => {
    const botActorId = "d900b3a1-423d-498f-87ae-292553a6744a";
    const roomId = "809996bd-5db4-44a1-875d-82eb9ff84c82";
    const content = "ok and the auth gateway?";
    const humanTurnId = "11111111-2222-3333-4444-555555555555";
    rememberAskUserResumeContext(roomId, 42, {
      content,
      laneKey: `room:${roomId}`,
      voiceMode: true,
      autoApprove: true,
      currentFolder: "/Users/Shared/LanternHouse",
      currentFolderRelayId: "relay-mara",
      workspacePath: "/Users/tester/Documents/Nautilo",
      attachments: [{ attachmentId: "attachment-1" }],
      model: "openai:gpt-5.6-sol",
      clientActionSessionId: "stale-socket-session",
    });

    await resumeAskUserPick({ roomId, botActorId, content, humanTurnId, messageId: "42" });

    expect(sendRoomMessage.mock.calls[0]?.[1]).toEqual({
      laneKey: `room:${roomId}`,
      voiceMode: true,
      autoApprove: true,
      currentFolder: "/Users/Shared/LanternHouse",
      currentFolderRelayId: "relay-mara",
      workspacePath: "/Users/tester/Documents/Nautilo",
      attachments: [{ attachmentId: "attachment-1" }],
      model: "openai:gpt-5.6-sol",
      content,
      uiSelectedBotActorId: botActorId,
      resumeTurnId: humanTurnId,
      resumeMessageId: 42,
    });
    expect(sendRoomMessage.mock.calls[0]?.[1]).not.toHaveProperty("clientActionSessionId");
  });

  test("D302 R13 — omits resumeTurnId when no humanTurnId", async () => {
    await resumeAskUserPick({
      roomId: "809996bd-5db4-44a1-875d-82eb9ff84c82",
      botActorId: "d900b3a1-423d-498f-87ae-292553a6744a",
      content: "hi",
      humanTurnId: null,
    });
    expect(sendRoomMessage.mock.calls[0]?.[1]).toMatchObject({
      voiceMode: false,
      autoApprove: false,
      currentFolder: null,
      currentFolderRelayId: null,
      workspacePath: null,
    });
    expect(sendRoomMessage.mock.calls[0]?.[1]).not.toHaveProperty("resumeTurnId");
    expect(sendRoomMessage.mock.calls[0]?.[1]).not.toHaveProperty("resumeMessageId");
  });

  test("does not leak a retained envelope into a different persisted message", async () => {
    const roomId = "809996bd-5db4-44a1-875d-82eb9ff84c82";
    rememberAskUserResumeContext(roomId, 42, {
      content: "first message",
      currentFolder: "/private/first-folder",
      currentFolderRelayId: "relay-first",
      workspacePath: "/private/first-workspace",
      autoApprove: true,
    });
    setCurrentFolder("/current/fallback-folder", "relay-current");
    setWorkspacePath("/current/fallback-workspace");

    await resumeAskUserPick({
      roomId,
      botActorId: "d900b3a1-423d-498f-87ae-292553a6744a",
      content: "second message",
      humanTurnId: "11111111-2222-3333-4444-555555555555",
      messageId: "43",
      autoApprove: false,
    });

    expect(sendRoomMessage.mock.calls[0]?.[1]).toMatchObject({
      currentFolder: "/current/fallback-folder",
      currentFolderRelayId: "relay-current",
      workspacePath: "/current/fallback-workspace",
      autoApprove: false,
      resumeMessageId: 43,
    });
  });

  test("expires retained envelopes with the ask-user picker window", () => {
    const roomId = "809996bd-5db4-44a1-875d-82eb9ff84c82";
    rememberAskUserResumeContext(roomId, 42, {
      content: "expiring message",
      currentFolder: "/private/folder",
    }, 1_000);

    expect(readAskUserResumeContext(roomId, 42, 90_999)).toEqual({
      currentFolder: "/private/folder",
    });
    expect(readAskUserResumeContext(roomId, 42, 91_001)).toBeNull();
  });

  test("canonical runtime retains the complete room envelope after send", async () => {
    const runtimeSource = await Bun.file(
      new URL("../../src/adapters/nautilo-runtime.tsx", import.meta.url),
    ).text();
    expect(runtimeSource).toContain(
      "rememberAskUserResumeContext(roomIdForSend, r.messageId, roomBody)",
    );
  });

  test("does not import approval-backend paths", async () => {
    const pickerSource = await Bun.file(
      new URL("../../src/components/composer/AskUserPicker.tsx", import.meta.url),
    ).text();
    expect(pickerSource).not.toMatch(/from\s+["'].*approval/);
    expect(pickerSource).not.toContain("ApprovalAsk");
    expect(pickerSource).not.toContain("fixed inset-0");
  });
});
