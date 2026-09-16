import type { LiveDirectMutationExtension } from "./live-review-extension-registry";
import { parsePlaybackCommand, parsePlaybackResult } from "../../../first-party-apps/video/src/live-playback";
import { parseGenerationReviewCommand, parseGenerationReviewResult } from "../../../first-party-apps/video/src/generation-agent";
import { parseMediaCommand, parseMediaOperationsResult } from "../../../first-party-apps/video/src/media-agent";

export const videoLiveToolExtension: LiveDirectMutationExtension = {
  appId: "nautilo-video",
  mode: "direct_mutation",
  liveToolIds: ["control-open-video", "review-generation", "inspect-video-media", "manage-video-media"],
  directMutationToolIds: [],
  hostOwnsSessionBinding: true,
  allowSnapshotWrites: true,
  taskDelegation: { mode: "direct_only" },
  sessionCommands: {
    toolIds: ["control-open-video", "review-generation", "inspect-video-media", "manage-video-media"],
    parseCommand: input => parsePlaybackCommand(input) ?? parseGenerationReviewCommand(input) ?? parseMediaCommand(input),
    parseResult: input => parsePlaybackResult(input) ?? parseGenerationReviewResult(input) ?? parseMediaOperationsResult(input),
  },
  guidance: "Control only the active open Video editor. Inspect first. Play, pause, seek and preview-range are transient, not saved edits. A ready result confirms editor transport state, not decoded playback or audible sound. Dirty/stale/closed editors reject commands. Never retry an unknown result automatically. Clear-range restores full-sequence transport before seeking outside a selected range. Use ordinary Video timeline tools for saved document edits. For generation, inspect-generation discovers saved scenes, references and completed takes; edit-generation saves a scene or continuation with optimistic version checks. review-generation requests one scene's existing exact-price human approval in the open editor. review_requested is not a paid submission or a completed take. Results enter the Media Bin automatically; inspect again to discover the completed take before continuing another scene. organize-generation deletes/reorders saved scenes or direction blocks atomically without deleting completed takes or timeline media. inspect-video-media observes the latest native import/export receipts; manage-video-media starts the existing Desktop workflows. Native file/save dialogs require human selection. Acknowledgement, preparing, saving or cancelling is not success: inspect until a terminal result, never blindly replay. Import succeeds after Media Bin admission saves. Export succeeds after local MP4 publication; Workspace status is separate. Choose the first-source rate or cancel using the exact inspected operationId. Inspection and cancellation remain available while dirty; starting work still requires a clean saved document. Receipts are session-only: after reopen inspect saved project/Workspace results before another attempt.",
};
