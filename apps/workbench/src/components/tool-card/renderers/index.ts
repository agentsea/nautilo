import { parseWriterCreatedArtifactReceipt, writerCreationRenderer } from "./writer-creation";
/**
 * Per-tool renderer registry.
 *
 * Tools without an entry here fall through to the generic
 * JSON fallback in `tool-card.tsx`. Per-tool specializations
 * are opt-in; shipping a new tool doesn't require a renderer.
 *
 * The legacy `read_file` / `write_file` / `list_directory`
 * tools were removed; their per-command rendering lives in
 * `file-read.tsx` / `file-write.tsx` / `file-list.tsx` and is
 * consumed by `file-renderer.tsx` for the unified `file` tool's
 * `read` / `write` / `list` commands. No top-level entries exist
 * for those legacy tool names any more.
 */

import { securityScanRenderer } from "./security-scan";
import type { ToolRenderer } from "./types";
import { runShellRenderer } from "./run-shell";
import { execCommandRenderer, getWriteStdinRenderer } from "./exec-command";
import { searchRenderer } from "./search";
import { deleteRenderer } from "./delete";
import { fileRenderer } from "./file-renderer";
import { applyPatchRenderer } from "./apply-patch";
import { generateImageRenderer } from "./generate-image";
import { generatedMediaRenderer } from "./generated-media";
import { videoGenerationRenderer } from "./prepare-video";
import { auditionVoicesRenderer } from "./audition-voices";
import { manageAvatarRenderer } from "./manage-avatar";
import { explainerVideoRenderer } from "./explainer-video";
import { explainerPlaybackRenderer } from "./explainer-playback";
import { structuredSshRenderer } from "./structured-ssh";
import { browserReadPageRenderer } from "./browser-read-page";
import { readWebpageRenderer, webSearchRenderer } from "./read-webpage";
import { guideUserRenderer } from "./guide-user";
import { computerUseRenderer } from "./computer-use";
import { connectedWebAccountReadRenderer, publicBrowserReadRenderer, websiteTaskRenderer } from "./connected-web-account-read";
import { connectedWebAccountActionRenderer } from "./connected-web-account-action";
import {
  connectedAppResultRenderer,
  connectedAppTransferRenderer,
  isConnectedAppPresentationEnvelope,
} from "./connected-app-result";
import { airtableResultRenderer } from "./airtable-result";
import {
  officeCliRenderer,
  parseOfficeCliCreatedArtifactReceipt,
} from "./officecli";
import { appCreateRenderer, isAppCreatePresentationEnvelope } from "./app-create";

const toolRenderers: Record<string, ToolRenderer> = {
  security_scan: securityScanRenderer,
  run_shell: runShellRenderer,
  // External harnesses use the protocol-neutral activity name while retaining
  // the same command/result shape and rich terminal presentation.
  run_command: runShellRenderer,
  exec_command: execCommandRenderer,
  structured_ssh_exec: structuredSshRenderer,
  structured_ssh_copy_upload: structuredSshRenderer,
  structured_ssh_copy_download: structuredSshRenderer,

  // The unified `file` tool routes internally by `args.command`
  // and inspects the result envelope for staged-patch shape.
  file: fileRenderer,

  // First-party, top-level multi-file patch result projection.
  apply_patch: applyPatchRenderer,

  // Search-shaped (memory search; `file({command:"grep"})` routes
  // through the unified file renderer's command map).
  search_memory: searchRenderer,
  grep: searchRenderer,

  // Delete-shaped (legacy alias still used by some session replay
  // paths; the unified `file` tool routes deletes via fileRenderer).
  delete_file: deleteRenderer,

  // Media / generation
  generate_image: generateImageRenderer,
  generate_video: videoGenerationRenderer,
  generate_music: generatedMediaRenderer,
  manage_avatar: manageAvatarRenderer,

  // Voice audition slate + lock-in
  audition_voices: auditionVoicesRenderer,

  // Local, metadata-only explainer search results.
  find_explainer: explainerVideoRenderer,

  // Consent-gated explainer playback with a server-resolved source.
  play_explainer: explainerPlaybackRenderer,

  // Whole rendered-page understanding in the visible Browser.
  browser_read_page: browserReadPageRenderer,
  read_webpage: readWebpageRenderer,
  run_web_search: webSearchRenderer,
  browse_web: publicBrowserReadRenderer,
  run_website_task: websiteTaskRenderer,
  read_connected_web_account: connectedWebAccountReadRenderer,
  act_connected_web_account: connectedWebAccountActionRenderer,

  // File transfers stay expanded while the exact connected-app
  // operation is moving bytes, then settle into the sealed receipt renderer.
  dropbox_upload_file: connectedAppTransferRenderer,
  dropbox_download_file: connectedAppTransferRenderer,

  // Durable semantic application guidance. It is Human-clicked only.
  guide_user: guideUserRenderer,

};

export function getToolRenderer(
  toolName: string,
  resultText?: string,
  args: Record<string, unknown> = {},
): ToolRenderer | undefined {
  if (toolName === "write_stdin") return getWriteStdinRenderer(args);
  return toolRenderers[toolName]
    ?? (toolName === "app_nautilo_writer__create_file" && parseWriterCreatedArtifactReceipt(resultText)
      ? writerCreationRenderer : undefined)
    // Only successful headless creates opt into the auto-expanded document
    // handoff. Help, validation, view, and failure results keep the compact
    // generic card rather than expanding potentially large OfficeCLI output.
    ?? (toolName === "officecli" && parseOfficeCliCreatedArtifactReceipt(
      args,
      resultText,
    ) ? officeCliRenderer : undefined)
    ?? (toolName.startsWith("computer_") ? computerUseRenderer : undefined)
    ?? (toolName.startsWith("airtable_") ? airtableResultRenderer : undefined)
    ?? (isAppCreatePresentationEnvelope(toolName, resultText) ? appCreateRenderer : undefined)
    ?? (isConnectedAppPresentationEnvelope(toolName, resultText) ? connectedAppResultRenderer : undefined);
}

export type { ToolRenderer, ToolRendererProps } from "./types";
