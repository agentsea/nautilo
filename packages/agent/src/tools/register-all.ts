/**
 * Register all built-in tools in the catalog. One register call per tool.
 * This is the ONLY place tools are defined.
 *
 * Replaces: ALL_TOOL_FACTORIES, BUILTIN_TOOL_METADATA, register-builtin-tools.ts
 */

import type { ToolCatalog, ToolRegistration } from "@nautilo/catalog";
import { fromRuntimeConfig } from "@nautilo/config";
import { officeCliAvailable } from "@nautilo/config/officecli";
import { createSearchMemoryTool } from "./memory/search-memory";
import { createRecallRecordsTool } from "./memory/recall-records";
import { createSessionSearchTool } from "./memory/session-search";
import { createManageMemoryTool } from "./memory/manage-memory";
import { createListMyUsersTool } from "./memory/list-my-users";
import { createGetRoomMembersTool } from "./memory/get-room-members";
import { createReactTool } from "./social/react";
import { createShareMemoryTool } from "./memory/share-memory";
import { createShareArtifactTool } from "./file/share-artifact";
import { createReadArtifactEventsTool } from "./file/read-artifact-events";
import { createCreateScopeTool } from "./memory/create-scope";
import { createFindScopeTool } from "./memory/find-scope";
import { createAddMemoryToScopeTool } from "./memory/add-memory-to-scope";
import { createCloseScopeTool } from "./memory/close-scope";
import { createTaskTool } from "./tasks/task-tool";
import { createInScopeTool } from "./tasks/shortcuts/in-scope";
import { createInPrivateNamespaceTool } from "./tasks/shortcuts/in-private-namespace";
import { createAskPeerTool } from "./tasks/shortcuts/ask-peer";
import { createInBackgroundTool } from "./tasks/shortcuts/in-background";
import { createScheduleTool } from "./tasks/shortcuts/schedule";
import { createGenerateRepoDocsTool } from "./tasks/shortcuts/generate-repo-docs";
import { createRunWebSearchTool } from "./utilities/web-search";
import { createReadWebpageTool } from "./utilities/read-webpage";
import { createFileTool } from "./file/file-tool";
import { createRunShellTool } from "./shell/run-shell";
import {
  createStructuredSshAuthTool,
  createStructuredSshCopyDownloadTool,
  createStructuredSshCopyUploadTool,
  createStructuredSshExecTool,
  createStructuredSshOutputTool,
} from "./structured-ssh/structured-ssh";
import { createTerminalTool } from "./terminal/terminal";
import { createComputerHostContractTool } from "./computer/computer-host-contract";
import { activeComputerUseHostToolDefinitions, computerUseHostToolDefinition } from "../config/computer-use-catalogue/host-tool-admission";
import { withComputerUseContractSelection } from "../config/computer-use-catalogue/selection";
import { createBrowserSnapshotTool } from "./browser/browser-snapshot";
import { createBrowserClickTool } from "./browser/browser-click";
import { createBrowserTypeTool } from "./browser/browser-type";
import { createBrowserPressTool } from "./browser/browser-press";
import { createBrowserReadTool } from "./browser/browser-read";
import { createBrowserReadPageTool } from "./browser/browser-read-page";
import { createBrowserScreenshotTool } from "./browser/browser-screenshot";
import { createBrowserMouseTool } from "./browser/browser-mouse";
import { createBrowserGetTool } from "./browser/browser-get";
import { createBrowserScrollTool } from "./browser/browser-scroll";
import { createBrowserBackTool } from "./browser/browser-back";
import { createBrowserOpenTool } from "./browser/browser-open";
import {
  createBrowserDoubleClickTool,
  createBrowserDragTool,
  createBrowserForwardTool,
  createBrowserHoverTool,
  createBrowserReloadTool,
  createBrowserScrollIntoViewTool,
  createBrowserSelectTool,
  createBrowserSetCheckedTool,
  createBrowserWaitTool,
} from "./browser/browser-native-actions";
import { createGoogleWorkspaceTool } from "./google-workspace/google-workspace";
import { createHueLightsTool } from "./device/hue-lights";
import { createCheckConfigTool } from "./config/check-config";
import { createUpdateConfigTool } from "./config/update-config";
import { createManageProfileTool } from "./config/manage-profile";
import { createManageAvatarTool } from "./config/manage-avatar";
import { createOnboardingStatusTool } from "./config/onboarding-status";
import { createLaunchCustomizationTool } from "./config/launch-customization";
import { createGuideUserTool } from "./config/guide-user";
import { createFindVoiceTool } from "./config/find-voice";
import { createAuditionVoicesTool } from "./config/audition-voices";
import { createManageVoicesTool } from "./config/manage-voices";
import { createRegenerateSoulTool } from "./config/regenerate-soul";
import { createVerifyIdentityTool } from "./trust/verify-identity";
import { createRunDeepResearchTool } from "./research/run-deep-research";
import { createSecurityScanTool } from "./security/security-scan";
import { createDiscoverToolsTool } from "./meta/discover-tools";
import { createEvaluateDecisionsTool, decisionToolUnavailable } from "./meta/evaluate-decisions";
import { listResolvedCatalogModels } from "../config/resolved-catalog";
import { createDiscoverModelsTool } from "./meta/discover-models";
import { createActivateToolsTool } from "./meta/activate-tools";
import { createDeactivateToolsTool } from "./meta/deactivate-tools";
import { createSkillManageTool } from "./skills/skill-manage";
import { createViewSkillTool } from "./skills/view-skill";
import { createDiscoverSkillsTool } from "./skills/discover-skills";
import { createEjectSkillTool } from "./skills/eject-skill";
import { createCommandManageTool } from "./commands/command-manage";
import { createViewCommandTool } from "./commands/view-command";
import { createDiscoverCommandsTool } from "./commands/discover-commands";
import { createEjectCommandTool } from "./commands/eject-command";
import { createExecuteArtifactTool } from "./execute-artifact/execute-artifact";
import { createOfficeTool, createEditDocTool } from "./office/office";
import { createOfficeCliTool } from "./office/officecli";
import { createTranscribeAudioTool } from "./audio/transcribe-audio";
import { createConvertTool } from "./convert/convert-tool";
import { createGenerateImageTool } from "./media/generate-image";
import { createGenerateVideoTool } from "./media/generate-video";
import { createGenerateMusicTool } from "./media/generate-music";
import { hasMediaGenerationApprovalRuntime } from "./media/media-generation-approval-runtime";
import { getActiveModelCatalogSync } from "../config/model-catalog/runtime-catalog";
import { VENICE_MEDIA_MODELS } from "../media-generation/contracts";
import { createFindExplainerTool } from "./media/find-explainer";
import { createPlayExplainerTool } from "./media/play-explainer";
import { createIngestLocalMediaTool } from "./media/ingest-local-media";
import { createExtractAudioFromVideoTool } from "./media/extract-audio-from-video";
import {
  createDeleteConnectionTool,
  createListConnectionsTool,
  createUseConnectionTool,
  createUseCredentialAliasTool,
} from "./connections/connections";
import { createSkipTool } from "./skip";
import { createGetCurrentTimeTool } from "./time/get-current-time";
import { createMiniAppTool } from "./apps/mini-app";
import { createBrowseWebTool, publicBrowserUseAvailable } from "./connected-web-accounts/browse-web";
import { createRunWebsiteTaskTool } from "./connected-web-accounts/run-website-task";
import { createConnectedWebAccountReadTool, type ConnectedWebAccountReadToolContext } from "./connected-web-accounts/read-connected-web-account";
import { createConnectedWebAccountActionTool } from "./connected-web-accounts/act-connected-web-account";
import { createManageConnectedWebOperationTool, type ManageConnectedWebOperationToolContext } from "./connected-web-accounts/manage-connected-web-operation";
import { createControlConnectedWebOperationTool } from "./connected-web-accounts/control-connected-web-operation";
import { createManageLocalMcpTool } from "./mcp/manage-local-mcp";
import { createApplyPatchTool } from "./apply-patch/apply-patch-tool";
import { createSelectCurrentFolderTool } from "./current-folder/select-current-folder";

const COMPUTER_USE_CATALOGUE_SOURCE_SERVER = "computer-use-contract-catalogue";

function activeComputerUseHostToolRegistrations(): readonly ToolRegistration[] {
  return activeComputerUseHostToolDefinitions().map((definition) => ({
    name: definition.name,
    factory: (ctx) => createComputerHostContractTool(definition.name, ctx),
    unavailableInContext: () => computerUseHostToolDefinition(definition.name) === null
      ? "The connected Computer Use Host does not support an available signed contract for this tool."
      : null,
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: definition.impact,
    exposure: "core",
    tags: [...definition.tags],
    requiresApproval: false,
    requiredCapabilities: ["control_desktop"],
    relayCapabilities: ["canUseComputer"],
    resultScanPolicy: "on-suspicious",
    sourceServer: COMPUTER_USE_CATALOGUE_SOURCE_SERVER,
  }));
}

/** Atomically rebuild the generic model-tool surface from the active signed snapshot. */
export function reconcileComputerUseHostTools(catalog: ToolCatalog): void {
  withComputerUseContractSelection(undefined, () => catalog.replaceServerContribution(
    COMPUTER_USE_CATALOGUE_SOURCE_SERVER,
    activeComputerUseHostToolRegistrations(),
  ));
}

function isOfficeToolingEnabled(): boolean {
  return fromRuntimeConfig().nautilo_office_enabled;
}

/** options for tool registration (test seams). */
export interface RegisterAllToolsOptions {
  /**
   * Availability probe for the OfficeCLI binary. Defaults to the real
   * `officeCliAvailable` (cheap existence + exec-bit check). Injected in
   * unit tests to assert the `officecli` tool is registered only when a usable
   * binary exists on the host.
   */
  officeCliAvailable?: () => boolean;
  publicBrowserUseAvailable?: () => boolean;
  decisionModelsAvailable?: () => boolean;
  /**
   * Combined credential/runtime/catalog readiness seam for paid Venice media.
   * Production defaults fail closed unless the approval runtime is installed
   * and the active signed catalog contains an enabled matching generation row.
   */
  mediaGenerationAvailable?: (kind: "video" | "music") => boolean;
}

function activeCatalogHasMediaKind(kind: "video" | "music"): boolean {
  const supported: ReadonlySet<string> = kind === "video"
    ? new Set([
        `venice:${VENICE_MEDIA_MODELS.seedance}`,
        `venice:${VENICE_MEDIA_MODELS.seedanceReference}`,
        `venice:${VENICE_MEDIA_MODELS.minimaxH3}`,
      ])
    : new Set([`venice:${VENICE_MEDIA_MODELS.sonilo}`, `venice:${VENICE_MEDIA_MODELS.minimaxMusic}`]);
  return getActiveModelCatalogSync().catalog.entries.some((entry) =>
    entry.provider === "venice" && entry.defaultEnabled &&
    "workload" in entry && entry.workload === "generation" &&
    "generation" in entry && entry.generation?.family === kind &&
    supported.has(entry.id),
  );
}

export function registerAllTools(
  catalog: ToolCatalog,
  options: RegisterAllToolsOptions = {},
): void {
  const isOfficeCliAvailable = options.officeCliAvailable ?? officeCliAvailable;
  const mediaGenerationAvailable = options.mediaGenerationAvailable ?? ((kind: "video" | "music") =>
    hasMediaGenerationApprovalRuntime() && Boolean(process.env["VENICE_API_KEY"]?.trim()) && activeCatalogHasMediaKind(kind));
  // the factory itself accepts only a narrow port + trusted
  // context through the opaque catalog context. Registration deliberately
  // does not choose targets, relays, or filesystem authority.
  catalog.register({
    name: "apply_patch",
    factory: (ctx) => createApplyPatchTool(ctx),
    category: "files",
    trustTier: "admin",
    impact: "destructive",
    exposure: "core",
    requiredCapabilities: ["use_project_content"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    tags: ["file", "patch", "multifile", "edit"],
    resultScanPolicy: "always",
  });
  // --- Memory tools ---
  catalog.register({
    name: "search_memory",
    factory: (ctx) => createSearchMemoryTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "read-only",
    fullEncryptionSupport: "supported",
    exposure: "core",
    requiredCapabilities: ["read_memories"],
    tags: ["search", "recall", "memory"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "recall_records",
    factory: (ctx) => createRecallRecordsTool(ctx),
    category: "knowledge",
    trustTier: "guest",
    impact: "read-only",
    fullEncryptionSupport: "supported",
    exposure: "core",
    // Record authority comes from the complete invocation Room audience, not
    // the requester's broader read_memories capability. Agent-side topology
    // and invocation-bound port gates still hide this tool fail-closed.
    tags: ["search", "recall", "records", "evidence", "room"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "session_search",
    factory: (ctx) => createSessionSearchTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["search", "recall", "sessions", "history"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "manage_memory",
    factory: (ctx) => createManageMemoryTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "low",
    fullEncryptionSupport: "supported",
    exposure: "core",
    requiredCapabilities: ["manage_memories"],
    tags: ["save", "update", "delete", "memory"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "list_my_users",
    factory: (ctx) => createListMyUsersTool(ctx),
    category: "communication",
    discoveryCategories: ["knowledge"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["users", "people", "person", "directory", "household", "contact", "peer"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "get_room_members",
    factory: (ctx) => createGetRoomMembersTool(ctx),
    category: "communication",
    discoveryCategories: ["knowledge"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["users", "people", "person", "agents", "room", "roster", "contact", "peer"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "react",
    factory: (ctx) => createReactTool(ctx),
    category: "communication",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["react", "emoji", "ack", "social"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "share_memory",
    factory: (ctx) => createShareMemoryTool(ctx),
    category: "knowledge",
    discoveryCategories: ["communication"],
    trustTier: "high",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["manage_memories"],
    approvalMode: "hybrid",
    tags: ["share", "memory", "namespace", "attach", "person", "room", "access", "project"],
    resultScanPolicy: "never",
  });

  // share an existing workspace artifact with a known user.
  // Mirrors share_memory: moves an artifact row's namespace_id (no
  // bytes move); requires roster validation + hybrid sensitivity gate.
  catalog.register({
    name: "share_artifact",
    factory: (ctx) => createShareArtifactTool(ctx),
    category: "documents",
    discoveryCategories: ["communication", "files"],
    trustTier: "high",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["use_share_artifact"],
    approvalMode: "hybrid",
    tags: ["share", "artifact", "document", "namespace", "workspace", "collaborate", "feedback"],
    resultScanPolicy: "never",
  });

  // b — drain nwState.emit channel-3 queue for a workspace artifact.
  catalog.register({
    name: "read_artifact_events",
    factory: (ctx) => createReadArtifactEventsTool(ctx),
    category: "files",
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["artifact", "events", "workspace"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "create_scope",
    factory: (ctx) => createCreateScopeTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["scope", "memory", "bookmark"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "find_scope",
    factory: (ctx) => createFindScopeTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["scope", "memory", "lookup"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "add_memory_to_scope",
    factory: (ctx) => createAddMemoryToScopeTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["scope", "memory", "attach"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "close_scope",
    factory: (ctx) => createCloseScopeTool(ctx),
    category: "knowledge",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["scope", "memory", "close"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "task",
    factory: (ctx) => createTaskTool(ctx),
    category: "automation",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["task", "background", "schedule", "async", "delegate", "harness", "codex", "coding-agent"],
    resultScanPolicy: "never",
  });

  // intent shortcuts (thin `createTask` wrappers on
  // engine). `in_private_namespace` is the only one carrying the high-impact
  // gate ( removed the legacy `do_in_private_namespace` it used to mirror).
  catalog.register({
    name: "in_scope",
    factory: (ctx) => createInScopeTool(ctx),
    category: "automation",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["task", "subagent", "scope", "background", "async"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "in_background",
    factory: (ctx) => createInBackgroundTool(ctx),
    category: "automation",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["task", "background", "async"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "schedule",
    factory: (ctx) => createScheduleTool(ctx),
    category: "automation",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["task", "schedule", "reminder", "cron", "async"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "in_private_namespace",
    factory: (ctx) => createInPrivateNamespaceTool(ctx),
    category: "automation",
    trustTier: "standard",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["invoke_agents"],
    tags: ["task", "subagent", "namespace", "private", "high-risk", "async"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "ask_peer",
    factory: (ctx) => createAskPeerTool(ctx),
    category: "communication",
    discoveryCategories: ["automation", "documents"],
    trustTier: "standard",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["invoke_agents"],
    conditionalCapabilities: ["use_share_artifact"],
    approvalMode: "hybrid",
    tags: ["task", "subagent", "dm", "peer", "person", "contact", "message", "feedback", "document", "high-risk", "async"],
    resultScanPolicy: "never",
  });

  // (Stack-128) — `generate_repo_docs` entry tool. Thin
  // `repo_docs` task creator; a separate executor consumes the task.
  // Mints an async subagent that writes to a repo (potentially pushing or
  // opening a PR), so project execution retains its explicit approval gate.
  catalog.register({
    name: "generate_repo_docs",
    factory: (ctx) => createGenerateRepoDocsTool(ctx),
    category: "development",
    discoveryCategories: ["automation", "documents"],
    trustTier: "high",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["use_project_execution"],
    requiresApproval: true,
    approvalLevel: "confirm",
    tags: ["task", "subagent", "docs", "repo", "high-risk", "async"],
    resultScanPolicy: "never",
  });

  // --- Web tools ---
  catalog.register({
    name: "run_web_search",
    factory: (ctx) => createRunWebSearchTool(ctx),
    category: "research",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["search", "internet", "web"],
    resultScanPolicy: "on-suspicious",
  });

  catalog.register({
    name: "read_webpage",
    factory: (ctx) => createReadWebpageTool(ctx),
    category: "research",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["fetch", "url", "web", "read"],
    resultScanPolicy: "on-suspicious",
  });

  // --- Filesystem tools ---
  // `read_file`, `write_file`, `list_directory` were removed.
  // The unified `file` tool below covers all their use cases via its
  // 10 commands × 3 zones discriminated-union schema.
  //
  // --- the current implementation unified `file` tool ---
  // One tool, 10 commands dispatched via discriminated-union schema
  // on the `command` arg. Canonical surface for workspace + current
  // folder + legacy home/scratch zones (the current implementation §4.4).
  //
  // `impact: "destructive"` at the tool-level is a conservative
  // default for the approval dock's tier routing; the per-command
  // policy table in @nautilo/trust/file-tool-policies.ts is the
  // authoritative source — read commands (list/read/grep/stat) end
  // up approved via the per-command path even though the tool-level
  // impact is destructive. See G4 commit 11 for the dock's composite-
  // verb display that routes via command.
  //
  // No explicit executor field — uses the catalog default (cloud).
  // Handlers execute node:fs ops directly in the server process.
  // Migration to executor:"relay" (when the current relay work wires
  // filesystem dispatch end-to-end) is a mechanical rewire — the
  // schema + dispatcher shapes stay put.
  catalog.register({
    name: "file",
    factory: (ctx) => createFileTool(ctx),
    category: "files",
    trustTier: "high",
    impact: "destructive",
    exposure: "discoverable",
    tags: ["file", "read", "write", "edit", "unified", "artifact", "html", "interactive", "workspace", "mini-app"],
    requiredCapabilities: ["use_project_content"],
    resultScanPolicy: "never",
  });

  // dedicated document conversion (local md→pdf/docx; optional CloudConvert).
  catalog.register({
    name: "convert",
    factory: (ctx) => createConvertTool(ctx),
    category: "documents",
    discoveryCategories: ["files"],
    trustTier: "high",
    impact: "high",
    exposure: "discoverable",
    tags: ["convert", "document", "pdf", "docx", "format", "workspace", "delivered"],
    requiredCapabilities: ["use_project_content"],
    // Network egress retains exact approval. Local routes (Markdown -> PDF/DOCX
    // landing as the user's own artifact) auto-approve in checkToolAccess
    // (`isLocalConvertCall`) and never hit the approval dock.
    requiresApproval: true,
    approvalLevel: "confirm",
    resultScanPolicy: "never",
  });

  // --- Shell ---
  // Runs locally via child_process. Relay dispatch comes from dj-electron-v1.
  catalog.register({
    name: "run_shell",
    factory: () => createRunShellTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "destructive",
    exposure: "discoverable",
    tags: ["shell", "command", "exec", "terminal"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["use_workstation"],
    relayCapabilities: ["canRunShell"],
    resultScanPolicy: "on-suspicious",
  });

  // Electron resolves the remote target, login user, and identity
  // locally. These model-facing schemas therefore accept no SSH authority.
  // The dedicated relay capability is intentionally distinct from run_shell:
  // SSH is never admitted through a generic shell fallback. Invocation-service
  // performs the one meaningful exact review after Electron resolves user,
  // port, and host trust.
  catalog.register({
    name: "structured_ssh_auth",
    factory: () => createStructuredSshAuthTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "high",
    exposure: "discoverable",
    tags: ["ssh", "remote-server", "devops", "structured", "auth"],
    requiresApproval: false,
    requiredCapabilities: ["use_remote_hosts"],
    relayCapabilities: ["canUseStructuredSsh"],
    resultScanPolicy: "on-suspicious",
  });

  catalog.register({
    name: "structured_ssh_exec",
    factory: () => createStructuredSshExecTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "high",
    exposure: "discoverable",
    tags: ["ssh", "remote-server", "devops", "structured", "exec"],
    requiresApproval: false,
    requiredCapabilities: ["use_remote_hosts"],
    relayCapabilities: ["canUseStructuredSsh"],
    resultScanPolicy: "on-suspicious",
  });

  catalog.register({
    name: "structured_ssh_output",
    factory: () => createStructuredSshOutputTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["ssh", "remote-server", "devops", "structured", "output", "continuation"],
    requiresApproval: false,
    requiredCapabilities: ["use_remote_hosts"],
    relayCapabilities: ["canReadStructuredSshOutput"],
    resultScanPolicy: "on-suspicious",
  });

  for (const [name, factory, tag] of [
    ["structured_ssh_copy_upload", createStructuredSshCopyUploadTool, "upload"],
    ["structured_ssh_copy_download", createStructuredSshCopyDownloadTool, "download"],
  ] as const) {
    catalog.register({
      name,
      factory,
      category: "development",
      executor: "relay",
      trustTier: "admin",
      impact: "high",
      exposure: "discoverable",
      tags: ["ssh", "remote-server", "devops", "structured", "copy", tag],
      requiresApproval: false,
      requiredCapabilities: ["use_remote_hosts"],
      relayCapabilities: ["canUseStructuredSsh", "canUseStructuredSshCopy"],
      resultScanPolicy: "on-suspicious",
    });
  }

  // Electron owns target resolution and the canonical Current Folder
  // transition. The catalog factory supplies model schema only; invocation
  // dispatches the narrow prepare/commit protocol through the exact desktop.
  catalog.register({
    name: "select_current_folder",
    factory: () => createSelectCurrentFolderTool(),
    category: "files",
    discoveryCategories: ["computer"],
    executor: "relay",
    trustTier: "standard",
    impact: "high",
    exposure: "discoverable",
    tags: ["filesystem", "folder", "current-folder", "desktop"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    // Actor authorization remains the desktop-control capability. The local
    // Electron relay only needs its runtime shell/session capability; these
    // are deliberately separate catalog dimensions.
    requiredCapabilities: ["control_desktop"],
    relayCapabilities: ["canRunShell"],
    resultScanPolicy: "on-suspicious",
  });

  // --- Terminal ( / ) ---
  // Interactive shared PTY. Distinct from run_shell (one-shot, prove_it):
  // per operator decision the terminal uses "basic normal gating,
  // NOT a PIN". The trust resolver is binary for relay tools (destructive |
  // requiresApproval → prove_it, else allow), so "no PIN" == capability-gated
  // allow: impact "high" (not "destructive") + requiresApproval:false →
  // `allow` for actors holding `use_workstation`. Runtime relay availability
  // remains a separate `canUseTerminal` requirement.
  catalog.register({
    name: "terminal",
    factory: () => createTerminalTool(),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "high",
    exposure: "discoverable",
    tags: ["shell", "terminal", "pty", "interactive"],
    requiresApproval: false,
    requiredCapabilities: ["use_workstation"],
    relayCapabilities: ["canUseTerminal"],
    resultScanPolicy: "on-suspicious",
  });

  // --- Computer Use ---
  // The semantic Computer Use catalog is the sole desktop-control surface.
  // Runtime emits canUseComputer only for the exact Agent named by a live
  // redacted desktop-automation receipt; retired desktop_* registrations are
  // absent and cannot be revived by a missing or stale receipt.
  //
  // `control_desktop` is still the actor's RBAC requirement. The separate
  // relay capability is what binds this catalog to the live local receipt.
  // The browser Host contracts are catalogue-projected Agent tools. Their
  // descriptor and validated JSON are attached at invocation time; Relay and
  // Desktop never branch on these names.
  reconcileComputerUseHostTools(catalog);

  catalog.register({
    name: "browser_snapshot",
    factory: (ctx) => createBrowserSnapshotTool(ctx),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "accessibility"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_click",
    factory: () => createBrowserClickTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "click"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_type",
    factory: () => createBrowserTypeTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "type"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_press",
    factory: () => createBrowserPressTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "keyboard"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_read",
    factory: () => createBrowserReadTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "read"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_read_page",
    factory: () => createBrowserReadPageTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "read", "page", "summary"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_screenshot",
    factory: () => createBrowserScreenshotTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "vision", "screenshot"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    requiredModelCapabilities: ["image"],
    resultScanPolicy: "on-suspicious",
  });

  catalog.register({
    name: "browser_mouse",
    factory: () => createBrowserMouseTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "mouse", "coordinates"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
  });

  catalog.register({
    name: "browser_get",
    factory: () => createBrowserGetTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "read", "inspect"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_scroll",
    factory: () => createBrowserScrollTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "scroll"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_back",
    factory: () => createBrowserBackTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "navigation", "back"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_open",
    factory: () => createBrowserOpenTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "navigation", "url", "open"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_forward",
    factory: () => createBrowserForwardTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "navigation", "forward"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_reload",
    factory: () => createBrowserReloadTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "navigation", "reload"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_hover",
    factory: () => createBrowserHoverTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "mouse", "hover"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_double_click",
    factory: () => createBrowserDoubleClickTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "mouse", "double-click"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_drag",
    factory: () => createBrowserDragTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "mouse", "drag", "drop"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_select",
    factory: () => createBrowserSelectTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "form", "select"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_set_checked",
    factory: () => createBrowserSetCheckedTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "form", "checkbox"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_scroll_into_view",
    factory: () => createBrowserScrollIntoViewTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "scroll", "element"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "browser_wait",
    factory: () => createBrowserWaitTool(),
    category: "computer",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["browser", "embedded", "saas", "automation", "ui", "wait", "dynamic"],
    requiresApproval: false,
    requiredCapabilities: ["control_browser"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  catalog.register({
    name: "google_workspace",
    factory: () => createGoogleWorkspaceTool(),
    category: "integrations",
    discoveryCategories: ["documents", "communication"],
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["google", "workspace", "docs", "drive", "gmail", "email", "mail", "calendar", "api", "gog"],
    requiresApproval: false,
    requiredCapabilities: ["use_google_workspace"],
    resultScanPolicy: "on-suspicious",
    scanInvisibleUnicode: "strip",
  });

  // structured Hue requests are dispatched only to a capable local
  // relay. The server owns this contract; relay-side OpenHue execution is
  // deliberately not reachable through a shell or generic network tool.
  catalog.register({
    name: "hue_lights",
    factory: () => createHueLightsTool(),
    category: "devices",
    executor: "relay",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["hue", "lights", "smart-home", "home", "bridge", "scene"],
    requiresApproval: false,
    requiredCapabilities: ["control_home"],
    resultScanPolicy: "on-suspicious",
  });

  if (isOfficeToolingEnabled()) {
    // LibreOffice office tool (server-side; nwuno engine). Convert/extract/
    // render + mutate (find-replace/template-fill/set-cell/…) on artifact-zone docs.
    // Low impact, no per-call approval; gated by use_project_content (same as file).
    catalog.register({
      name: "office",
      factory: (ctx) => createOfficeTool(ctx),
      category: "documents",
      executor: "cloud",
      trustTier: "standard",
      impact: "low",
      exposure: "discoverable",
      tags: ["libreoffice", "office", "docx", "xlsx", "pptx", "convert", "template", "document", "proposal", "suggest", "suggestion", "review", "track-changes", "writer", "edit", "proofread", "proofreading"],
      guidance: "For reviewable proposals and edits, use office track_changes, then office review_changes. Direct Writer edits are not reviewable.",
      discovery: { preferredReviewWorkflow: true },
      requiresApproval: false,
      requiredCapabilities: ["use_project_content"],
      resultScanPolicy: "on-suspicious",
    });

    // intent-level document editing. The durable, protocol-free
    // write path for workspace docs: one intent (append/replace_exact/…) →
    // one verified edit → updated content returned. Hides coolwsd/WOPI/session
    // entirely from the model (no zone/inPlace knobs). Same trust profile as
    // `office`.
    catalog.register({
      name: "edit_doc",
      factory: (ctx) => createEditDocTool(ctx),
      category: "documents",
      executor: "cloud",
      trustTier: "standard",
      impact: "low",
      exposure: "discoverable",
      tags: ["libreoffice", "office", "docx", "edit", "document", "writer"],
      requiresApproval: false,
      requiredCapabilities: ["use_project_content"],
      resultScanPolicy: "on-suspicious",
    });

  }

  // OfficeCLI is a bundled headless binary for generating closed
  // .docx/.xlsx/.pptx artifacts. It is intentionally NOT gated on
  // `nautilo_office_enabled` (the LibreOffice/coolwsd live-editor flag):
  // headless generation must remain available even when the interactive
  // office engine is disabled.
  //
  // gate registration on a usable OfficeCLI binary (same pattern as
  // import-docx / export-docx in app-tool-registration.ts). On a host with no
  // vendored binary and no OFFICECLI_PATH override, the tool is simply not
  // offered rather than registered as an always-failing tool.
  if (isOfficeCliAvailable()) {
    catalog.register({
      name: "officecli",
      factory: (ctx) => createOfficeCliTool(ctx),
      category: "documents",
      executor: "cloud",
      trustTier: "standard",
      impact: "low",
      exposure: "discoverable",
      tags: ["officecli", "office", "docx", "xlsx", "pptx", "deck", "slides", "presentation", "spreadsheet", "document", "generate", "headless", "render", "chart", "pivot", "image"],
      requiresApproval: false,
      requiredCapabilities: ["use_project_content"],
      resultScanPolicy: "on-suspicious",
    });
  }

  // --- Config / onboarding ---
  catalog.register({
    name: "update_config",
    factory: () => createUpdateConfigTool(),
    category: "administration",
    discoveryCategories: ["settings"],
    trustTier: "admin",
    // flipped from "high" to "destructive" to match the
    // deprecated trust/tool-policies.ts canon. prove_it still fires via
    // requiresApproval+approvalLevel (unchanged). The flip is a no-op
    // for today's runtime; it aligns with the current verb map so the later
    // wiring can replace the requiresApproval gate cleanly later.
    impact: "destructive",
    exposure: "discoverable",
    tags: ["config", "settings", "secrets"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["manage_server_settings"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "check_config",
    factory: () => createCheckConfigTool(),
    category: "administration",
    discoveryCategories: ["settings"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    requiredCapabilities: ["read_server_settings"],
    tags: ["config", "status"],
    resultScanPolicy: "never",
  });

  // --- Connections / vault (the current implementation) ---
  catalog.register({
    name: "use_connection",
    factory: (ctx) => createUseConnectionTool(ctx),
    category: "integrations",
    trustTier: "high",
    impact: "high",
    exposure: "discoverable",
    tags: ["connection", "vault", "secret", "use"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["use_connections"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "list_connections",
    factory: (ctx) => createListConnectionsTool(ctx),
    category: "integrations",
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["connection", "vault", "list"],
    requiredCapabilities: ["use_connections"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "use_credential",
    factory: (ctx) => createUseCredentialAliasTool(ctx),
    category: "integrations",
    trustTier: "high",
    impact: "high",
    exposure: "discoverable",
    tags: ["connection", "vault", "legacy-alias"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["use_connections"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "delete_connection",
    factory: (ctx) => createDeleteConnectionTool(ctx),
    category: "integrations",
    trustTier: "admin",
    impact: "destructive",
    exposure: "discoverable",
    tags: ["connection", "vault", "secret", "delete"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["use_connections"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "manage_profile",
    factory: (ctx) => createManageProfileTool(ctx),
    category: "settings",
    trustTier: "high",
    impact: "low",
    exposure: "discoverable",
    tags: ["profile", "personality", "name"],
    resultScanPolicy: "never",
  });

  // the Agent generates + sets her own profile avatar (preview
  // → apply gate). Same tier as manage_profile (config / high / low).
  catalog.register({
    name: "manage_avatar",
    factory: (ctx) => createManageAvatarTool(ctx),
    category: "settings",
    trustTier: "high",
    impact: "low",
    exposure: "discoverable",
    tags: ["profile", "avatar", "icon", "image"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "onboarding_status",
    factory: (ctx) => createOnboardingStatusTool(ctx),
    category: "settings",
    discoveryCategories: ["help"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["onboarding", "setup", "status"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "launch_customization",
    factory: (ctx) => createLaunchCustomizationTool(ctx),
    category: "settings",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["onboarding", "customization", "wizard", "profile"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "guide_user",
    factory: (ctx) => createGuideUserTool(ctx),
    category: "help",
    discoveryCategories: ["settings"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["help", "settings", "config", "navigation", "guidance"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "find_voice",
    factory: () => createFindVoiceTool(),
    category: "media",
    discoveryCategories: ["settings"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["voice", "tts", "speech", "discovery"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "audition_voices",
    factory: () => createAuditionVoicesTool(),
    category: "media",
    discoveryCategories: ["settings"],
    trustTier: "standard",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["voice", "tts", "speech", "audition"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "manage_voices",
    factory: (ctx) => createManageVoicesTool(ctx),
    category: "settings",
    discoveryCategories: ["media"],
    trustTier: "high",
    impact: "low",
    exposure: "discoverable",
    tags: ["profile", "voice", "tts"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "transcribe_audio",
    factory: (ctx) => createTranscribeAudioTool(ctx),
    category: "media",
    trustTier: "standard",
    // Local bytes → hosted STT egress; keep the high-impact cap and
    // require an explicit approval instead of standard-tier auto.
    impact: "high",
    exposure: "discoverable",
    tags: ["audio", "transcription", "stt", "voice"],
    requiresApproval: true,
    approvalLevel: "confirm",
    requiredCapabilities: ["use_transcription"],
    resultScanPolicy: "on-suspicious",
  });

  // an explicitly approved, relay-backed MP4 copy into the
  // workspace artifact store. The tool never transcribes or extracts audio.
  catalog.register({
    name: "ingest_local_media",
    factory: (ctx) => createIngestLocalMediaTool(ctx),
    category: "media",
    trustTier: "standard",
    impact: "high",
    exposure: "discoverable",
    tags: ["media", "mp4", "ingest", "relay", "workspace", "artifact"],
    requiresApproval: true,
    approvalLevel: "confirm",
    requiredCapabilities: ["use_transcription"],
    resultScanPolicy: "never",
  });

  // fixed-schema, explicitly approved MP4 → extraction through
  // the desktop relay. This is deliberately separate from generic convert and
  // from transcription (which is never invoked here).
  catalog.register({
    name: "extract_audio_from_video",
    factory: (ctx) => createExtractAudioFromVideoTool(ctx),
    category: "media",
    trustTier: "standard",
    impact: "high",
    exposure: "discoverable",
    tags: ["media", "mp4", "audio", "m4a", "ffmpeg", "relay", "workspace"],
    requiresApproval: true,
    approvalLevel: "confirm",
    requiredCapabilities: ["use_transcription"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "generate_image",
    factory: (ctx) => createGenerateImageTool(ctx),
    category: "media",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["image", "generate", "media"],
    requiredCapabilities: ["use_image_generation"],
    resultScanPolicy: "never",
  });

  // paid generation is present only when a server-owned exact-quote /
  // durable-submit runtime and a compatible signed catalog row are available.
  // The post-model path forces an exact Once/Deny approval and replaces model
  // args with a checkpoint-private prepared binding before InvocationService.
  catalog.register({
    isAvailable: () => mediaGenerationAvailable("video"),
    name: "generate_video",
    factory: () => createGenerateVideoTool(),
    category: "media",
    trustTier: "standard",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["use_media_generation"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    tags: [
      "video", "generate", "seedance", "reference", "advanced", "compose",
      "image", "attachment", "focused", "workflow", "card", "media", "paid", "venice",
    ],
    resultScanPolicy: "never",
  });

  catalog.register({
    isAvailable: () => mediaGenerationAvailable("music"),
    name: "generate_music",
    factory: () => createGenerateMusicTool(),
    category: "media",
    trustTier: "standard",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["use_media_generation"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    tags: ["audio", "music", "generate", "media", "paid", "venice"],
    resultScanPolicy: "never",
  });

  // bounded, local-only metadata discovery. Playback is not
  // part of this tool and requires a later user-consented phase.
  catalog.register({
    name: "find_explainer",
    factory: () => createFindExplainerTool(),
    category: "help",
    discoveryCategories: ["media"],
    trustTier: "guest",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["help", "walkthrough", "explainer", "discovery"],
    resultScanPolicy: "never",
  });

  // resolves only user-accepted, verified bunny-storage
  // MP4 explainers. It returns the catalog id + display metadata only (NO CDN
  // URL); the Workbench fetches verified bytes through the authenticated
  // server route (`GET /api/explainers:id/media`) and plays a revocable Blob
  // URL. Mechanical confirmation gate: explicit user consent is required
  // before playback is resolved, preserving the consented-playback contract.
  catalog.register({
    name: "play_explainer",
    factory: () => createPlayExplainerTool(),
    category: "help",
    discoveryCategories: ["media"],
    trustTier: "guest",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["help", "walkthrough", "explainer", "playback", "media"],
    requiresApproval: true,
    approvalLevel: "confirm",
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "regenerate_soul",
    factory: (ctx) => createRegenerateSoulTool(ctx),
    category: "settings",
    trustTier: "high",
    // flipped from "high" to "destructive" to match the
    // deprecated trust/tool-policies.ts canon. requiresApproval +
    // approvalLevel: "confirm" unchanged — confirm-style prompt still
    // fires the same way. No-op at runtime; preparatory for
    // ( will also decide whether to migrate "confirm" into
    // "ask" under the new verb taxonomy — tracked in issue.)
    impact: "destructive",
    exposure: "discoverable",
    tags: ["soul", "personality", "identity"],
    requiresApproval: true,
    approvalLevel: "confirm",
    requiredCapabilities: ["manage_agents"],
    resultScanPolicy: "never",
  });

  // --- Trust / auth ---
  // trustTier MUST be "guest" — this is how a restricted speaker verifies
  // their current Human identity. Verification never changes their role.
  // If this is set to anything higher, nobody can prove their identity.
  catalog.register({
    name: "verify_identity",
    // factory is context-free. The PIN subject is the
    // user driving the current turn (envelope.ownerId) and is resolved
    // inside the tool per-invocation. Pre- this read the
    // bootstrap-state-cache global, which meant any non-operator user's
    // prove_it borrowed the operator's PIN.
    factory: (ctx) => createVerifyIdentityTool(ctx),
    category: "identity",
    trustTier: "guest",
    impact: "high",
    exposure: "core",
    tags: ["identity", "pin", "verify", "auth"],
    resultScanPolicy: "never",
  });

  // --- Channel / reply policy + one-hop redirect (the current implementation) ---
  // `skip` is the sole model-facing yield tool. With no `target_handle` it
  // is ordinary silence ; with `target_handle` it records the existing
  // immutable one-hop redirect request and suppresses source output. The
  // eager core exposure keeps it available on every eligible turn; the
  // explicit-picker withhold (`withholdSkipForExplicitSelection`) still
  // forces a picked agent to answer. Low impact reflects the target-bearing
  // form's eventual visible peer turn + focus transfer, matching the removed
  // redirect tool's prior classification. The server remains authoritative
  // for canonical target resolution, enqueue, focus transfer, and one-hop
  // depth revalidation.
  catalog.register({
    name: "skip",
    factory: (ctx) => createSkipTool(ctx),
    category: "meta",
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    tags: ["skip", "silence", "reply", "channel", "redirect", "handoff", "agent", "room", "roster"],
    resultScanPolicy: "never",
  });

  // --- Time ---
  catalog.register({
    name: "get_current_time",
    factory: (ctx) => createGetCurrentTimeTool(ctx),
    category: "help",
    trustTier: "standard",
    impact: "low",
    fullEncryptionSupport: "supported",
    exposure: "discoverable",
    tags: ["time", "clock", "timezone"],
    resultScanPolicy: "never",
  });

  // --- Meta ---
  catalog.register({
    name: "discover_tools",
    // Forward the runtime context (relayCapabilities + memoryAccessEnvelope +
    // actorRole). Without it, discover_tools filters the catalog with
    // `undefined` relay capabilities, so getFiltered excludes EVERY
    // relay-executor tool ("requires relay but no relay connected") — the
    // agent could still call relay tools present in its already-built toolset,
    // but could never SEE them via
    // discovery, so it reported them as unavailable.
    factory: (ctx) => createDiscoverToolsTool(ctx),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["discovery", "help", "tools", "capabilities"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "activate_tools",
    factory: (ctx) => createActivateToolsTool(ctx),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["activation", "discovery", "tools", "capabilities"],
    resultScanPolicy: "never",
  });

  // / Task 2.2.1 — bounded, read-only window onto the resolved
  // model catalog. Genie can search/list/get curated models by
  // name/provider/capability without the full list sitting in the system
  // prompt. `get` accepts only exact curated ids (dynamic openrouter:/gateway:
  // ids are rejected). No new RBAC capability: discovery grants no provider or
  // Task execution authority.
  //
  // decision #4: the full `discover_models` projection is
  // standard-tier/authenticated — it returns the richer non-secret resolved
  // projection (incl. runnable/unavailable reasons) to Genie, and guests
  // cannot query it. The compatibility-oriented, non-secret guest picker
  // projection lives on the separate HTTP route `GET /api/config/models`
  // (packages/server/src/routes/config.ts), which is intentionally left
  // guest-readable. `trustTier: "standard"` is the declarative label for that
  // boundary; the runtime guest withhold is enforced by the guest toolPolicy
  // (trust/personal-policy-resolver.ts GUEST_ALLOWED_TOOLS), which does not
  // include `discover_models`.
  catalog.register({
    name: "evaluate_decisions",
    factory: (ctx) => createEvaluateDecisionsTool(ctx),
    category: "meta",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags: ["classification", "scoring", "decisions", "models"],
    isAvailable: options.decisionModelsAvailable ?? (() => listResolvedCatalogModels().some((row) => row.workload === "decision" && row.availability === "selectable")),
    unavailableReason: "Configure a supported decision provider key and enable a decision model.",
    unavailableInContext: (ctx) => decisionToolUnavailable(ctx),
    resultScanPolicy: "always",
  });

  catalog.register({
    name: "discover_models",
    factory: (ctx) => createDiscoverModelsTool(ctx),
    category: "meta",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    tags: ["discovery", "models", "capabilities"],
    resultScanPolicy: "never",
  });

  catalog.register({
    name: "deactivate_tools",
    factory: (ctx) => createDeactivateToolsTool(ctx),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["activation", "deactivation", "tools", "capabilities"],
    resultScanPolicy: "never",
  });

  // speaker-scoped skill authoring (manage_agents two-gate in body).
  catalog.register({
    name: "skill_manage",
    factory: (ctx) => createSkillManageTool(ctx),
    category: "extensions",
    trustTier: "high",
    impact: "low",
    exposure: "discoverable",
    tags: ["skills", "instructions", "authoring"],
    resultScanPolicy: "never",
  });

  // mid-turn fallback to read one enabled skill body .
  catalog.register({
    name: "view_skill",
    factory: (ctx) => createViewSkillTool(ctx),
    category: "extensions",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["skills", "instructions", "read"],
    resultScanPolicy: "never",
  });

  // / §2.1 — search the speaker's enabled skills (catalog-primary
  // v1). Read-only, guest-tier; paginates with explicit truncation .
  catalog.register({
    name: "discover_skills",
    factory: (ctx) => createDiscoverSkillsTool(ctx),
    category: "extensions",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["skills", "discovery", "search"],
    resultScanPolicy: "never",
  });

  // / §2.1 — drop a skill body pulled by view_skill from the
  // engaged-set so the next pre-model rebuild omits it. No external side
  // effects (mutates thread-scoped graph state only); guest-tier, ungated.
  catalog.register({
    name: "eject",
    factory: (ctx) => createEjectSkillTool(ctx),
    category: "extensions",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["skills", "eject", "context"],
    resultScanPolicy: "never",
  });

  // The `command_*` family mirrors `skill_*` one-to-one,
  // minus `requiresTools` (commands carry no tool-gating). Genies can
  // create commands (operator decision: no create-gating, no approval
  // step). Same `manage_agents` two-gate as skill_manage.
  catalog.register({
    name: "command_manage",
    factory: (ctx) => createCommandManageTool(ctx),
    category: "extensions",
    trustTier: "high",
    impact: "low",
    exposure: "discoverable",
    tags: ["commands", "prompt", "authoring"],
    resultScanPolicy: "never",
  });

  // Mid-turn fallback to read one command body (DB row
  // or bundled official fallback). Read-only, guest-tier.
  catalog.register({
    name: "view_command",
    factory: (ctx) => createViewCommandTool(ctx),
    category: "extensions",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["commands", "prompt", "read"],
    resultScanPolicy: "never",
  });

  // Search the speaker's command catalog (official +
  // DB merged, DB shadows official by name). Read-only, guest-tier;
  // paginates with explicit truncation .
  catalog.register({
    name: "discover_commands",
    factory: (ctx) => createDiscoverCommandsTool(ctx),
    category: "extensions",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["commands", "discovery", "search"],
    resultScanPolicy: "never",
  });

  // Structural mirror of `eject` (skills). Commands
  // are not per-turn engaged, so this is a no-op confirmation; guest-tier,
  // ungated. Named `eject_command` (NOT bare `eject`) to avoid colliding
  // with the skills `eject` tool.
  catalog.register({
    name: "eject_command",
    factory: (ctx) => createEjectCommandTool(ctx),
    category: "extensions",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    tags: ["commands", "eject", "context"],
    resultScanPolicy: "never",
  });

  // --- Sandbox-script execution ---
  // + Sprint 2 G5 — execute_artifact. Runs a script
  // artifact (home/ or scratch/) inside the sandbox with runtime
  // allowlist + prove_it approval gate. Server-local (not a relay
  // tool) — the handler builds a Sandbox in-process from server
  // posture; see execute-artifact.ts for rationale.
  catalog.register({
    name: "execute_artifact",
    factory: () => createExecuteArtifactTool(),
    category: "development",
    discoveryCategories: ["files"],
    trustTier: "admin",
    impact: "destructive",
    exposure: "discoverable",
    tags: ["artifact", "execute", "run", "script", "sandbox"],
    requiresApproval: true,
    approvalLevel: "prove_it",
    requiredCapabilities: ["use_project_execution"],
    // Script stdout/stderr goes back to the model. If a prompt-
    // injected script echoes "ignore previous instructions" into
    // stdout, we scan before re-injecting into context.
    resultScanPolicy: "on-suspicious",
  });

  // installed mini-app source authoring (server DI via setMiniAppToolRuntime).
  catalog.register({
    name: "mini_app",
    factory: (ctx) => createMiniAppTool(ctx),
    category: "extensions",
    trustTier: "high",
    impact: "destructive",
    exposure: "discoverable",
    requiredCapabilities: ["manage_server_operations"],
    tags: ["mini-app", "apps", "authoring"],
    resultScanPolicy: "always",
  });

  catalog.register({
    name: "browse_web",
    factory: (ctx) => createBrowseWebTool(ctx as ConnectedWebAccountReadToolContext | undefined),
    category: "integrations",
    discoveryCategories: ["research"],
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    isAvailable: options.publicBrowserUseAvailable ?? publicBrowserUseAvailable,
    tags: ["research", "browser", "website", "public", "interactive"],
    resultScanPolicy: "always",
  });

  catalog.register({
    name: "run_website_task",
    factory: (ctx) => createRunWebsiteTaskTool(ctx as ConnectedWebAccountReadToolContext | undefined),
    category: "integrations",
    discoveryCategories: ["integrations", "research"],
    trustTier: "high",
    impact: "high",
    exposure: "core",
    requiredCapabilities: ["use_connections"],
    requiresApproval: false,
    isAvailable: options.publicBrowserUseAvailable ?? publicBrowserUseAvailable,
    tags: ["connections", "website", "browser", "task", "actions"],
    resultScanPolicy: "always",
  });

  // one Human-owned authenticated website-account read. The injected
  // server runtime re-checks exact Human + owned-Genie admission before it
  // can reach a profile; this entry only carries the existing Connections cap.
  catalog.register({
    name: "read_connected_web_account",
    factory: (ctx) => createConnectedWebAccountReadTool(ctx as ConnectedWebAccountReadToolContext | undefined),
    category: "integrations",
    discoveryCategories: ["research"],
    trustTier: "standard",
    impact: "low",
    exposure: "core",
    requiredCapabilities: ["use_connections"],
    tags: ["connections", "website", "account", "read", "private"],
    resultScanPolicy: "on-suspicious",
  });

  catalog.register({
    name: "act_connected_web_account",
    factory: (ctx) => createConnectedWebAccountActionTool(ctx as ConnectedWebAccountReadToolContext | undefined),
    category: "integrations",
    discoveryCategories: ["integrations"],
    trustTier: "high",
    impact: "high",
    exposure: "discoverable",
    requiredCapabilities: ["use_connections"],
    tags: ["connections", "website", "account", "save", "private"],
    requiresApproval: false,
    resultScanPolicy: "always",
  });

  // supervision of one already-admitted connected-website operation.
  // The injected server runtime owns authority, provider state, and every
  // durable transition; this catalog entry exposes no browser coordinates.
  catalog.register({
    name: "manage_connected_web_operation",
    factory: (ctx) => createManageConnectedWebOperationTool(ctx as ManageConnectedWebOperationToolContext | undefined),
    category: "integrations",
    discoveryCategories: ["integrations"],
    trustTier: "high",
    // This supervises an operation the Human already admitted: inspect,
    // schedule a check, steer, take/release direct control, or stop. None of
    // those verbs admits a new website effect, so an approval prompt here is
    // both redundant and actively prevents the Genie from supervising work.
    impact: "low",
    // Supervision must already be callable when a core connected-account read
    // returns an active operation. Requiring mid-run activation strands the
    // Genie outside the operation it just started.
    exposure: "core",
    requiresApproval: false,
    tags: ["connections", "website", "account", "operation", "control", "private"],
    resultScanPolicy: "always",
  });

  catalog.register({
    name: "control_connected_web_operation",
    factory: (ctx) => createControlConnectedWebOperationTool(ctx as ManageConnectedWebOperationToolContext | undefined),
    category: "integrations",
    discoveryCategories: ["integrations"],
    trustTier: "high",
    // Direct control preserves the admitted read/task scope and saved origin.
    // A task's ordinary steps do not require another approval.
    impact: "low",
    // Same lifecycle rule as management: once an admitted read exists, the
    // Genie must be able to inspect and drive it in the same turn.
    exposure: "core",
    requiresApproval: false,
    requiredCapabilities: ["use_connections"],
    tags: ["connections", "website", "account", "operation", "direct-control", "private"],
    resultScanPolicy: "always",
  });

  // `manage_local_mcp`: a Genie sets up a LOCAL (relay-tier)
  // MCP on the requesting user's own machine. Verified-user tool (NO
  // requiredCapabilities, not admin); hard-scoped to the caller's own
  // relay (server-tier mutations refused in the injected runtime). Only
  // the `enable` verb is approval-gated — see the narrow branches in
  // trust/personal-policy-resolver.ts (checkToolAccess) + nodes/post-model.ts
  // (resolveApprovalForToolCall). It is agent self-modification (adds to
  // the agent's own toolset), so audited on every mutation.
  catalog.register({
    name: "manage_local_mcp",
    factory: (ctx) => createManageLocalMcpTool(ctx),
    category: "extensions",
    discoveryCategories: ["integrations"],
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    requiresApproval: false,
    tags: ["mcp", "local", "relay", "connections", "self-modification"],
    resultScanPolicy: "never",
  });

  // --- Research ---
  catalog.register({
    name: "run_deep_research",
    unavailableInContext: (ctx) => ctx?.["deepResearchForegroundAvailable"] === true
      ? null
      : "Deep research cannot start from this turn. Wait until this Room's current reply finishes, then send a new request. No research was started.",
    isAvailable: () => Boolean(process.env["TAVILY_API_KEY"]?.trim()),
    unavailableReason: "Deep research is unavailable because Tavily is not configured on this server. Configure the Tavily API key, then start a fresh deep research request. No research was started.",
    factory: () => createRunDeepResearchTool(),
    category: "research",
    trustTier: "high",
    impact: "high",
    exposure: "discoverable",
    tags: ["research", "deep", "analysis", "web"],
    requiresApproval: true,
    approvalLevel: "confirm",
    requiredCapabilities: ["use_research_tools"],
    resultScanPolicy: "never",
  });

  // one Desktop-local family for scanner observations and the model's
  // durable research record. The tool factory has no direct executor; the
  // invocation service attaches its private Task/TaskRun/model envelope only
  // after host and trust-policy admission.
  catalog.register({
    name: "security_scan",
    factory: () => createSecurityScanTool(),
    category: "development",
    discoveryCategories: ["research"],
    executor: "relay",
    trustTier: "high",
    impact: "read-only",
    exposure: "discoverable",
    tags: ["security", "codebase", "vulnerability", "scan", "research", "ledger"],
    requiresApproval: false,
    requiredCapabilities: ["use_project_content"],
    relayCapabilities: ["canReadWorkspace"],
    // The Desktop coordinator returns a strict, bounded envelope containing
    // probe metadata, citation digests, and notes authored by this same Task.
    // Re-scanning the serialized envelope makes ordinary security prose such
    // as "cat .env" trip the generic prompt-injection filter and hides the
    // Task's own ledger from its report pass. Secret redaction still runs when
    // scan policy is never; raw source bytes and scanner stderr never enter
    // this result contract.
    resultScanPolicy: "never",
  });

  // Every built-in registration above must declare exposure contract.
  // External sources validate after their respective ingestion defaults supply
  // an exposure, so this strict check intentionally runs at the built-in seam.
  catalog.validate({ requireExposure: true });
}
