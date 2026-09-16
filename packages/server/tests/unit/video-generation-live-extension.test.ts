import { expect, test } from "bun:test";
import { videoLiveToolExtension } from "../../src/apps/video-live-tool-extension";
import { GENERATION_REVIEW_REQUESTED } from "../../../first-party-apps/video/src/generation-agent";
import { newMediaOperation, type MediaOperationsResult } from "../../../first-party-apps/video/src/media-agent";

test("generation review stays on the host-bound direct session and cannot carry paid approval", () => {
  const extension = videoLiveToolExtension;
  expect(extension.hostOwnsSessionBinding).toBe(true);
  expect(extension.taskDelegation).toEqual({ mode: "direct_only" });
  expect(extension.directMutationToolIds).toEqual([]);
  expect(extension.sessionCommands!.toolIds).toContain("review-generation");
  const command = { action: "review-generation", shotId: "next", modelId: "venice:seedance-2-5-reference-to-video-basic", settings: { durationSeconds: 4, resolution: "480p", audio: false } };
  expect(extension.sessionCommands!.parseCommand(command)).toEqual(command);
  expect(extension.sessionCommands!.parseCommand({ ...command, approve: true })).toBeNull();
  expect(extension.sessionCommands!.parseCommand({ ...command, sessionId: "another-editor" })).toBeNull();
  expect(extension.sessionCommands!.parseResult(GENERATION_REVIEW_REQUESTED)).toEqual(GENERATION_REVIEW_REQUESTED);
  expect(extension.sessionCommands!.parseResult({ ...GENERATION_REVIEW_REQUESTED, paidSubmission: true })).toBeNull();
  expect(extension.sessionCommands!.parseCommand({ action: "pause" })).toEqual({ action: "pause" });
});

test("native media uses the bound session, closed commands and observable receipts without path authority", () => {
  const commands = videoLiveToolExtension.sessionCommands!;
  expect(commands.toolIds).toContain("inspect-video-media");
  expect(commands.toolIds).toContain("manage-video-media");
  expect(commands.parseCommand({ action: "import-media" })).toEqual({ action: "import-media" });
  expect(commands.parseCommand({ action: "export-media", publishToWorkspace: false })).toEqual({ action: "export-media", publishToWorkspace: false });
  expect(commands.parseCommand({ action: "import-media", path: "/private/source.mp4" })).toBeNull();
  expect(commands.parseCommand({ action: "export-media", publishToWorkspace: false, destination: "/private/output.mp4" })).toBeNull();
  expect(commands.parseCommand({ action: "export-media", publishToWorkspace: false, sessionId: "another-editor" })).toBeNull();
  const receipt: MediaOperationsResult = { status: "media_operations", import: newMediaOperation("import"), export: null, nativeDialogsRequired: true, workspaceExportSupported: false };
  expect(commands.parseResult(receipt)).toEqual(receipt);
  expect(commands.parseResult({ ...receipt, nativeDialogsRequired: false })).toBeNull();
  expect(commands.parseResult({ ...receipt, import: { ...receipt.import, retrySafe: true } })).toBeNull();
});
